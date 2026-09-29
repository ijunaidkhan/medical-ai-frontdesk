import { ARGON2ID_SETTINGS, PasswordHasher } from './password-hasher.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('produces a standard argon2id PHC string with the configured cost', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    const { memory, passes, parallelism } = ARGON2ID_SETTINGS;
    expect(hash).toMatch(new RegExp(`^\\$argon2id\\$v=19\\$m=${memory},t=${passes},p=${parallelism}\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$`));
    expect(hash).not.toContain('correct horse');
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse battery stapl')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('salts every hash differently', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password 123456'), hasher.hash('same password 123456')]);
    expect(a).not.toBe(b);
  });

  it('treats visually identical Unicode as the same password (NFKC)', async () => {
    const composed = 'café au lait 123456'; // é as one character
    const decomposed = 'café au lait 123456'; // e + combining accent
    expect(await hasher.verify(await hasher.hash(composed), decomposed)).toBe(true);
  });

  it('verifies a hash produced by another Argon2 implementation (interoperability)', async () => {
    // Reference vector from the argon2-cffi documentation (m=65536, t=3, p=4).
    const reference =
      '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg';
    expect(await hasher.verify(reference, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(reference, 'wrong')).toBe(false);
  });

  describe('malformed or hostile stored hashes', () => {
    it.each([
      ['empty', ''],
      ['not a hash', 'password123'],
      ['wrong algorithm', '$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA'],
      ['memory far above the limit', '$argon2id$v=19$m=9999999,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA'],
      ['too many passes', '$argon2id$v=19$m=19456,t=99,p=1$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA'],
      ['zero parallelism', '$argon2id$v=19$m=19456,t=2,p=0$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA'],
    ])('returns false instead of throwing or hanging: %s', async (_label, stored) => {
      await expect(hasher.verify(stored, 'anything at all 123')).resolves.toBe(false);
    });
  });

  it('provides a real, verifiable dummy hash for unknown-user timing equalisation', async () => {
    const dummy = await hasher.dummyHash();
    expect(dummy).toMatch(/^\$argon2id\$/);
    expect(await hasher.dummyHash()).toBe(dummy); // computed once
    expect(await hasher.verify(dummy, 'guess')).toBe(false);
  });
});
