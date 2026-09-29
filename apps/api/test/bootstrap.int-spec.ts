import { BootstrapValidationError, createPracticeWithOwner } from '../src/auth/bootstrap.js';
import type { Db } from '../src/database/database.module.js';
import { startTestApp } from './support/app.js';
import { loginRequest, type TestApp } from './support/auth-helpers.js';
import { connect, hasher } from './support/fixtures.js';
import { createIsolatedDatabase, type IsolatedDatabase } from './support/test-database.js';

const INPUT = {
  practiceName: 'Riverside Family Clinic',
  practiceSlug: 'riverside',
  timezone: 'America/New_York',
  ownerEmail: 'dr.smith@riverside.example',
  ownerDisplayName: 'Dr. Jane Smith',
  password: 'a sufficiently long passphrase',
};

describe('bootstrapping the first practice and owner', () => {
  let database: IsolatedDatabase;
  let owner: Db;

  const counts = async () => ({
    practices: Number((await owner.selectFrom('practices').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    users: Number((await owner.selectFrom('users').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
    memberships: Number((await owner.selectFrom('memberships').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n),
  });

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    process.env['DATABASE_URL'] = database.appUrl;
    owner = connect(database.ownerUrl);
  });

  afterAll(async () => {
    await owner.destroy();
    await database.drop();
  });

  it('creates the practice, an owner who has never seen the password in plain text, and an audit entry', async () => {
    const { practiceId, userId } = await createPracticeWithOwner(owner, hasher, INPUT);

    const practice = await owner.selectFrom('practices').selectAll().where('id', '=', practiceId).executeTakeFirstOrThrow();
    expect(practice).toMatchObject({ name: 'Riverside Family Clinic', slug: 'riverside', timezone: 'America/New_York', status: 'active' });

    const user = await owner.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirstOrThrow();
    expect(user.email).toBe('dr.smith@riverside.example');
    expect(user.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(user.password_hash).not.toContain(INPUT.password);

    const membership = await owner.selectFrom('memberships').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
    expect(membership).toMatchObject({ practice_id: practiceId, role: 'owner', status: 'active' });

    const entry = await owner.selectFrom('audit_logs').selectAll().where('action', '=', 'bootstrap.practice_created').executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ practice_id: practiceId, actor_user_id: userId, target_id: practiceId });
    expect(JSON.stringify(entry)).not.toContain(INPUT.password);
  });

  it('produces an account that can sign in through the real API', async () => {
    const app: TestApp = await startTestApp();
    try {
      const res = await loginRequest(app, { email: INPUT.ownerEmail, password: INPUT.password }).expect(200);
      expect(res.body.practice).toMatchObject({ slug: 'riverside', role: 'owner' });
      expect(res.body.user.displayName).toBe('Dr. Jane Smith');
    } finally {
      await app.close();
    }
  });

  it('creates nothing at all when the email is already taken (all-or-nothing)', async () => {
    const before = await counts();
    await expect(
      createPracticeWithOwner(owner, hasher, { ...INPUT, practiceSlug: 'second-practice' }),
    ).rejects.toThrow(/duplicate key/);
    expect(await counts()).toEqual(before);
  });

  it('creates nothing when the practice short name is already taken', async () => {
    const before = await counts();
    await expect(
      createPracticeWithOwner(owner, hasher, { ...INPUT, ownerEmail: 'someone.else@riverside.example' }),
    ).rejects.toThrow(/duplicate key/);
    expect(await counts()).toEqual(before);
  });

  it.each([
    ['a short password', { password: 'too short' }],
    ['a bad time zone', { timezone: 'Nowhere/Land' }],
    ['a bad slug', { practiceSlug: 'Not Valid!' }],
    ['a bad email', { ownerEmail: 'nope' }],
  ])('rejects %s before touching the database', async (_label, change) => {
    const before = await counts();
    await expect(
      createPracticeWithOwner(owner, hasher, { ...INPUT, ownerEmail: 'fresh@riverside.example', practiceSlug: 'fresh', ...change }),
    ).rejects.toBeInstanceOf(BootstrapValidationError);
    expect(await counts()).toEqual(before);
  });
});
