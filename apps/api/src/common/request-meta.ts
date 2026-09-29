import type { Request } from 'express';

/** Request details recorded with security-relevant events. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export function requestMeta(request: Request): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
    requestId: request.id !== undefined ? String(request.id) : null,
  };
}
