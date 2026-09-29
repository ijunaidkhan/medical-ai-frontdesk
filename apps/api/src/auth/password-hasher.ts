import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

interface Argon2Settings {
  memory: number; // KiB
  passes: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id: 19 MiB, 2 passes, 1 lane (~50 ms). */
export const ARGON2ID_SETTINGS: Readonly<Argon2Settings> = { memory: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** Upper bounds accepted when reading a stored hash, so a corrupt value cannot exhaust memory or CPU. */
const MAX_SETTINGS: Readonly<Argon2Settings> = { memory: 1_048_576, passes: 10, parallelism: 16 };

/** PHC string format, as produced by the reference implementation: $argon2id$v=19$m=..,t=..,p=..$salt$hash */
const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,171})$/;

function derive(password: string, salt: Buffer, settings: Argon2Settings, length: number): Promise<Buffer> {
  // NFKC normalisation (NIST SP 800-63B) so visually identical input from
  // different keyboards or operating systems produces the same hash.
  const message = Buffer.from(password.normalize('NFKC'), 'utf8');
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message, nonce: salt, tagLength: length, ...settings }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

function toBase64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

function parse(encoded: string): { settings: Argon2Settings; salt: Buffer; hash: Buffer } | null {
  const match = PHC_PATTERN.exec(encoded);
  if (!match) {
    return null;
  }
  const [, memory, passes, parallelism, salt, hash] = match;
  const settings = { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) };
  const withinBounds =
    settings.parallelism >= 1 &&
    settings.parallelism <= MAX_SETTINGS.parallelism &&
    settings.passes >= 1 &&
    settings.passes <= MAX_SETTINGS.passes &&
    settings.memory >= 8 * settings.parallelism &&
    settings.memory <= MAX_SETTINGS.memory;
  if (!withinBounds || !salt || !hash) {
    return null;
  }
  return { settings, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

/**
 * Argon2id password hashing using Node's built-in implementation (Node 24.7+),
 * so no native dependency is needed. Output is the standard PHC string, which
 * other Argon2 libraries can verify.
 */
@Injectable()
export class PasswordHasher {
  private dummy: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const hash = await derive(password, salt, ARGON2ID_SETTINGS, HASH_BYTES);
    const { memory, passes, parallelism } = ARGON2ID_SETTINGS;
    return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${toBase64(salt)}$${toBase64(hash)}`;
  }

  /** Constant-time check. Returns false (never throws) for a malformed stored hash. */
  async verify(encoded: string, password: string): Promise<boolean> {
    const parsed = parse(encoded);
    if (!parsed) {
      return false;
    }
    const actual = await derive(password, parsed.salt, parsed.settings, parsed.hash.length);
    return timingSafeEqual(actual, parsed.hash);
  }

  /**
   * A valid hash of a random secret. Login verifies against it when the email
   * is unknown, so "no such user" takes as long as "wrong password".
   */
  dummyHash(): Promise<string> {
    this.dummy ??= this.hash(randomBytes(32).toString('base64url'));
    return this.dummy;
  }
}
