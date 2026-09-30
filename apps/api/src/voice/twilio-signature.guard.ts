import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { isValidTwilioSignature, type TwilioParams } from './twilio-signature.js';

/**
 * Turns a parsed request body into Twilio parameters, or null when it holds
 * anything Twilio would not send (nested objects, numbers): such a request is
 * refused rather than interpreted.
 */
export function toTwilioParams(body: unknown): TwilioParams | null {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  const params: TwilioParams = {};
  for (const [name, value] of Object.entries(body)) {
    if (typeof value === 'string') params[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) params[name] = value as string[];
    else return null;
  }
  return params;
}

/**
 * Guards every /api/voice route. These routes are public (no login: Twilio is the
 * caller), so the proof that a request is genuine is Twilio's signature:
 *
 *  - Voice switched off (VOICE_PROVIDER=none): the routes do not exist (404).
 *  - No signature, a wrong one, a different token, a changed address or a changed
 *    parameter: 403, and nothing else runs.
 *
 * The address that was signed is built from PUBLIC_BASE_URL plus the path Twilio
 * requested, never from the Host or forwarding headers, which a caller controls.
 */
@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TwilioSignatureGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const provider = this.config.get('VOICE_PROVIDER', { infer: true });
    const token = this.config.get('TWILIO_AUTH_TOKEN', { infer: true });
    const baseUrl = this.config.get('PUBLIC_BASE_URL', { infer: true });
    if (provider !== 'twilio' || !token || !baseUrl) {
      throw new NotFoundException();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['x-twilio-signature'];
    const params = toTwilioParams(request.body);
    const valid = params !== null && isValidTwilioSignature(token, typeof header === 'string' ? header : undefined, `${baseUrl}${request.originalUrl}`, params);
    if (!valid) {
      // Path and address only: never the parameters, which hold callers' phone numbers.
      this.logger.warn({ path: request.path, ip: request.ip, hasSignature: typeof header === 'string' }, 'Rejected a voice request: missing or wrong Twilio signature');
      throw new ForbiddenException();
    }
    return true;
  }
}
