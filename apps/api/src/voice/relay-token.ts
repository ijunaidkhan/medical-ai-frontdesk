import { createHmac } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { isUuid } from '../common/uuid.js';

const ALGORITHM = 'HS256';
const ISSUER = 'frontdesk-api';
/** Not the audience of access tokens, so one can never be used as the other. */
const AUDIENCE = 'frontdesk-voice-relay';
const TOKEN_TYPE = 'voice-relay+jwt';
/** Twilio opens the voice session within seconds of receiving the instructions. */
export const RELAY_TOKEN_TTL_SECONDS = 120;

export interface RelayClaims {
  conversationId: string;
  practiceId: string;
}

/**
 * A short-lived token placed in the address Twilio is told to open for the live
 * voice session. It ties that session to ONE conversation of ONE practice, so a
 * session can only ever talk to the conversation it was created for.
 *
 * The signing key is derived from the server secret with a purpose label, so it
 * is different from the key that signs login tokens.
 */
export class RelayTokenService {
  private readonly key: Uint8Array;

  constructor(serverSecret: string) {
    this.key = new Uint8Array(createHmac('sha256', serverSecret).update('frontdesk-voice-relay-v1').digest());
  }

  async sign(claims: RelayClaims, now: Date = new Date()): Promise<string> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    return new SignJWT({ pid: claims.practiceId })
      .setProtectedHeader({ alg: ALGORITHM, typ: TOKEN_TYPE })
      .setSubject(claims.conversationId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + RELAY_TOKEN_TTL_SECONDS)
      .sign(this.key);
  }

  /** The claims of a genuine, unexpired token, or null for anything else. Never throws. */
  async verify(token: string, now: Date = new Date()): Promise<RelayClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        typ: TOKEN_TYPE,
        requiredClaims: ['sub', 'iat', 'exp', 'pid'],
        currentDate: now,
      });
      const conversationId = payload.sub;
      const practiceId = payload['pid'];
      return isUuid(conversationId) && isUuid(practiceId) ? { conversationId, practiceId } : null;
    } catch {
      return null;
    }
  }
}
