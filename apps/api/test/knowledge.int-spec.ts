import type { KnowledgeSearchResult, KnowledgeSourceDetail, KnowledgeSourceSummary, Role } from '@frontdesk/shared';
import { sql } from 'kysely';
import { createDatabase, type Db } from '../src/database/database.module.js';
import { withPracticeContext } from '../src/database/practice-context.js';
import { startTestApp } from './support/app.js';
import { as, signIn, type TestApp } from './support/auth-helpers.js';
import { addMember, connect, seedPractice, type SeededPractice } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const HOURS = 'We are open Monday to Friday from 8:00 to 17:00, and on Saturday from 9:00 to 13:00. We are closed on Sundays and public holidays.';
const INSURANCE = 'We accept most major insurance plans, including Blue Cross and Aetna. Please bring your insurance card and photo identification to every visit.';
const CANCEL = 'To cancel or reschedule an appointment, please call us at least 24 hours before it. Late cancellations may be charged a fee.';
const LOCATION = 'We are at 12 River Street, second floor. Free parking is available behind the building.';

describe('knowledge base', () => {
  let database: IsolatedDatabase;
  let owner: Db;
  let app: TestApp;
  let alpha: SeededPractice;
  let beta: SeededPractice;
  const token: Record<Role, string> = { owner: '', admin: '', staff: '', viewer: '' };
  let betaToken: string;

  const create = async (title: string, content: string, category = 'faq') =>
    (await as(app, token.admin).post('/api/knowledge', { title, category, content }).expect(201)).body as KnowledgeSourceDetail;
  const approve = async (id: string) => (await as(app, token.admin).post(`/api/knowledge/${id}/approve`).expect(200)).body as KnowledgeSourceDetail;
  const search = async (query: string, as_ = token.staff) =>
    (await as(app, as_).get(`/api/knowledge/search?q=${encodeURIComponent(query)}`).expect(200)).body as KnowledgeSearchResult[];
  const chunkCount = async (sourceId: string) =>
    Number((await owner.selectFrom('knowledge_chunks').select((eb) => eb.fn.countAll().as('n')).where('source_id', '=', sourceId).executeTakeFirstOrThrow()).n);
  const audit = (action: string) => owner.selectFrom('audit_logs').selectAll().where('action', '=', action).orderBy('occurred_at').execute();

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
    alpha = await seedPractice(owner, 'alpha');
    beta = await seedPractice(owner, 'beta');
    await addMember(owner, alpha.practiceId, 'admin@alpha.test', 'admin');
    await addMember(owner, alpha.practiceId, 'staff@alpha.test', 'staff');
    await addMember(owner, alpha.practiceId, 'viewer@alpha.test', 'viewer');
    app = await startTestApp();
    token.owner = (await signIn(app, { email: alpha.ownerEmail })).session.accessToken;
    token.admin = (await signIn(app, { email: 'admin@alpha.test' })).session.accessToken;
    token.staff = (await signIn(app, { email: 'staff@alpha.test' })).session.accessToken;
    token.viewer = (await signIn(app, { email: 'viewer@alpha.test' })).session.accessToken;
    betaToken = (await signIn(app, { email: beta.ownerEmail })).session.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await owner.destroy();
    await database.drop();
  });

  describe('who may do what', () => {
    let sourceId: string;
    beforeAll(async () => {
      sourceId = (await create('Permissions probe', HOURS)).id;
    });

    it.each<[Role, number]>([['owner', 200], ['admin', 200], ['staff', 200], ['viewer', 403]])('reading (list, one, search) as %s -> %i', async (role, status) => {
      await as(app, token[role]).get('/api/knowledge').expect(status);
      await as(app, token[role]).get(`/api/knowledge/${sourceId}`).expect(status);
      await as(app, token[role]).get('/api/knowledge/search?q=hours').expect(status);
    });

    it.each<[Role, number]>([['owner', 201], ['admin', 201], ['staff', 403], ['viewer', 403]])('creating as %s -> %i', async (role, status) => {
      await as(app, token[role]).post('/api/knowledge', { title: 'x', category: 'faq', content: 'y' }).expect(status);
    });

    it.each(['approve', 'archive', 'restore'])('%s is refused for staff and viewers', async (action) => {
      await as(app, token.staff).post(`/api/knowledge/${sourceId}/${action}`).expect(403);
      await as(app, token.viewer).post(`/api/knowledge/${sourceId}/${action}`).expect(403);
    });

    it('editing is refused for staff and viewers', async () => {
      await as(app, token.staff).patch(`/api/knowledge/${sourceId}`, { title: 'hacked' }).expect(403);
      await as(app, token.viewer).patch(`/api/knowledge/${sourceId}`, { title: 'hacked' }).expect(403);
    });

    it('everything needs a login', async () => {
      await as(app, 'no-token').get('/api/knowledge').expect(401);
      await as(app, 'no-token').post('/api/knowledge', {}).expect(401);
    });
  });

  describe('the approval workflow: the AI can only use what a person approved', () => {
    it('a new entry is a draft, is not searchable, and has no chunks', async () => {
      const source = await create('Opening hours', HOURS, 'hours_location');
      expect(source).toMatchObject({ title: 'Opening hours', category: 'hours_location', status: 'draft', version: 1, approvedAt: null, approvedByName: null });
      expect(source.content).toBe(HOURS);
      expect(await chunkCount(source.id)).toBe(0);
      expect((await search('Are you open on Saturday')).some((r) => r.sourceId === source.id)).toBe(false);
    });

    it('approving makes it searchable, records who approved it, and audits it', async () => {
      const source = await create('Approve me', INSURANCE, 'insurance_billing');
      const approved = await approve(source.id);
      expect(approved).toMatchObject({ status: 'approved', version: 1, approvedByName: 'Member admin@alpha.test' });
      expect(approved.approvedAt).not.toBeNull();
      expect(await chunkCount(source.id)).toBeGreaterThan(0);
      expect((await search('Do you take Blue Cross insurance')).some((r) => r.sourceId === source.id)).toBe(true);

      const entry = (await audit('knowledge.approved')).find((e) => e.target_id === source.id)!;
      expect(entry).toMatchObject({ practice_id: alpha.practiceId, target_type: 'knowledge_source' });
      expect(entry.metadata).toMatchObject({ version: 1 });
    });

    it('editing approved wording withdraws the approval at once: the old text can no longer be found', async () => {
      const source = await create('Cancellation policy', CANCEL, 'policies');
      await approve(source.id);
      expect((await search('cancel an appointment')).some((r) => r.sourceId === source.id)).toBe(true);

      const edited = (await as(app, token.admin).patch(`/api/knowledge/${source.id}`, { content: 'Cancellations need 48 hours notice and there is never a fee, zebra.' }).expect(200)).body as KnowledgeSourceDetail;

      expect(edited).toMatchObject({ status: 'draft', version: 2, approvedAt: null, approvedByName: null });
      expect(await chunkCount(source.id)).toBe(0);
      expect((await search('cancel an appointment')).some((r) => r.sourceId === source.id)).toBe(false);
      expect((await search('zebra')).some((r) => r.sourceId === source.id)).toBe(false); // the new wording is not live until approved

      await approve(source.id);
      const after = await search('how much notice to cancel zebra');
      expect(after.find((r) => r.sourceId === source.id)?.text).toContain('48 hours');
      expect(after.some((r) => r.text.includes('24 hours'))).toBe(false); // the old wording is gone for good
      const entry = (await audit('knowledge.updated')).find((e) => e.target_id === source.id)!;
      expect(entry.metadata).toEqual({ fields: ['content'], withdrewApproval: true });
    });

    it('changing only the category keeps the approval (the AI’s words are unchanged)', async () => {
      const source = await create('Category only', LOCATION, 'general');
      await approve(source.id);
      const changed = (await as(app, token.admin).patch(`/api/knowledge/${source.id}`, { category: 'hours_location' }).expect(200)).body as KnowledgeSourceDetail;
      expect(changed).toMatchObject({ status: 'approved', version: 1, category: 'hours_location' });
      expect(await chunkCount(source.id)).toBeGreaterThan(0);
    });

    it('saving identical text does not withdraw the approval or bump the version', async () => {
      const source = await create('Same text', LOCATION);
      await approve(source.id);
      const same = (await as(app, token.admin).patch(`/api/knowledge/${source.id}`, { content: LOCATION, title: 'Same text' }).expect(200)).body as KnowledgeSourceDetail;
      expect(same).toMatchObject({ status: 'approved', version: 1 });
    });

    it('archiving removes it from search; it cannot be edited or approved until restored, and comes back as a draft', async () => {
      const source = await create('Archive me', HOURS);
      await approve(source.id);
      const archived = (await as(app, token.admin).post(`/api/knowledge/${source.id}/archive`).expect(200)).body as KnowledgeSourceDetail;
      expect(archived).toMatchObject({ status: 'archived', approvedAt: null });
      expect(await chunkCount(source.id)).toBe(0);

      await as(app, token.admin).patch(`/api/knowledge/${source.id}`, { title: 'nope' }).expect(409);
      await as(app, token.admin).post(`/api/knowledge/${source.id}/approve`).expect(409);
      await as(app, token.admin).post(`/api/knowledge/${source.id}/archive`).expect(409);

      const restored = (await as(app, token.admin).post(`/api/knowledge/${source.id}/restore`).expect(200)).body as KnowledgeSourceDetail;
      expect(restored.status).toBe('draft');
      expect(await chunkCount(source.id)).toBe(0); // not usable until approved again
      await as(app, token.admin).post(`/api/knowledge/${source.id}/restore`).expect(409);
    });

    it('cannot be approved twice', async () => {
      const source = await create('Twice', HOURS);
      await approve(source.id);
      await as(app, token.admin).post(`/api/knowledge/${source.id}/approve`).expect(409);
    });

    it('turns two people approving at the same moment into one success and one refusal', async () => {
      const source = await create('Race', HOURS);
      const results = await Promise.all([
        as(app, token.admin).post(`/api/knowledge/${source.id}/approve`),
        as(app, token.owner).post(`/api/knowledge/${source.id}/approve`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await chunkCount(source.id)).toBeGreaterThan(0);
      const chunks = await owner.selectFrom('knowledge_chunks').select('ordinal').where('source_id', '=', source.id).orderBy('ordinal').execute();
      expect(chunks.map((c) => c.ordinal)).toEqual([...chunks.keys()]); // no duplicated or missing pieces
    });

    it('lists entries with a short excerpt, not the whole text', async () => {
      const long = `${'A very long sentence about our clinic. '.repeat(50)}`.trim();
      const source = await create('Long one', long);
      const list = (await as(app, token.staff).get('/api/knowledge').expect(200)).body as KnowledgeSourceSummary[];
      const item = list.find((s) => s.id === source.id)!;
      expect(item.excerpt.length).toBeLessThanOrEqual(161);
      expect(item.excerpt.endsWith('…')).toBe(true);
      expect(Object.keys(item)).not.toContain('content');
    });
  });

  describe('what the AI would find for a caller’s question', () => {
    beforeAll(async () => {
      for (const [title, content, category] of [
        ['Opening hours', HOURS, 'hours_location'],
        ['Insurance', INSURANCE, 'insurance_billing'],
        ['Cancellations', CANCEL, 'policies'],
        ['Location and parking', LOCATION, 'hours_location'],
      ] as const) {
        await approve((await create(`Quality: ${title}`, content, category)).id);
      }
    });

    it.each([
      ['What time do you open on Saturday?', 'Quality: Opening hours', 'Saturday'],
      ['Are you open on Sundays', 'Quality: Opening hours', 'Sundays'],
      ['Do you accept Aetna?', 'Quality: Insurance', 'Aetna'],
      ['What should I bring for my insurance', 'Quality: Insurance', 'insurance card'],
      ['How do I cancel my appointment?', 'Quality: Cancellations', '24 hours'],
      ['Is there a late fee if I reschedule?', 'Quality: Cancellations', 'fee'],
      ['Where is the clinic and can I park?', 'Quality: Location and parking', 'parking'],
    ])('%s -> best answer comes from "%s"', async (question, title, mentions) => {
      const results = await search(question);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.text).toContain(mentions); // the best answer says the right thing...
      expect(results.some((r) => r.title === title && r.text.includes(mentions))).toBe(true); // ...and this entry is among the answers
    });

    it('returns nothing for a question the knowledge base cannot answer', async () => {
      expect(await search('What is the capital of France?')).toEqual([]);
      expect(await search('Can you prescribe me antibiotics for my rash')).toEqual([]);
    });

    it.each(['what is the', 'a', '?!', 'اردو'])('returns an empty list, not an error, for %j', async (q) => {
      expect(await search(q)).toEqual([]);
    });

    it('treats search syntax and SQL in a question as ordinary words', async () => {
      const results = await search("') ; drop table knowledge_chunks; -- | !(hours) & <-> :*");
      expect(Array.isArray(results)).toBe(true);
      expect(Number((await owner.selectFrom('knowledge_chunks').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBeGreaterThan(0);
    });

    it('returns at most 5 results, best first, each with a rank', async () => {
      const results = await search('clinic appointment insurance hours cancel parking open');
      expect(results.length).toBeLessThanOrEqual(5);
      const ranks = results.map((r) => r.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
      expect(ranks.every((r) => r > 0)).toBe(true);
    });

    it.each([['q='], [''], [`q=${'x'.repeat(301)}`], ['q=ok&practiceId=abc']])('rejects a bad search request: ?%s', async (query) => {
      await as(app, token.staff).get(`/api/knowledge/search?${query}`).expect(400);
    });
  });

  describe('input validation', () => {
    const post = (body: object) => as(app, token.admin).post('/api/knowledge', body);
    const valid = { title: 'A title', category: 'faq', content: 'Some content' };

    it.each([
      ['no title', { ...valid, title: undefined }],
      ['a blank title', { ...valid, title: '   ' }],
      ['a title over 200 characters', { ...valid, title: 't'.repeat(201) }],
      ['no content', { ...valid, content: undefined }],
      ['blank content', { ...valid, content: ' \n ' }],
      ['content over 20,000 characters', { ...valid, content: 'c'.repeat(20_001) }],
      ['an unknown category', { ...valid, category: 'secrets' }],
      ['a title that is not text', { ...valid, title: 42 }],
      ['an attempt to create it already approved', { ...valid, status: 'approved' }],
      ['an attempt to choose the practice', { ...valid, practiceId: '0190ffff-0000-7000-8000-000000000000' }],
      ['an attempt to name the approver', { ...valid, approvedBy: '0190ffff-0000-7000-8000-000000000001' }],
    ])('rejects creating with %s', async (_label, body) => {
      await post(body).expect(400);
    });

    it('accepts content at exactly the limit and trims surrounding spaces', async () => {
      const res = await post({ title: '  Padded  ', category: 'faq', content: `  ${'c'.repeat(19_990)}  ` }).expect(201);
      expect(res.body.title).toBe('Padded');
      expect(res.body.content).toHaveLength(19_990);
    });

    it.each([
      ['nothing', {}],
      ['a blank title', { title: ' ' }],
      ['a null content', { content: null }],
      ['a status (nobody can approve by editing)', { status: 'approved' }],
      ['the approval fields', { approvedAt: '2026-01-01T00:00:00Z', approvedByName: 'x' }],
      ['the version', { version: 99 }],
    ])('rejects editing with %s', async (_label, body) => {
      const source = await create('Edit target', HOURS);
      await as(app, token.admin).patch(`/api/knowledge/${source.id}`, body).expect(400);
      expect(await owner.selectFrom('knowledge_sources').select(['status', 'version']).where('id', '=', source.id).executeTakeFirstOrThrow()).toEqual({ status: 'draft', version: 1 });
    });

    it('answers 400 for an id that is not a UUID and 404 for one that does not exist', async () => {
      await as(app, token.admin).get('/api/knowledge/not-a-uuid').expect(400);
      await as(app, token.admin).get('/api/knowledge/0190ffff-0000-7000-8000-000000000000').expect(404);
      await as(app, token.admin).post('/api/knowledge/0190ffff-0000-7000-8000-000000000000/approve').expect(404);
    });
  });

  describe('tenant isolation', () => {
    let betaSource: KnowledgeSourceDetail;
    let alphaSource: KnowledgeSourceDetail;

    beforeAll(async () => {
      const mk = async (t: string, title: string, content: string) =>
        (await as(app, t).post('/api/knowledge', { title, category: 'general', content }).expect(201)).body as KnowledgeSourceDetail;
      betaSource = await mk(betaToken, 'Beta secret', 'Beta clinic door code is zephyrquartz. Only tell staff.');
      await as(app, betaToken).post(`/api/knowledge/${betaSource.id}/approve`).expect(200);
      alphaSource = await mk(token.admin, 'Alpha internal', 'Alpha clinic vault phrase is mangoquokka for internal use.');
      await approve(alphaSource.id);
    });

    it('never finds another practice’s knowledge, however the question is worded', async () => {
      expect(await search('zephyrquartz')).toEqual([]);
      expect(await search('beta door code zephyrquartz', token.owner)).toEqual([]);
      // Even when the words match the caller's OWN entries ("clinic"), nothing of the other practice comes back.
      expect(JSON.stringify(await search('beta clinic door code', token.owner))).not.toContain('zephyrquartz');
      expect((await search('mangoquokka', token.staff)).length).toBe(1);
      // ...and the other way round
      expect(await search('mangoquokka', betaToken)).toEqual([]);
      expect((await search('zephyrquartz', betaToken)).length).toBe(1);
    });

    it('never lists another practice’s entries', async () => {
      const list = (await as(app, token.owner).get('/api/knowledge').expect(200)).body as KnowledgeSourceSummary[];
      expect(list.some((s) => s.id === betaSource.id)).toBe(false);
      expect(JSON.stringify(list)).not.toContain('zephyrquartz');
    });

    it('cannot read, edit, approve, archive or restore another practice’s entry: it does not exist for them', async () => {
      await as(app, token.owner).get(`/api/knowledge/${betaSource.id}`).expect(404);
      await as(app, token.owner).patch(`/api/knowledge/${betaSource.id}`, { title: 'hijacked' }).expect(404);
      await as(app, token.owner).post(`/api/knowledge/${betaSource.id}/archive`).expect(404);
      await as(app, token.owner).post(`/api/knowledge/${betaSource.id}/approve`).expect(404);
      await as(app, token.owner).post(`/api/knowledge/${betaSource.id}/restore`).expect(404);
      expect(await owner.selectFrom('knowledge_sources').select(['title', 'status']).where('id', '=', betaSource.id).executeTakeFirstOrThrow()).toEqual({ title: 'Beta secret', status: 'approved' });
    });

    describe('in the database itself (as the API’s restricted role)', () => {
      let appDb: Db;
      beforeAll(() => {
        appDb = createDatabase(database.appUrl);
      });
      afterAll(async () => {
        await appDb.destroy();
      });

      it.each(['knowledge_sources', 'knowledge_chunks'] as const)('%s shows nothing without a practice context', async (table) => {
        const { rows } = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)}`.execute(appDb);
        expect(Number(rows[0]?.n)).toBe(0);
      });

      it('shows only the current practice’s rows inside a context', async () => {
        const seen = await withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) => trx.selectFrom('knowledge_sources').select('practice_id').execute());
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((row) => row.practice_id === alpha.practiceId)).toBe(true);
      });

      it('cannot insert a source or a chunk for another practice', async () => {
        await expect(
          withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) =>
            trx.insertInto('knowledge_sources').values({ practice_id: beta.practiceId, title: 't', category: 'faq', content: 'c', created_by: null, approved_by: null, approved_at: null }).execute(),
          ),
        ).rejects.toThrow(/row-level security/);
        await expect(
          withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) =>
            trx.insertInto('knowledge_chunks').values({ practice_id: beta.practiceId, source_id: betaSource.id, ordinal: 99, title: 't', text: 'x' }).execute(),
          ),
        ).rejects.toThrow(/row-level security/);
      });

      it('cannot link a chunk of one practice to another practice’s source (composite foreign key)', async () => {
        await expect(
          owner.insertInto('knowledge_chunks').values({ practice_id: alpha.practiceId, source_id: betaSource.id, ordinal: 98, title: 't', text: 'x' }).execute(),
        ).rejects.toThrow(/foreign key/);
      });

      it('cannot erase a source, move it to another practice, or change who created it', async () => {
        await expect(withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) => trx.deleteFrom('knowledge_sources').execute())).rejects.toThrow(/permission denied/);
        await expect(withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) => trx.updateTable('knowledge_sources').set({ practice_id: beta.practiceId }).execute())).rejects.toThrow(/permission denied/);
        await expect(withPracticeContext(appDb, { practiceId: alpha.practiceId }, (trx) => trx.updateTable('knowledge_sources').set({ created_by: null }).execute())).rejects.toThrow(/permission denied/);
      });

      it('cannot mark a source approved without recording who approved it (database rule)', async () => {
        await expect(
          owner.updateTable('knowledge_sources').set({ status: 'approved', approved_by: null, approved_at: null }).where('id', '=', alphaSource.id).execute(),
        ).rejects.toThrow(/check constraint/);
        await expect(
          owner.updateTable('knowledge_sources').set({ status: 'draft' }).where('id', '=', alphaSource.id).execute(), // still has approved_at
        ).rejects.toThrow(/check constraint/);
      });
    });
  });

  it('records who created, edited and archived entries in the audit log', async () => {
    const source = await create('Audited', HOURS);
    await as(app, token.owner).patch(`/api/knowledge/${source.id}`, { title: 'Audited (edited)' }).expect(200);
    await as(app, token.owner).post(`/api/knowledge/${source.id}/archive`).expect(200);
    await as(app, token.owner).post(`/api/knowledge/${source.id}/restore`).expect(200);

    const actions = (await owner.selectFrom('audit_logs').select(['action', 'actor_user_id']).where('target_id', '=', source.id).orderBy('occurred_at').execute());
    expect(actions.map((a) => a.action)).toEqual(['knowledge.created', 'knowledge.updated', 'knowledge.archived', 'knowledge.restored']);
    expect(actions[0]?.actor_user_id).not.toBe(alpha.ownerId); // created by the admin
    expect(actions.slice(1).every((a) => a.actor_user_id === alpha.ownerId)).toBe(true);
    expect(JSON.stringify(actions)).not.toContain(HOURS); // the audit trail records that, never the text itself
  });
});
