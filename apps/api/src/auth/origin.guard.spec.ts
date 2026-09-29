import { isAllowedOrigin } from './origin.guard.js';

const ALLOWED = new Set(['http://localhost:4200', 'https://app.example.com']);

describe('isAllowedOrigin', () => {
  it.each([
    ['a configured origin', 'http://localhost:4200', 'api.example.com'],
    ['another configured origin', 'https://app.example.com', 'api.example.com'],
    ['the API’s own host (web app served from the same address)', 'https://api.example.com', 'api.example.com'],
    ['the API’s own host with a port', 'http://127.0.0.1:3000', '127.0.0.1:3000'],
  ])('allows %s', (_label, origin, host) => {
    expect(isAllowedOrigin(origin, host, ALLOWED)).toBe(true);
  });

  it.each([
    ['a missing Origin header', undefined, 'api.example.com'],
    ['an empty Origin header', '', 'api.example.com'],
    ['a stranger', 'https://evil.example', 'api.example.com'],
    ['the literal "null" origin (sandboxed pages)', 'null', 'api.example.com'],
    ['a look-alike of an allowed origin', 'http://localhost:4200.evil.example', 'api.example.com'],
    ['a different port on an allowed host', 'http://localhost:9999', 'api.example.com'],
    ['a different scheme on an allowed origin', 'https://localhost:4200', 'api.example.com'],
    ['a non-http scheme', 'file://api.example.com', 'api.example.com'],
    ['an unparseable value', 'not a url', 'api.example.com'],
    ['a same-host origin when the Host header is missing', 'https://api.example.com', undefined],
  ])('rejects %s', (_label, origin, host) => {
    expect(isAllowedOrigin(origin, host, ALLOWED)).toBe(false);
  });
});
