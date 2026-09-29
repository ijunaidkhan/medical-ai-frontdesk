import type { INestApplication } from '@nestjs/common';
import type { AuthSession } from '@frontdesk/shared';
import request from 'supertest';
import type { Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { TEST_PASSWORD } from './fixtures.js';

export const WEB_ORIGIN = 'http://localhost:4200';
export const COOKIE_NAME = 'frontdesk_refresh';
export const GENERIC_LOGIN_ERROR = 'Invalid email or password';

let counter = 0;
/** A distinct client IP per call, so per-IP rate limits never couple unrelated tests. */
export function uniqueIp(): string {
  counter += 1;
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
}

export type TestApp = INestApplication<App>;

/** The refresh cookie's raw Set-Cookie line, if the response sets or clears it. */
export function setCookieLine(res: Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  return header?.find((line) => line.startsWith(`${COOKIE_NAME}=`));
}

/** The refresh token value set by a response, or undefined if none (or if it is being cleared). */
export function cookieValue(res: Response): string | undefined {
  const value = setCookieLine(res)?.slice(COOKIE_NAME.length + 1).split(';')[0];
  return value ? decodeURIComponent(value) : undefined;
}

export function isCleared(res: Response): boolean {
  const line = setCookieLine(res);
  return line !== undefined && line.startsWith(`${COOKIE_NAME}=;`) && /Expires=Thu, 01 Jan 1970/i.test(line);
}

export interface Credentials {
  email: string;
  password?: string;
  practiceId?: string;
}

export function loginRequest(app: TestApp, credentials: Credentials, ip = uniqueIp()) {
  return request(app.getHttpServer())
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ email: credentials.email, password: credentials.password ?? TEST_PASSWORD, practiceId: credentials.practiceId });
}

/** Signs in and returns the session plus the refresh cookie value. Fails the test if login is refused. */
export async function signIn(app: TestApp, credentials: Credentials): Promise<{ session: AuthSession; cookie: string }> {
  const res = await loginRequest(app, credentials).expect(200);
  const cookie = cookieValue(res);
  if (!cookie) {
    throw new Error('login did not set a refresh cookie');
  }
  return { session: res.body as AuthSession, cookie };
}

export function refreshRequest(app: TestApp, cookie: string | undefined, options: { origin?: string | null; ip?: string } = {}) {
  let req = request(app.getHttpServer()).post('/api/auth/refresh').set('X-Forwarded-For', options.ip ?? uniqueIp());
  if (options.origin !== null) {
    req = req.set('Origin', options.origin ?? WEB_ORIGIN);
  }
  return cookie === undefined ? req : req.set('Cookie', `${COOKIE_NAME}=${cookie}`);
}

export function logoutRequest(app: TestApp, cookie: string | undefined, options: { origin?: string | null } = {}) {
  let req = request(app.getHttpServer()).post('/api/auth/logout').set('X-Forwarded-For', uniqueIp());
  if (options.origin !== null) {
    req = req.set('Origin', options.origin ?? WEB_ORIGIN);
  }
  return cookie === undefined ? req : req.set('Cookie', `${COOKIE_NAME}=${cookie}`);
}

export function meRequest(app: TestApp, accessToken: string) {
  return request(app.getHttpServer()).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);
}

export function switchRequest(app: TestApp, accessToken: string, practiceId: unknown) {
  return request(app.getHttpServer())
    .post('/api/auth/switch-practice')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ practiceId });
}
