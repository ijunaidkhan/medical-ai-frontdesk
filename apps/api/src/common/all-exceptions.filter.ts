import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../logging/logging.module.js';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId?: string;
}

/**
 * Converts every error into one predictable shape. Unexpected errors return a
 * generic 500 to the client while the details (with the request ID) go to the
 * logs, so stack traces and internals never leak.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    // Two requests that collide in the database (a deadlock, or a serialization
    // failure) are safe: PostgreSQL aborted one of them cleanly. Tell the client
    // to try again instead of reporting a server fault.
    const isRetryableConflict = !isHttpException && hasRetryableDatabaseCode(exception);
    const statusCode = isHttpException
      ? exception.getStatus()
      : isRetryableConflict
        ? HttpStatus.CONFLICT
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (isRetryableConflict) {
      this.logger.warn({ err: exception }, 'Request conflicted with another change in the database');
    } else if (!isHttpException || statusCode >= 500) {
      this.logger.error({ err: exception }, 'Unhandled exception');
    }

    const body: ErrorResponseBody = {
      statusCode,
      error: HttpStatus[statusCode]?.replaceAll('_', ' ').toLowerCase() ?? 'error',
      message: isRetryableConflict
        ? 'The request conflicted with another change. Please try again.'
        : isHttpException && statusCode < 500
          ? extractMessage(exception)
          : 'Internal server error',
      requestId: response.getHeader(REQUEST_ID_HEADER)?.toString() ?? request.id?.toString(),
    };

    response.status(statusCode).json(body);
  }
}

/** PostgreSQL 40001 = serialization_failure, 40P01 = deadlock_detected. */
const RETRYABLE_DATABASE_CODES: ReadonlySet<unknown> = new Set(['40001', '40P01']);

function hasRetryableDatabaseCode(exception: unknown): boolean {
  return typeof exception === 'object' && exception !== null && 'code' in exception && RETRYABLE_DATABASE_CODES.has(exception.code);
}

function extractMessage(exception: HttpException): string | string[] {
  const payload = exception.getResponse();
  if (typeof payload === 'string') {
    return payload;
  }
  const message = (payload as { message?: unknown }).message;
  if (typeof message === 'string' || Array.isArray(message)) {
    return message as string | string[];
  }
  return exception.message;
}
