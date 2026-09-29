import { slugify, validateBootstrapInput, type BootstrapInput } from './bootstrap.js';

const valid: BootstrapInput = {
  practiceName: 'Riverside Family Clinic',
  practiceSlug: 'riverside-family-clinic',
  timezone: 'America/New_York',
  ownerEmail: 'owner@riverside.example',
  ownerDisplayName: 'Dr. Jane Smith',
  password: 'a long enough passphrase',
};

describe('validateBootstrapInput', () => {
  it('accepts a complete, valid input', () => {
    expect(validateBootstrapInput(valid)).toEqual([]);
  });

  it('accepts UTC', () => {
    expect(validateBootstrapInput({ ...valid, timezone: 'UTC' })).toEqual([]);
  });

  it.each([
    ['blank practice name', { practiceName: '   ' }, /Practice name/],
    ['slug with capitals', { practiceSlug: 'Riverside' }, /short name/],
    ['slug with spaces', { practiceSlug: 'river side' }, /short name/],
    ['one-character slug', { practiceSlug: 'a' }, /short name/],
    ['leading hyphen in slug', { practiceSlug: '-river' }, /short name/],
    ['unknown time zone', { timezone: 'Mars/Olympus' }, /time zone/],
    ['invalid email', { ownerEmail: 'not-an-email' }, /email/],
    ['blank owner name', { ownerDisplayName: '' }, /Owner name/],
    ['14-character password', { password: '12345678901234' }, /at least 15/],
    ['129-character password', { password: 'a'.repeat(129) }, /at most 128/],
    ['password equal to the email', { password: 'owner@riverside.example' }, /same as the email/],
  ])('rejects %s', (_label, change, message) => {
    const problems = validateBootstrapInput({ ...valid, ...change });
    expect(problems.join('\n')).toMatch(message);
  });

  it('accepts a 15-character password: length is the only rule, per NIST', () => {
    expect(validateBootstrapInput({ ...valid, password: 'aaaaaaaaaaaaaaa' })).toEqual([]);
  });

  it('reports every problem at once', () => {
    expect(validateBootstrapInput({ ...valid, practiceName: '', ownerEmail: 'x', password: 'short' })).toHaveLength(3);
  });
});

describe('slugify', () => {
  it.each([
    ['Riverside Family Clinic', 'riverside-family-clinic'],
    ['  Dr. Smith’s   Practice!! ', 'dr-smith-s-practice'],
    ['Café Médico', 'cafe-medico'],
    ['A'.repeat(100), 'a'.repeat(63)],
  ])('%j -> %j', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('can produce something too short or empty, which validation then rejects', () => {
    expect(slugify('!!!')).toBe('');
    expect(validateBootstrapInput({ ...valid, practiceSlug: slugify('!!!') }).join()).toMatch(/short name/);
  });
});
