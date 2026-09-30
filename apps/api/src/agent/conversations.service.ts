import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CONVERSATION_PAGE_DEFAULT,
  type ConversationDetail,
  type ConversationPage,
  type ConversationSummary,
  type ConversationToolCall,
  type ConversationTurn,
} from '@frontdesk/shared';
import { type Kysely, sql } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import { decodeCursor, encodeCursor } from '../common/keyset-cursor.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import type { ConversationListQuery } from './agent.dto.js';

/** Reading what the receptionist said and did. Transcripts are sensitive: viewing one is audited. */
@Injectable()
export class ConversationsService {
  constructor(private readonly tenant: TenantDb) {}

  async list(auth: AuthContext, query: ConversationListQuery): Promise<ConversationPage> {
    const limit = query.limit ?? CONVERSATION_PAGE_DEFAULT;
    const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && !cursor) {
      throw new BadRequestException('Invalid cursor');
    }
    const rows = await this.tenant.run(auth, async (trx) => {
      let select = this.selectSummaries(trx);
      if (cursor) select = select.where(sql<boolean>`(c.started_at, c.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
      return select.orderBy('c.started_at', 'desc').orderBy('c.id', 'desc').limit(limit + 1).execute();
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toSummary(row)),
      nextCursor: rows.length > limit && last ? encodeCursor({ at: last.started_at_text, id: last.id }) : null,
    };
  }

  get(auth: AuthContext, id: string, meta: RequestMeta): Promise<ConversationDetail> {
    return this.tenant.run(auth, async (trx) => {
      const row = await this.selectSummaries(trx).where('c.id', '=', id).executeTakeFirst();
      if (!row) {
        throw new NotFoundException('Conversation not found');
      }
      const [turns, calls, target] = await Promise.all([
        trx.selectFrom('conversation_turns').select(['seq', 'speaker', 'source', 'text', 'guard_reason', 'latency_ms', 'created_at']).where('conversation_id', '=', id).orderBy('seq').execute(),
        trx
          .selectFrom('tool_invocations')
          .select(['turn_seq', 'tool_name', 'arguments', 'result', 'status', 'duration_ms', 'created_at'])
          .where('conversation_id', '=', id)
          .orderBy('created_at')
          .orderBy('id')
          .execute(),
        row.handoff_target_id
          ? trx.selectFrom('transfer_targets').select('label').where('id', '=', row.handoff_target_id).executeTakeFirst()
          : Promise.resolve(undefined),
      ]);

      await writeAuditLog(trx, {
        practiceId: auth.practiceId,
        actorUserId: auth.userId,
        action: 'conversation.viewed',
        targetType: 'conversation',
        targetId: id,
        requestId: meta.requestId,
        ip: meta.ip,
      });

      return {
        ...this.toSummary(row),
        handoffTo: target ? { label: target.label } : null,
        turns: turns.map(
          (turn): ConversationTurn => ({
            seq: turn.seq,
            speaker: turn.speaker,
            source: turn.source,
            text: turn.text,
            guardReason: turn.guard_reason,
            latencyMs: turn.latency_ms,
            at: turn.created_at.toISOString(),
          }),
        ),
        toolCalls: calls.map(
          (call): ConversationToolCall => ({
            turnSeq: call.turn_seq,
            tool: call.tool_name,
            arguments: call.arguments,
            result: call.result,
            status: call.status,
            durationMs: call.duration_ms,
            at: call.created_at.toISOString(),
          }),
        ),
      };
    });
  }

  private selectSummaries(trx: Kysely<Database>) {
    return trx
      .selectFrom('conversations as c')
      .leftJoin('users as starter', 'starter.id', 'c.started_by')
      .select([
        'c.id',
        'c.channel',
        'c.status',
        'c.outcome',
        'c.escalation',
        'c.turn_count',
        'c.started_at',
        'c.ended_at',
        'c.model',
        'c.handoff_target_id',
        'starter.display_name as started_by_name',
        sql<string>`c.started_at::text`.as('started_at_text'),
      ]);
  }

  private toSummary(row: {
    id: string;
    channel: ConversationSummary['channel'];
    status: ConversationSummary['status'];
    outcome: ConversationSummary['outcome'];
    escalation: ConversationSummary['escalation'];
    turn_count: number;
    started_at: Date;
    ended_at: Date | null;
    model: string | null;
    started_by_name: string | null;
  }): ConversationSummary {
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      outcome: row.outcome,
      escalation: row.escalation,
      turnCount: row.turn_count,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      startedByName: row.started_by_name,
      model: row.model,
    };
  }
}
