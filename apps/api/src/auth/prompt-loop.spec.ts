import { bootstrapFieldChecks } from './bootstrap.js';
import { BootstrapValidationError } from './bootstrap.js';
import { askUntilValid } from './prompt-loop.js';

/** Answers a question from a fixed list, like a person typing. */
const typing = (...answers: string[]) => {
  const remaining = [...answers];
  return vi.fn(async () => remaining.shift() ?? '');
};

describe('askUntilValid', () => {
  it('returns a good first answer without complaining', async () => {
    const report = vi.fn();
    const answer = await askUntilValid(typing('Asia/Karachi'), bootstrapFieldChecks.timezone, report);
    expect(answer).toBe('Asia/Karachi');
    expect(report).not.toHaveBeenCalled();
  });

  it('says what was wrong and asks again until the answer is good (the "7:51 pm" case)', async () => {
    const ask = typing('7:51 pm', 'Pakistan', 'Asia/Karachi');
    const report = vi.fn();

    const answer = await askUntilValid(ask, bootstrapFieldChecks.timezone, report);

    expect(answer).toBe('Asia/Karachi');
    expect(ask).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]?.[0]).toMatch(/Unknown time zone "7:51 pm".*not the time of day/);
  });

  it('gives up after the allowed number of attempts, with the last problem', async () => {
    const ask = typing('a', 'b', 'c');
    await expect(askUntilValid(ask, bootstrapFieldChecks.timezone, () => undefined, 3)).rejects.toThrow(BootstrapValidationError);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it('cannot loop forever when the input has run out', async () => {
    const ask = typing(); // every answer is ''
    await expect(askUntilValid(ask, bootstrapFieldChecks.ownerEmail, () => undefined)).rejects.toThrow(/email/);
    expect(ask).toHaveBeenCalledTimes(5);
  });
});

describe('bootstrap field checks', () => {
  it.each([
    ['practiceName', '', /1-120/],
    ['practiceSlug', 'Not Valid', /short name/],
    ['timezone', '7:51 pm', /not the time of day/],
    ['ownerEmail', 'nope', /email/],
    ['ownerDisplayName', '   ', /Owner name/],
  ] as const)('%s rejects %j with a helpful message', (field, value, message) => {
    expect(bootstrapFieldChecks[field](value)).toMatch(message);
  });

  it('accepts good answers', () => {
    expect(bootstrapFieldChecks.practiceName('Riverside Clinic')).toBeNull();
    expect(bootstrapFieldChecks.practiceSlug('riverside-clinic')).toBeNull();
    expect(bootstrapFieldChecks.timezone('Asia/Karachi')).toBeNull();
    expect(bootstrapFieldChecks.ownerEmail('a@b.example')).toBeNull();
    expect(bootstrapFieldChecks.ownerDisplayName('Jane')).toBeNull();
  });

  it('checks the password length, and that it is not the email address', () => {
    expect(bootstrapFieldChecks.password('too short', 'a@b.example')).toMatch(/at least 15/);
    expect(bootstrapFieldChecks.password('x'.repeat(129), 'a@b.example')).toMatch(/at most 128/);
    expect(bootstrapFieldChecks.password('Long.Email@Example.Test', 'long.email@example.test')).toMatch(/same as the email/);
    expect(bootstrapFieldChecks.password('a long enough passphrase', 'a@b.example')).toBeNull();
  });
});
