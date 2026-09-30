import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { KnowledgeSearchResult, KnowledgeSourceDetail, KnowledgeSourceSummary } from '@frontdesk/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { chunkText } from './chunker.js';
import type { CreateKnowledgeDto, UpdateKnowledgeDto } from './knowledge.dto.js';
import { KnowledgeRetriever } from './retriever.js';

const EXCERPT_LENGTH = 160;

interface SourceRow {
  id: string;
  title: string;
  category: KnowledgeSourceSummary['category'];
  content: string;
  status: KnowledgeSourceSummary['status'];
  version: number;
  updated_at: Date;
  approved_at: Date | null;
  approved_by_name: string | null;
}

function excerptOf(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LENGTH ? flat : `${flat.slice(0, EXCERPT_LENGTH).trimEnd()}…`;
}

function toSummary(row: SourceRow): KnowledgeSourceSummary {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    version: row.version,
    excerpt: excerptOf(row.content),
    updatedAt: row.updated_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
    approvedByName: row.approved_by_name,
  };
}

/**
 * The clinic's knowledge base. The rule that everything else rests on: a source
 * can only be used by the AI while it is APPROVED, and any change to its title
 * or content withdraws that approval. Chunks (the searchable pieces) exist only
 * for approved sources.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly tenant: TenantDb,
    private readonly retriever: KnowledgeRetriever,
  ) {}

  list(auth: AuthContext): Promise<KnowledgeSourceSummary[]> {
    return this.tenant.run(auth, async (trx) => {
      const rows = await this.selectSources(trx).orderBy('s.updated_at', 'desc').orderBy('s.id', 'desc').limit(500).execute();
      return rows.map(toSummary);
    });
  }

  get(auth: AuthContext, id: string): Promise<KnowledgeSourceDetail> {
    return this.tenant.run(auth, async (trx) => this.detail(await this.loadSource(trx, id)));
  }

  create(auth: AuthContext, dto: CreateKnowledgeDto, meta: RequestMeta): Promise<KnowledgeSourceDetail> {
    return this.tenant.run(auth, async (trx) => {
      const { id } = await trx
        .insertInto('knowledge_sources')
        .values({
          practice_id: auth.practiceId,
          title: dto.title,
          category: dto.category,
          content: dto.content,
          created_by: auth.userId,
          approved_by: null,
          approved_at: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await this.audit(trx, auth, meta, 'knowledge.created', id, { category: dto.category });
      return this.detail(await this.loadSource(trx, id));
    });
  }

  update(auth: AuthContext, id: string, dto: UpdateKnowledgeDto, meta: RequestMeta): Promise<KnowledgeSourceDetail> {
    const fields = (['title', 'category', 'content'] as const).filter((field) => dto[field] !== undefined);
    if (fields.length === 0) {
      throw new BadRequestException('Nothing to change');
    }
    return this.tenant.run(auth, async (trx) => {
      const current = await this.lockSource(trx, id);
      if (current.status === 'archived') {
        throw new ConflictException('An archived source cannot be edited. Restore it first.');
      }

      const wordingChanged =
        (dto.title !== undefined && dto.title !== current.title) || (dto.content !== undefined && dto.content !== current.content);
      const withdrawsApproval = wordingChanged && current.status === 'approved';

      await trx
        .updateTable('knowledge_sources')
        .set({
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.category !== undefined && { category: dto.category }),
          ...(dto.content !== undefined && { content: dto.content }),
          ...(wordingChanged && { version: current.version + 1 }),
          // New wording must be approved again before the AI may use it.
          ...(withdrawsApproval && { status: 'draft' as const, approved_by: null, approved_at: null }),
        })
        .where('id', '=', id)
        .execute();
      if (withdrawsApproval) {
        await trx.deleteFrom('knowledge_chunks').where('source_id', '=', id).execute();
      }

      await this.audit(trx, auth, meta, 'knowledge.updated', id, { fields, withdrewApproval: withdrawsApproval });
      return this.detail(await this.loadSource(trx, id));
    });
  }

  approve(auth: AuthContext, id: string, meta: RequestMeta): Promise<KnowledgeSourceDetail> {
    return this.tenant.run(auth, async (trx) => {
      const source = await this.lockSource(trx, id);
      if (source.status !== 'draft') {
        throw new ConflictException(source.status === 'approved' ? 'Already approved' : 'Only a draft can be approved. Restore it first.');
      }

      const pieces = chunkText(source.content);
      await trx.deleteFrom('knowledge_chunks').where('source_id', '=', id).execute();
      await trx
        .insertInto('knowledge_chunks')
        .values(pieces.map((text, ordinal) => ({ practice_id: auth.practiceId, source_id: id, ordinal, title: source.title, text })))
        .execute();
      await trx
        .updateTable('knowledge_sources')
        .set({ status: 'approved', approved_by: auth.userId, approved_at: sql<Date>`now()` })
        .where('id', '=', id)
        .execute();

      await this.audit(trx, auth, meta, 'knowledge.approved', id, { version: source.version, chunks: pieces.length });
      return this.detail(await this.loadSource(trx, id));
    });
  }

  archive(auth: AuthContext, id: string, meta: RequestMeta): Promise<KnowledgeSourceDetail> {
    return this.tenant.run(auth, async (trx) => {
      const source = await this.lockSource(trx, id);
      if (source.status === 'archived') {
        throw new ConflictException('Already archived');
      }
      await trx.deleteFrom('knowledge_chunks').where('source_id', '=', id).execute();
      await trx
        .updateTable('knowledge_sources')
        .set({ status: 'archived', approved_by: null, approved_at: null })
        .where('id', '=', id)
        .execute();
      await this.audit(trx, auth, meta, 'knowledge.archived', id, { wasApproved: source.status === 'approved' });
      return this.detail(await this.loadSource(trx, id));
    });
  }

  /** An archived source comes back as a draft: it must be approved again before the AI may use it. */
  restore(auth: AuthContext, id: string, meta: RequestMeta): Promise<KnowledgeSourceDetail> {
    return this.tenant.run(auth, async (trx) => {
      const source = await this.lockSource(trx, id);
      if (source.status !== 'archived') {
        throw new ConflictException('Only an archived source can be restored');
      }
      await trx.updateTable('knowledge_sources').set({ status: 'draft' }).where('id', '=', id).execute();
      await this.audit(trx, auth, meta, 'knowledge.restored', id, {});
      return this.detail(await this.loadSource(trx, id));
    });
  }

  /** What the AI would find for this question: approved knowledge of this practice only. */
  search(auth: AuthContext, question: string): Promise<KnowledgeSearchResult[]> {
    return this.tenant.run(auth, (trx) => this.retriever.search(trx, question));
  }

  // ---------------------------------------------------------------- helpers

  private selectSources(trx: Kysely<Database>) {
    return trx
      .selectFrom('knowledge_sources as s')
      .leftJoin('users as approver', 'approver.id', 's.approved_by')
      .select([
        's.id',
        's.title',
        's.category',
        's.content',
        's.status',
        's.version',
        's.updated_at',
        's.approved_at',
        'approver.display_name as approved_by_name',
      ]);
  }

  private async loadSource(trx: Kysely<Database>, id: string): Promise<SourceRow> {
    const row = await this.selectSources(trx).where('s.id', '=', id).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Knowledge source not found');
    }
    return row;
  }

  /** Reads and locks the row so two people editing or approving at once are handled one at a time. */
  private async lockSource(trx: Transaction<Database>, id: string) {
    const row = await trx.selectFrom('knowledge_sources').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Knowledge source not found');
    }
    return row;
  }

  private detail(row: SourceRow): KnowledgeSourceDetail {
    return { ...toSummary(row), content: row.content };
  }

  private audit(
    trx: Kysely<Database>,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    sourceId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return writeAuditLog(trx, {
      practiceId: auth.practiceId,
      actorUserId: auth.userId,
      action,
      targetType: 'knowledge_source',
      targetId: sourceId,
      requestId: meta.requestId,
      ip: meta.ip,
      metadata,
    });
  }
}
