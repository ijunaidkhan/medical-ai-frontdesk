import { RelaySessions } from './relay-sessions.js';

describe('RelaySessions', () => {
  it('lets a conversation open a session once, and refuses every later request', () => {
    const sessions = new RelaySessions();
    expect(sessions.tryOpen('c1')).toBe(true);
    expect(sessions.tryOpen('c1')).toBe(false);
    expect(sessions.tryOpen('c1')).toBe(false);
  });

  it('keeps conversations apart', () => {
    const sessions = new RelaySessions();
    expect(sessions.tryOpen('c1')).toBe(true);
    expect(sessions.tryOpen('c2')).toBe(true);
    expect(sessions.tryOpen('c2')).toBe(false);
  });

  it('refuses even after the first session has long closed (a leaked address cannot be replayed)', () => {
    let now = 1_000;
    const sessions = new RelaySessions(30 * 60_000, () => now);
    expect(sessions.tryOpen('c1')).toBe(true);
    now += 29 * 60_000;
    expect(sessions.tryOpen('c1')).toBe(false);
  });

  it('forgets a record only after its time is up, so memory does not grow without end', () => {
    let now = 1_000;
    const sessions = new RelaySessions(1_000, () => now);
    expect(sessions.tryOpen('c1')).toBe(true);
    now += 1_000;
    expect(sessions.tryOpen('c1')).toBe(true); // the old record expired
    expect(sessions.tryOpen('c1')).toBe(false);
  });
});
