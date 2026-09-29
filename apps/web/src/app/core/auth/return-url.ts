/**
 * After sign-in the person is sent back to where they were. The address comes
 * from the URL, which anyone can craft, so only in-app paths are accepted:
 * anything that could lead to another site falls back to the dashboard.
 */
export function safeReturnUrl(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) {
    return fallback;
  }
  const isInAppPath = value.startsWith('/') && !value.startsWith('//');
  const hasDangerousCharacters = /[\\\u0000-\u001f\u007f]/.test(value);
  const isLoginPage = value === '/login' || value.startsWith('/login?') || value.startsWith('/login/');
  return isInAppPath && !hasDangerousCharacters && !isLoginPage ? value : fallback;
}
