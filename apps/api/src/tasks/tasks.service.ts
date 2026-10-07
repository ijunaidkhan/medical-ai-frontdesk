import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TASK_PAGE_DEFAULT, type Task, type TaskPage, type TaskStatus } from '@frontdesk/shared';
import { type Kysely, sql, type Transaction } from 'kysely';
import { writeAuditLog } from '../audit/audit-log.js';
import type { AuthContext } from '../auth/auth-context.js';
import { decodeCursor, encodeCursor, type Cursor } from '../common/keyset-cursor.js';
import type { RequestMeta } from '../common/request-meta.js';
import type { Database } from '../database/database.types.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { checkTransition, editBlockedByStatus } from './task-rules.js';
import type { CreateTaskDto, TaskListQuery, UpdateTaskDto } from './tasks.dto.js';

/** Who is creating a task. The AI receptionist uses the second form (from a later step). */
export type TaskActor = { kind: 'user'; userId: string } | { kind: 'ai' };

interface TaskRow {
  id: string;
  type: Task['type'];
  status: TaskStatus;
  priority: Task['priority'];
  title: string;
  details: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  created_by_type: 'user' | 'ai';
  created_by: string | null;
  conversation_id: string | null;
  creator_name: string | null;
  assigned_to: string | null;
  assignee_name: string | null;
  due_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_at_text: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    title: row.title,
    details: row.details,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    createdBy:
      row.created_by_type === 'ai'
        ? { kind: 'ai' }
        : { kind: 'user', person: row.created_by && row.creator_name ? { userId: row.created_by, name: row.creator_name } : null },
    assignedTo: row.assigned_to && row.assignee_name ? { userId: row.assigned_to, name: row.assignee_name } : null,
    conversationId: row.conversation_id,
    dueAt: row.due_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 0 for urgent, 1 for normal: the first thing the queue is ordered by. */
const URGENCY_RANK = sql<number>`(case when t.priority = 'urgent' then 0 else 1 end)`;

/** A page position in the task queue: the urgency rank, then the usual (time, id). */
interface TaskCursor extends Cursor {
  rank: 0 | 1;
}

function encodeTaskCursor(cursor: TaskCursor): string {
  return `${cursor.rank}.${encodeCursor(cursor)}`;
}

/** Null for anything that is not a position this API produced. */
function decodeTaskCursor(value: string): TaskCursor | null {
  const match = /^([01])\.(.+)$/.exec(value);
  const inner = match ? decodeCursor(match[2]!) : null;
  return match && inner ? { ...inner, rank: Number(match[1]) as 0 | 1 } : null;
}

/** Empty text means "nothing": store null, never an empty string. */
const orNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value === '' ? null : value);

@Injectable()
export class TasksService {
  constructor(private readonly tenant: TenantDb) {}

  async list(auth: AuthContext, query: TaskListQuery): Promise<TaskPage> {
    const limit = query.limit ?? TASK_PAGE_DEFAULT;
    const cursor = query.cursor === undefined ? null : decodeTaskCursor(query.cursor);
    if (query.cursor !== undefined && !cursor) {
      throw new BadRequestException('Invalid cursor');
    }
    const status = query.status ?? 'active';

    const rows = await this.tenant.run(auth, async (trx) => {
      let select = this.selectTasks(trx);
      if (status === 'active') select = select.where('t.status', 'in', ['open', 'in_progress']);
      else if (status !== 'all') select = select.where('t.status', '=', status);
      if (query.assignee === 'me') select = select.where('t.assigned_to', '=', auth.userId);
      else if (query.assignee === 'unassigned') select = select.where('t.assigned_to', 'is', null);
      else if (query.assignee) select = select.where('t.assigned_to', '=', query.assignee.toLowerCase());
      // Urgent tasks first (a missed emergency callback is the worst outcome), then newest first. The page
      // position carries the rank too, so paging never skips or repeats a task.
      if (cursor) {
        select = select.where(
          sql<boolean>`(${URGENCY_RANK} > ${cursor.rank} or (${URGENCY_RANK} = ${cursor.rank} and (t.created_at, t.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)))`,
        );
      }
      return select.orderBy(URGENCY_RANK).orderBy('t.created_at', 'desc').orderBy('t.id', 'desc').limit(limit + 1).execute();
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toTask),
      nextCursor: rows.length > limit && last ? encodeTaskCursor({ rank: last.priority === 'urgent' ? 0 : 1, at: last.created_at_text, id: last.id }) : null,
    };
  }

  get(auth: AuthContext, id: string): Promise<Task> {
    return this.tenant.run(auth, async (trx) => toTask(await this.load(trx, id)));
  }

  create(auth: AuthContext, dto: CreateTaskDto, meta: RequestMeta): Promise<Task> {
    return this.tenant.run(auth, async (trx) => {
      const id = await this.createInTransaction(trx, auth.practiceId, dto, { kind: 'user', userId: auth.userId }, meta);
      return toTask(await this.load(trx, id));
    });
  }

  /**
   * Creates a task inside an existing practice-scoped transaction. Shared by the
   * staff endpoint and (later) the AI receptionist's tool, so both go through
   * the same validation, storage and audit.
   */
  async createInTransaction(
    trx: Transaction<Database>,
    practiceId: string,
    input: CreateTaskDto,
    actor: TaskActor,
    meta: RequestMeta,
    /** The conversation the task came from (set when the AI receptionist makes it). */
    conversationId: string | null = null,
  ): Promise<string> {
    if (input.assignedTo) {
      await this.requireActiveMember(trx, practiceId, input.assignedTo);
    }
    const { id } = await trx
      .insertInto('staff_tasks')
      .values({
        practice_id: practiceId,
        type: input.type,
        priority: input.priority ?? 'normal',
        title: input.title,
        details: orNull(input.details),
        contact_name: orNull(input.contactName),
        contact_phone: orNull(input.contactPhone),
        created_by_type: actor.kind,
        created_by: actor.kind === 'user' ? actor.userId : null,
        assigned_to: input.assignedTo ?? null,
        due_at: input.dueAt ? new Date(input.dueAt) : null,
        completed_at: null,
        completed_by: null,
        conversation_id: conversationId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await writeAuditLog(trx, {
      practiceId,
      actorUserId: actor.kind === 'user' ? actor.userId : null,
      actorType: actor.kind === 'user' ? 'user' : 'ai',
      action: 'task.created',
      targetType: 'task',
      targetId: id,
      requestId: meta.requestId,
      ip: meta.ip,
      // Type, priority and source only: never the title, details or contact information.
      metadata: { type: input.type, priority: input.priority ?? 'normal', source: actor.kind },
    });
    return id;
  }

  update(auth: AuthContext, id: string, dto: UpdateTaskDto, meta: RequestMeta): Promise<Task> {
    return this.tenant.run(auth, async (trx) => {
      const current = await trx.selectFrom('staff_tasks').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
      if (!current) {
        throw new NotFoundException('Task not found');
      }

      // What actually changes (a value equal to the current one is not a change).
      const set: Record<string, unknown> = {};
      const changedFields: string[] = [];
      const note = (field: string, column: string, value: unknown, currentValue: unknown) => {
        if (value !== undefined && value !== currentValue) {
          set[column] = value;
          changedFields.push(field);
        }
      };
      note('title', 'title', dto.title, current.title);
      note('details', 'details', dto.details === undefined ? undefined : orNull(dto.details), current.details);
      note('contactName', 'contact_name', dto.contactName === undefined ? undefined : orNull(dto.contactName), current.contact_name);
      note('contactPhone', 'contact_phone', dto.contactPhone === undefined ? undefined : orNull(dto.contactPhone), current.contact_phone);
      note('priority', 'priority', dto.priority, current.priority);
      if (dto.dueAt !== undefined) {
        const due = dto.dueAt === null ? null : new Date(dto.dueAt);
        if ((due?.getTime() ?? null) !== (current.due_at?.getTime() ?? null)) {
          set['due_at'] = due;
          changedFields.push('dueAt');
        }
      }
      const assigneeChanged = dto.assignedTo !== undefined && dto.assignedTo !== current.assigned_to;
      const statusChanged = dto.status !== undefined && dto.status !== current.status;

      if (changedFields.length === 0 && !assigneeChanged && !statusChanged) {
        throw new BadRequestException('Nothing to change');
      }

      // A finished task can only be reopened; nothing else about it may change first.
      const blocked = editBlockedByStatus(current.status, [...changedFields, ...(assigneeChanged ? ['assignedTo'] : [])]);
      if (blocked) {
        throw new ConflictException(blocked);
      }
      if (statusChanged) {
        const verdict = checkTransition(current.status, dto.status!);
        if (!verdict.ok) {
          throw new ConflictException(verdict.message);
        }
        set['status'] = dto.status;
        if (dto.status === 'done') {
          set['completed_at'] = sql<Date>`now()`;
          set['completed_by'] = auth.userId;
        } else if (current.status === 'done') {
          set['completed_at'] = null; // reopened
          set['completed_by'] = null;
        }
      }
      if (assigneeChanged) {
        if (dto.assignedTo) {
          await this.requireActiveMember(trx, auth.practiceId, dto.assignedTo);
        }
        set['assigned_to'] = dto.assignedTo;
      }

      await trx.updateTable('staff_tasks').set(set).where('id', '=', id).execute();

      const audit = (action: string, metadata: Record<string, unknown>) =>
        writeAuditLog(trx, {
          practiceId: auth.practiceId,
          actorUserId: auth.userId,
          action,
          targetType: 'task',
          targetId: id,
          requestId: meta.requestId,
          ip: meta.ip,
          metadata,
        });
      if (changedFields.length > 0) await audit('task.updated', { fields: changedFields });
      if (assigneeChanged) await audit('task.assigned', { from: current.assigned_to, to: dto.assignedTo });
      if (statusChanged) await audit('task.status_changed', { from: current.status, to: dto.status });

      return toTask(await this.load(trx, id));
    });
  }

  // ---------------------------------------------------------------- helpers

  private selectTasks(trx: Kysely<Database>) {
    return trx
      .selectFrom('staff_tasks as t')
      .leftJoin('users as creator', 'creator.id', 't.created_by')
      .leftJoin('users as assignee', 'assignee.id', 't.assigned_to')
      .select([
        't.id',
        't.type',
        't.status',
        't.priority',
        't.title',
        't.details',
        't.contact_name',
        't.contact_phone',
        't.created_by_type',
        't.created_by',
        't.conversation_id',
        'creator.display_name as creator_name',
        't.assigned_to',
        'assignee.display_name as assignee_name',
        't.due_at',
        't.completed_at',
        't.created_at',
        't.updated_at',
        sql<string>`t.created_at::text`.as('created_at_text'),
      ]);
  }

  private async load(trx: Kysely<Database>, id: string): Promise<TaskRow> {
    const row = await this.selectTasks(trx).where('t.id', '=', id).executeTakeFirst();
    if (!row) {
      throw new NotFoundException('Task not found');
    }
    return row;
  }

  /** Tasks can only be given to someone who currently works in this practice. */
  private async requireActiveMember(trx: Kysely<Database>, practiceId: string, userId: string): Promise<void> {
    const member = await trx
      .selectFrom('memberships')
      .select('user_id')
      .where('practice_id', '=', practiceId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!member) {
      throw new BadRequestException('That person is not an active member of this practice');
    }
  }
}
