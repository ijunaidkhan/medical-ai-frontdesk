import { sql } from 'kysely';
import { createDatabase, type Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

describe('conversation tables (database rules)', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: Db;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  let alphaConversation: string;
  let betaConversation: string;

  const inAlpha = <T>(work: (trx: Parameters<Parameters<typeof withPracticeContext>[2]>[0]) => Promise<T>) =>
    withPracticeContext(app, { practiceId: alpha.practiceId }, work);

  const newConversation = (practiceId: string) =>
    owner.insertInto('conversations').values({ practice_id: practiceId, channel: 'test_chat', outcome: null, escalation: null, handoff_target_id: null, started_by: null, model: null, ended_at: null }).returning('id').executeTakeFirstOrThrow();
  const turn = (practiceId: string, conversationId: string, seq: number, text = 'Hello') => ({
    practice_id: practiceId,
    conversation_id: conversationId,
    seq,
    speaker: 'caller' as const,
    source: 'caller' as const,
    text,
    guard_reason: null,
    blocked_text: null,
    latency_ms: null,
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    owner = connect(database.ownerUrl);
    app = createDatabase(database.appUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    alphaConversation = (await newConversation(alpha.practiceId)).id;
    betaConversation = (await newConversation(beta.practiceId)).id;
    await owner.insertInto('conversation_turns').values([turn(alpha.practiceId, alphaConversation, 1, 'Alpha caller'), turn(beta.practiceId, betaConversation, 1, 'Beta caller')]).execute();
    await owner
      .insertInto('tool_invocations')
      .values([
        { practice_id: alpha.practiceId, conversation_id: alphaConversation, turn_seq: 1, tool_name: 'search_knowledge', arguments: { query: 'hours' }, result: null, status: 'ok', duration_ms: 5 },
        { practice_id: beta.practiceId, conversation_id: betaConversation, turn_seq: 1, tool_name: 'search_knowledge', arguments: { query: 'secret' }, result: null, status: 'ok', duration_ms: 5 },
      ])
      .execute();
  });

  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
    await database.drop();
  });

  describe('tenant isolation', () => {
    it.each(['conversations', 'conversation_turns', 'tool_invocations'] as const)('%s shows nothing without a practice context', async (table) => {
      const { rows } = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(app);
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('shows only the current practice’s conversations, turns and tool calls', async () => {
      const seen = await inAlpha(async (trx) => ({
        conversations: await trx.selectFrom('conversations').select('id').execute(),
        turns: await trx.selectFrom('conversation_turns').select('text').execute(),
        tools: await trx.selectFrom('tool_invocations').select('arguments').execute(),
      }));
      expect(seen.conversations.map((c) => c.id)).toEqual([alphaConversation]);
      expect(seen.turns.map((t) => t.text)).toEqual(['Alpha caller']);
      expect(JSON.stringify(seen.tools)).not.toContain('secret');
    });

    it('cannot write for another practice', async () => {
      await expect(inAlpha((trx) => trx.insertInto('conversations').values({ practice_id: beta.practiceId, channel: 'test_chat', outcome: null, escalation: null, handoff_target_id: null, started_by: null, model: null, ended_at: null }).execute())).rejects.toThrow(/row-level security/);
      await expect(inAlpha((trx) => trx.insertInto('conversation_turns').values(turn(beta.practiceId, betaConversation, 2)).execute())).rejects.toThrow(/row-level security/);
    });

    it('cannot attach a turn, tool call or task of one practice to another practice’s conversation (composite foreign keys)', async () => {
      await expect(owner.insertInto('conversation_turns').values(turn(alpha.practiceId, betaConversation, 2)).execute()).rejects.toThrow(/foreign key/);
      await expect(
        owner.insertInto('tool_invocations').values({ practice_id: alpha.practiceId, conversation_id: betaConversation, turn_seq: 1, tool_name: 'x', arguments: {}, result: null, status: 'ok', duration_ms: null }).execute(),
      ).rejects.toThrow(/foreign key/);
      const task = await owner
        .insertInto('staff_tasks')
        .values({ practice_id: alpha.practiceId, type: 'other', title: 't', details: null, contact_name: null, contact_phone: null, created_by_type: 'ai', created_by: null, assigned_to: null, due_at: null, completed_at: null, completed_by: null })
        .returning('id')
        .executeTakeFirstOrThrow();
      await expect(owner.updateTable('staff_tasks').set({ conversation_id: betaConversation }).where('id', '=', task.id).execute()).rejects.toThrow(/foreign key/);
      await owner.updateTable('staff_tasks').set({ conversation_id: alphaConversation }).where('id', '=', task.id).execute(); // its own practice's is fine
    });
  });

  describe('the transcript cannot be rewritten by the API', () => {
    it('can add turns and tool calls, but never change or delete them', async () => {
      await inAlpha((trx) => trx.insertInto('conversation_turns').values({ ...turn(alpha.practiceId, alphaConversation, 2, 'Second'), speaker: 'ai', source: 'model' }).execute());
      await inAlpha((trx) => trx.insertInto('tool_invocations').values({ practice_id: alpha.practiceId, conversation_id: alphaConversation, turn_seq: 2, tool_name: 'x', arguments: {}, result: null, status: 'ok', duration_ms: 1 }).execute());

      await expect(inAlpha((trx) => trx.updateTable('conversation_turns').set({ text: 'edited' }).execute())).rejects.toThrow(/permission denied/);
      await expect(inAlpha((trx) => trx.deleteFrom('conversation_turns').execute())).rejects.toThrow(/permission denied/);
      await expect(inAlpha((trx) => trx.updateTable('tool_invocations').set({ status: 'error' }).execute())).rejects.toThrow(/permission denied/);
      await expect(inAlpha((trx) => trx.deleteFrom('tool_invocations').execute())).rejects.toThrow(/permission denied/);
      await expect(inAlpha((trx) => trx.deleteFrom('conversations').execute())).rejects.toThrow(/permission denied/);
    });

    it('cannot move a conversation to another practice or change its channel or who started it', async () => {
      for (const change of [{ practice_id: beta.practiceId }, { channel: 'phone' as const }, { started_by: alpha.ownerId }]) {
        await expect(inAlpha((trx) => trx.updateTable('conversations').set(change).execute())).rejects.toThrow(/permission denied/);
      }
    });

    it('can update only the conversation’s progress', async () => {
      await inAlpha((trx) => trx.updateTable('conversations').set({ turn_count: 2, model: 'scripted' }).where('id', '=', alphaConversation).execute());
      expect((await owner.selectFrom('conversations').select(['turn_count', 'model']).where('id', '=', alphaConversation).executeTakeFirstOrThrow())).toEqual({ turn_count: 2, model: 'scripted' });
    });
  });

  describe('data rules', () => {
    it('numbers turns uniquely within a conversation', async () => {
      await expect(owner.insertInto('conversation_turns').values(turn(alpha.practiceId, alphaConversation, 1, 'again')).execute()).rejects.toThrow(/duplicate key/);
    });

    it.each([
      ['empty text', ''],
      ['text over 4000 characters', 'x'.repeat(4001)],
    ])('refuses a turn with %s', async (_label, text) => {
      await expect(owner.insertInto('conversation_turns').values(turn(alpha.practiceId, alphaConversation, 50, text)).execute()).rejects.toThrow(/check constraint/);
    });

    describe('the text of a reply the safety check replaced', () => {
      const blocked = (extra: object) => ({ ...turn(alpha.practiceId, alphaConversation, 60), speaker: 'ai' as const, source: 'scripted_guard' as const, guard_reason: 'diagnosis', blocked_text: 'You probably have an infection.', ...extra });

      it('is kept with the turn it replaced, and the API role can add it but never edit or erase it', async () => {
        await inAlpha((trx) => trx.insertInto('conversation_turns').values(blocked({ seq: 61 })).execute());
        const [row] = await owner.selectFrom('conversation_turns').select(['guard_reason', 'blocked_text']).where('seq', '=', 61).where('conversation_id', '=', alphaConversation).execute();
        expect(row).toEqual({ guard_reason: 'diagnosis', blocked_text: 'You probably have an infection.' });
        await expect(inAlpha((trx) => trx.updateTable('conversation_turns').set({ blocked_text: null }).execute())).rejects.toThrow(/permission denied/);
      });

      it('is tenant-isolated like the rest of the transcript', async () => {
        const seen = await inAlpha((trx) => trx.selectFrom('conversation_turns').select(['blocked_text']).where('blocked_text', 'is not', null).execute());
        expect(seen.every((turnRow) => turnRow.blocked_text === 'You probably have an infection.')).toBe(true);
        await expect(
          inAlpha((trx) => trx.insertInto('conversation_turns').values({ ...blocked({ seq: 62 }), practice_id: beta.practiceId, conversation_id: betaConversation }).execute()),
        ).rejects.toThrow(/row-level security/);
      });

      it.each([
        ['without a guard reason (only a replaced turn has one)', { guard_reason: null }],
        ['empty', { blocked_text: '' }],
        ['over 4000 characters', { blocked_text: 'x'.repeat(4001) }],
      ])('is refused when %s', async (_label, change) => {
        await expect(owner.insertInto('conversation_turns').values(blocked({ seq: 63, ...change })).execute()).rejects.toThrow(/check constraint/);
      });
    });

    it('keeps "active" and "finished" consistent: an active conversation has no end or outcome; a finished one has both', async () => {
      const { id } = await newConversation(alpha.practiceId);
      await expect(owner.updateTable('conversations').set({ ended_at: sql<Date>`now()` }).where('id', '=', id).execute()).rejects.toThrow(/check constraint/);
      await expect(owner.updateTable('conversations').set({ status: 'completed' }).where('id', '=', id).execute()).rejects.toThrow(/check constraint/);
      await owner.updateTable('conversations').set({ status: 'completed', outcome: 'answered', ended_at: sql<Date>`now()` }).where('id', '=', id).execute();
    });

    it.each([
      ['an unknown channel', { channel: 'fax' }],
      ['an unknown outcome', { outcome: 'ghosted' }],
      ['an unknown escalation', { escalation: 'panic' }],
    ])('refuses %s', async (_label, change) => {
      const { id } = await newConversation(alpha.practiceId);
      await expect(owner.updateTable('conversations').set({ status: 'completed', ended_at: sql<Date>`now()`, outcome: 'answered', ...change } as never).where('id', '=', id).execute()).rejects.toThrow(/check constraint/);
    });
  });

  describe('audit: who acted', () => {
    const entry = (extra: object) => ({ practice_id: alpha.practiceId, actor_user_id: null, action: 'test.event', target_type: null, target_id: null, request_id: null, ip: null, metadata: {}, ...extra });

    it('marks actions by the AI, and never lets one name a user', async () => {
      await owner.insertInto('audit_logs').values(entry({ actor_type: 'ai' })).execute();
      await expect(owner.insertInto('audit_logs').values(entry({ actor_type: 'ai', actor_user_id: alpha.ownerId })).execute()).rejects.toThrow(/check constraint/);
    });

    it('defaults to a person, and refuses an unknown kind of actor', async () => {
      await owner.insertInto('audit_logs').values(entry({ action: 'test.default' })).execute();
      expect((await owner.selectFrom('audit_logs').select('actor_type').where('action', '=', 'test.default').executeTakeFirstOrThrow()).actor_type).toBe('user');
      await expect(owner.insertInto('audit_logs').values(entry({ actor_type: 'robot' }) as never).execute()).rejects.toThrow(/check constraint/);
    });
  });
});
