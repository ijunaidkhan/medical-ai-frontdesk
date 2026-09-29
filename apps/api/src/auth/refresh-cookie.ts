import type { CookieOptions, Response } from 'express';

export const REFRESH_COOKIE_NAME = 'frontdesk_refresh';

/**
 * The cookie is only ever sent to the auth routes (Path), never to scripts
 * (HttpOnly), never cross-site (SameSite=Strict), and only over HTTPS in
 * production (Secure).
 */
function baseOptions(secure: boolean): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/api/auth' };
}

export function setRefreshCookie(response: Response, value: string, expires: Date, secure: boolean): void {
  response.cookie(REFRESH_COOKIE_NAME, value, { ...baseOptions(secure), expires });
}

export function clearRefreshCookie(response: Response, secure: boolean): void {
  response.clearCookie(REFRESH_COOKIE_NAME, baseOptions(secure));
}
