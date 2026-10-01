import { SignJWT } from 'jose';
import { AccessTokenService } from '../auth/access-token.service.js';
import { RELAY_TOKEN_TTL_SECONDS, RelayTokenService } from './relay-token.js';

const SECRET = 'unit-test-signing-key-0123456789abcdef';
const CONVERSATION = '0190a1b2-c3d4-7e5f-8a9b-0000000000c1';
const PRACTICE = '0190a1b2-c3d4-7e5f-8a9b-0000000000a1';
const claims = { conversationId: CONVERSATION, practiceId: PRACTICE };

describe('RelayTokenService', () => {
  const service = new RelayTokenService(SECRET);

  it('ties a voice session to one conversation of one practice', async () => {
    const token = await service.sign(claims);
    expect(await service.verify(token)).toEqual(claims);
  });

  it('expires after two minutes, and not before', async () => {
    const issued = new Date('2026-09-30T12:00:00Z');
    const token = await service.sign(claims, issued);
    expect(RELAY_TOKEN_TTL_SECONDS).toBe(120);
    expect(await service.verify(token, new Date(issued.getTime() + 119_000))).toEqual(claims);
    expect(await service.verify(token, new Date(issued.getTime() + 121_000))).toBeNull();
  });

  it('refuses a token signed with another secret', async () => {
    const other = await new RelayTokenService('a-completely-different-secret-0123456789').sign(claims);
    expect(await service.verify(other)).toBeNull();
  });

  it('refuses a changed token (another conversation swapped in)', async () => {
    const token = await service.sign(claims);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: '0190a1b2-c3d4-7e5f-8a9b-0000000000c2', pid: PRACTICE, iss: 'frontdesk-api', aud: 'frontdesk-voice-relay', iat: 1, exp: 9_999_999_999 })).toString('base64url');
    expect(await service.verify(`${header}.${forgedPayload}.${signature}`)).toBeNull();
  });

  it.each([[''], ['not a token'], ['a.b.c'], ['....']])('refuses %j without throwing', async (garbage) => {
    await expect(service.verify(garbage)).resolves.toBeNull();
  });

  it('refuses an unsigned token ("alg: none")', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'voice-relay+jwt' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: CONVERSATION, pid: PRACTICE, iss: 'frontdesk-api', aud: 'frontdesk-voice-relay', iat: 1, exp: 9_999_999_999 })).toString('base64url');
    expect(await service.verify(`${header}.${payload}.`)).toBeNull();
  });

  it('a login (access) token can never be used as a voice token, and the reverse', async () => {
    const access = new AccessTokenService(SECRET);
    const { token: loginToken } = await access.sign({ userId: CONVERSATION, practiceId: PRACTICE, role: 'owner', sessionId: CONVERSATION });
    expect(await service.verify(loginToken)).toBeNull();
    await expect(access.verify(await service.sign(claims))).rejects.toThrow();
  });

  it('uses its own key: someone holding only the login signing secret cannot forge a voice token', async () => {
    const loginKey = new TextEncoder().encode(SECRET); // the key login tokens are signed with
    const forged = await new SignJWT({ pid: PRACTICE })
      .setProtectedHeader({ alg: 'HS256', typ: 'voice-relay+jwt' })
      .setSubject(CONVERSATION)
      .setIssuer('frontdesk-api')
      .setAudience('frontdesk-voice-relay') // everything else exactly right
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(loginKey);
    expect(await service.verify(forged)).toBeNull();
  });

  it('refuses a token with the right key but the wrong audience, type or claims', async () => {
    // Build it with the same derived key by going through the service's own signer, then alter one property at a time.
    const key = (service as unknown as { key: Uint8Array }).key;
    const make = (audience: string, type: string, subject: string, pid: string) =>
      new SignJWT({ pid }).setProtectedHeader({ alg: 'HS256', typ: type }).setSubject(subject).setIssuer('frontdesk-api').setAudience(audience).setIssuedAt().setExpirationTime('2m').sign(key);
    expect(await service.verify(await make('frontdesk-voice-relay', 'voice-relay+jwt', CONVERSATION, PRACTICE))).toEqual(claims); // control
    expect(await service.verify(await make('frontdesk-web', 'voice-relay+jwt', CONVERSATION, PRACTICE))).toBeNull();
    expect(await service.verify(await make('frontdesk-voice-relay', 'JWT', CONVERSATION, PRACTICE))).toBeNull();
    expect(await service.verify(await make('frontdesk-voice-relay', 'voice-relay+jwt', 'not-a-uuid', PRACTICE))).toBeNull();
    expect(await service.verify(await make('frontdesk-voice-relay', 'voice-relay+jwt', CONVERSATION, 'not-a-uuid'))).toBeNull();
  });
});
