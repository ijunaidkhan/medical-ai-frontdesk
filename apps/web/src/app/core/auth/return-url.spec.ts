import { safeReturnUrl } from './return-url';

describe('safeReturnUrl', () => {
  it.each(['/dashboard', '/team', '/activity', '/team?tab=1', '/some/deep/path#section'])('keeps the in-app path %s', (url) => {
    expect(safeReturnUrl(url)).toBe(url);
  });

  it.each([
    ['another site', 'https://evil.example/phish'],
    ['a protocol-relative address', '//evil.example'],
    ['a protocol-relative address with a slash trick', '/\\evil.example'],
    ['a backslash anywhere', '/ok\\..\\evil'],
    ['a javascript: address', 'javascript:alert(1)'],
    ['a data: address', 'data:text/html,<script>1</script>'],
    ['a path without a leading slash', 'dashboard'],
    ['an empty string', ''],
    ['a newline (header injection)', '/team\r\nSet-Cookie: x=1'],
    ['a control character', '/team\u0000'],
    ['the login page itself (would loop)', '/login'],
    ['the login page with a query', '/login?returnUrl=/team'],
    ['something absurdly long', `/${'a'.repeat(2500)}`],
  ])('falls back to the dashboard for %s', (_label, url) => {
    expect(safeReturnUrl(url)).toBe('/dashboard');
  });

  it.each([null, undefined, 42, {}, ['/team']])('falls back for a non-string: %j', (value) => {
    expect(safeReturnUrl(value)).toBe('/dashboard');
  });

  it('uses a custom fallback', () => {
    expect(safeReturnUrl('//evil.example', '/home')).toBe('/home');
  });
});
