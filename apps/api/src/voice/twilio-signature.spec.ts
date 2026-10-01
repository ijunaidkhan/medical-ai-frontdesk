import { expectedTwilioSignature, isValidTwilioSignature, urlSpellings, type TwilioParams } from './twilio-signature.js';

/**
 * These signatures were produced by Twilio's OFFICIAL Node library (twilio, getExpectedTwilioSignature),
 * not by this code, so a match means our check agrees with Twilio's. The token is made up.
 * To regenerate: install the official `twilio` package somewhere outside this project and call
 * getExpectedTwilioSignature(token, url, params).
 */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const OFFICIAL: Array<{ name: string; url: string; params: TwilioParams; signature: string }> = [
  {
    name: 'basic example',
    url: 'https://mycompany.com/myapp',
    params: { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' },
    signature: 'HPIcrDDP1dN7UtcfoSQws3uHROo=',
  },
  {
    name: 'query string in the URL',
    url: 'https://mycompany.com/myapp.php?foo=1&bar=2',
    params: { Digits: '1234', To: '+18005551212', From: '+14158675310', Caller: '+14158675310', CallSid: 'CA1234567890ABCDE' },
    signature: 'WbNJzwLArxnnBIrVcCKKdLLpCYk=',
  },
  {
    name: 'repeated values (sorted, de-duplicated)',
    url: 'https://example.com/hook',
    params: { To: ['+18005551212', '+14155550100', '+18005551212'], CallSid: 'CA1' },
    signature: 'FZXrdsFjtJ70sbiEZayacdiPgKA=',
  },
  {
    name: 'unicode and symbols in values',
    url: 'https://example.com/hook',
    params: { SpeechResult: 'café – 你好 & more = fun + 100%', Body: 'a b' },
    signature: 'f3e//eXnNgDmhiw372B41Zb/KoU=',
  },
  { name: 'no parameters', url: 'https://example.com/hook', params: {}, signature: 'V9om41W2eSGlH5ALkwP98Mzn1Gk=' },
  {
    name: 'explicit port in the URL',
    url: 'https://example.com:8443/api/voice/incoming',
    params: { CallSid: 'CA9', To: '+14155550123' },
    signature: 'O1MC6CmI69Q2/+yu+fKijmBv21g=',
  },
  {
    name: 'keys that differ only in case',
    url: 'https://example.com/hook',
    params: { a: '1', B: '2', c: '3', A: '4' },
    signature: 'f4HYePpzJqx1G2MWKm6vO97zx7Y=',
  },
  {
    name: 'a realistic incoming call',
    url: 'https://abc.example.org/api/voice/incoming',
    params: {
      AccountSid: 'AC00000000000000000000000000000000',
      ApiVersion: '2010-04-01',
      CallSid: 'CA11111111111111111111111111111111',
      CallStatus: 'ringing',
      Called: '+14155550123',
      CalledCountry: 'US',
      Caller: '+16505550199',
      CallerCountry: 'US',
      Direction: 'inbound',
      From: '+16505550199',
      To: '+14155550123',
    },
    signature: '/2m4LfIQIYCdHel+ZCSXaaZn+e4=',
  },
];

describe('Twilio signature', () => {
  describe('agrees with the official library', () => {
    it.each(OFFICIAL)('$name', ({ url, params, signature }) => {
      expect(expectedTwilioSignature(TOKEN, url, params)).toBe(signature);
      expect(isValidTwilioSignature(TOKEN, signature, url, params)).toBe(true);
    });

    it('the order of the fields, and of repeated values, does not matter', () => {
      const a = expectedTwilioSignature(TOKEN, 'https://example.com/hook', { B: '2', A: '1', To: ['y', 'x'] });
      const b = expectedTwilioSignature(TOKEN, 'https://example.com/hook', { To: ['x', 'y', 'x'], A: '1', B: '2' });
      expect(a).toBe(b);
    });

    it('a field that is absent counts as not sent', () => {
      expect(expectedTwilioSignature(TOKEN, 'https://example.com/hook', { A: '1', B: undefined })).toBe(expectedTwilioSignature(TOKEN, 'https://example.com/hook', { A: '1' }));
    });
  });

  describe('the default port (Twilio is inconsistent about it, so both spellings are accepted)', () => {
    // Same outcomes as the official library's validateRequest.
    const valid = (signedUrl: string, ourUrl: string) => isValidTwilioSignature(TOKEN, expectedTwilioSignature(TOKEN, signedUrl, { A: '1' }), ourUrl, { A: '1' });

    it('signed with :443, checked without', () => expect(valid('https://example.com:443/hook', 'https://example.com/hook')).toBe(true));
    it('signed without, checked with :443', () => expect(valid('https://example.com/hook', 'https://example.com:443/hook')).toBe(true));
    it('the same for http and :80', () => expect(valid('http://example.com/hook', 'http://example.com:80/hook')).toBe(true));
    it('a non-default port must match exactly', () => {
      expect(valid('https://example.com:8443/hook', 'https://example.com/hook')).toBe(false);
      expect(valid('https://example.com/hook', 'https://example.com:8443/hook')).toBe(false);
      expect(valid('https://example.com:8443/hook', 'https://example.com:8443/hook')).toBe(true);
    });
  });

  describe('refuses anything that is not exactly what Twilio signed', () => {
    const url = 'https://abc.example.org/api/voice/incoming';
    const params = { CallSid: 'CA1', From: '+16505550199', To: '+14155550123' };
    const signature = expectedTwilioSignature(TOKEN, url, params);

    it('accepts the genuine request (control)', () => {
      expect(isValidTwilioSignature(TOKEN, signature, url, params)).toBe(true);
    });

    it.each([
      ['a changed parameter value', url, { ...params, To: '+14155550124' }, TOKEN],
      ['an extra parameter', url, { ...params, Extra: 'x' }, TOKEN],
      ['a missing parameter', url, { CallSid: 'CA1', From: '+16505550199' }, TOKEN],
      ['a different path', 'https://abc.example.org/api/voice/action', params, TOKEN],
      ['a different host', 'https://evil.example.org/api/voice/incoming', params, TOKEN],
      ['http instead of https', 'http://abc.example.org/api/voice/incoming', params, TOKEN],
      ['an added query string', `${url}?x=1`, params, TOKEN],
      ['a different token', url, params, 'another-token-0000000000000000'],
    ])('%s', (_name, checkedUrl, checkedParams, token) => {
      expect(isValidTwilioSignature(token, signature, checkedUrl, checkedParams)).toBe(false);
    });

    it.each([
      ['no signature', undefined],
      ['an empty signature', ''],
      ['only spaces', '   '],
      ['a signature of another length', signature.slice(0, -2)],
      ['a longer signature', `${signature}AA`],
      ['a signature with one character changed', `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`],
      ['text that is not a signature', 'definitely-not-a-signature'],
    ])('%s', (_name, header) => {
      expect(isValidTwilioSignature(TOKEN, header, url, params)).toBe(false);
    });

    it('ignores spaces around an otherwise correct signature', () => {
      expect(isValidTwilioSignature(TOKEN, `  ${signature}\n`, url, params)).toBe(true);
    });

    it('never accepts an empty token (which would make every signature guessable)', () => {
      const weak = expectedTwilioSignature('', url, params);
      expect(isValidTwilioSignature('', weak, url, params)).toBe(false);
    });

    it.each(['', 'not a url', 'ftp://abc.example.org/x', 'javascript:alert(1)'])('refuses the address %j', (badUrl) => {
      expect(isValidTwilioSignature(TOKEN, expectedTwilioSignature(TOKEN, badUrl, params), badUrl, params)).toBe(false);
    });
  });

  describe('urlSpellings', () => {
    it('offers both default-port spellings, but only the written one for a custom port', () => {
      expect(urlSpellings('https://a.example/x?y=1')).toEqual(['https://a.example/x?y=1', 'https://a.example:443/x?y=1']);
      expect(urlSpellings('http://a.example/x')).toEqual(['http://a.example/x', 'http://a.example:80/x']);
      expect(urlSpellings('https://a.example:8443/x')).toEqual(['https://a.example:8443/x']);
    });

    it('treats WebSocket addresses the same way (wss is https, ws is http)', () => {
      expect(urlSpellings('wss://a.example/relay?token=t')).toEqual(['wss://a.example/relay?token=t', 'wss://a.example:443/relay?token=t']);
      expect(urlSpellings('ws://a.example/relay')).toEqual(['ws://a.example/relay', 'ws://a.example:80/relay']);
      expect(urlSpellings('wss://a.example:8443/relay')).toEqual(['wss://a.example:8443/relay']);
      const signature = expectedTwilioSignature(TOKEN, 'wss://a.example:443/relay?token=t', {});
      expect(isValidTwilioSignature(TOKEN, signature, 'wss://a.example/relay?token=t', {})).toBe(true);
      expect(isValidTwilioSignature(TOKEN, signature, 'wss://a.example/relay?token=other', {})).toBe(false);
    });

    it('offers nothing for an address that is not http(s) or ws(s)', () => {
      expect(urlSpellings('nonsense')).toEqual([]);
      expect(urlSpellings('file:///etc/passwd')).toEqual([]);
      expect(urlSpellings('ftp://a.example/x')).toEqual([]);
    });
  });
});
