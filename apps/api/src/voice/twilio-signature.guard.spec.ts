import { ForbiddenException, NotFoundException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { toTwilioParams, TwilioSignatureGuard } from './twilio-signature.guard.js';
import { expectedTwilioSignature } from './twilio-signature.js';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BASE = 'https://calls.example.org';
const PATH = '/api/voice/incoming';
const PARAMS = { CallSid: 'CA1', From: '+16505550199', To: '+14155550123' };

function setup(settings: Partial<Record<'VOICE_PROVIDER' | 'TWILIO_AUTH_TOKEN' | 'PUBLIC_BASE_URL', string | undefined>> = {}) {
  const values: Record<string, string | undefined> = { VOICE_PROVIDER: 'twilio', TWILIO_AUTH_TOKEN: TOKEN, PUBLIC_BASE_URL: BASE, ...settings };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<EnvironmentVariables, true>;
  const warn = vi.fn();
  const logger = { setContext: vi.fn(), warn } as unknown as PinoLogger;
  const guard = new TwilioSignatureGuard(config, logger);

  const run = (request: { headers?: Record<string, string | string[] | undefined>; body?: unknown; originalUrl?: string; path?: string }) => {
    const full = { headers: {}, body: PARAMS, originalUrl: PATH, path: PATH, ip: '203.0.113.9', ...request };
    const context = { switchToHttp: () => ({ getRequest: () => full }) } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };
  const signed = (url = `${BASE}${PATH}`, params: Record<string, string> = PARAMS) => ({ 'x-twilio-signature': expectedTwilioSignature(TOKEN, url, params) });
  return { run, signed, warn };
}

describe('TwilioSignatureGuard', () => {
  describe('when voice is switched off, the routes do not exist', () => {
    it.each([
      ['no provider', { VOICE_PROVIDER: 'none' }],
      ['no token', { TWILIO_AUTH_TOKEN: undefined }],
      ['no public address', { PUBLIC_BASE_URL: undefined }],
    ])('%s -> 404, even for a perfectly signed request', (_name, settings) => {
      const { run, signed } = setup(settings);
      expect(() => run({ headers: signed() })).toThrow(NotFoundException);
    });
  });

  describe('with voice on', () => {
    it('lets a genuine request through', () => {
      const { run, signed } = setup();
      expect(run({ headers: signed() })).toBe(true);
    });

    it('builds the signed address from the configured public address and the requested path, including the query', () => {
      const { run, signed } = setup();
      const url = `${BASE}/api/voice/action?callSid=CA1`;
      expect(run({ headers: signed(url), originalUrl: '/api/voice/action?callSid=CA1', path: '/api/voice/action' })).toBe(true);
    });

    it.each([
      ['no signature', {}],
      ['an empty signature', { 'x-twilio-signature': '' }],
      ['a signature for other parameters', { 'x-twilio-signature': expectedTwilioSignature(TOKEN, `${BASE}${PATH}`, { CallSid: 'CA2' }) }],
      ['a signature made with another token', { 'x-twilio-signature': expectedTwilioSignature('another-token-0000000000000000', `${BASE}${PATH}`, PARAMS) }],
      ['a signature for another path', { 'x-twilio-signature': expectedTwilioSignature(TOKEN, `${BASE}/api/voice/action`, PARAMS) }],
      ['the signature sent twice (a list)', { 'x-twilio-signature': ['a', 'b'] }],
    ])('refuses %s with 403', (_name, headers) => {
      const { run } = setup();
      expect(() => run({ headers })).toThrow(ForbiddenException);
    });

    it('refuses a request whose parameters were changed after signing', () => {
      const { run, signed } = setup();
      expect(() => run({ headers: signed(), body: { ...PARAMS, To: '+14155550199' } })).toThrow(ForbiddenException);
    });

    it('cannot be fooled by a forged Host or forwarding header: the address comes from configuration only', () => {
      const { run } = setup();
      // A request signed for the attacker's own address, arriving with headers that claim that address.
      const evil = expectedTwilioSignature(TOKEN, `https://evil.example.org${PATH}`, PARAMS);
      expect(() => run({ headers: { 'x-twilio-signature': evil, host: 'evil.example.org', 'x-forwarded-host': 'evil.example.org', 'x-forwarded-proto': 'https' } })).toThrow(ForbiddenException);
    });

    it.each([
      ['a nested object', { CallSid: { nested: 'x' } }],
      ['a number', { CallSid: 5 }],
      ['a list holding a non-text item', { CallSid: ['a', 5] }],
      ['a list instead of fields', [1, 2]],
      ['plain text', 'hello'],
    ])('refuses a body holding %s, rather than interpreting it', (_name, body) => {
      const { run, signed } = setup();
      expect(() => run({ headers: signed(), body })).toThrow(ForbiddenException);
    });

    it('treats an empty body as no parameters', () => {
      const { run, signed } = setup();
      expect(run({ headers: signed(`${BASE}${PATH}`, {}), body: undefined })).toBe(true);
      expect(run({ headers: signed(`${BASE}${PATH}`, {}), body: {} })).toBe(true);
    });

    it('records a refusal without the parameters (they hold callers’ phone numbers)', () => {
      const { run, warn } = setup();
      expect(() => run({ headers: {} })).toThrow(ForbiddenException);
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain('+16505550199');
      expect(logged).not.toContain('+14155550123');
      expect(logged).not.toContain(TOKEN);
      expect(logged).toContain(PATH);
    });
  });

  describe('toTwilioParams', () => {
    it('keeps text fields and lists of text, and nothing else', () => {
      expect(toTwilioParams({ A: '1', B: ['x', 'y'] })).toEqual({ A: '1', B: ['x', 'y'] });
      expect(toTwilioParams({ A: undefined })).toBeNull();
      expect(toTwilioParams(null)).toEqual({});
    });
  });
});
