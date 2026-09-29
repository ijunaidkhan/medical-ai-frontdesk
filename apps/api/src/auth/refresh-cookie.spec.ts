import type { Response } from 'express';
import { clearRefreshCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from './refresh-cookie.js';

function fakeResponse() {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  return { response: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
}

describe('refresh cookie', () => {
  const expires = new Date('2030-01-01T00:00:00Z');

  it('is HttpOnly, SameSite=Strict and scoped to the auth routes', () => {
    const { response, cookie } = fakeResponse();
    setRefreshCookie(response, 'value', expires, false);
    expect(cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'value', {
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api/auth',
      expires,
    });
  });

  it('is Secure (HTTPS only) when told so', () => {
    const { response, cookie } = fakeResponse();
    setRefreshCookie(response, 'value', expires, true);
    expect(cookie.mock.calls[0]?.[2]).toMatchObject({ secure: true, httpOnly: true, sameSite: 'strict' });
  });

  it('is cleared with the same attributes it was set with, or browsers keep it', () => {
    const { response, clearCookie } = fakeResponse();
    clearRefreshCookie(response, true);
    expect(clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/auth',
    });
  });
});
