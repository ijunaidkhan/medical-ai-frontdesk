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
    const statusCode = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!isHttpException || statusCode >= 500) {
      this.logger.error({ err: exception }, 'Unhandled exception');
    }

    const body: ErrorResponseBody = {
      statusCode,
      error: HttpStatus[statusCode]?.replaceAll('_', ' ').toLowerCase() ?? 'error',
      message: isHttpException && statusCode < 500 ? extractMessage(exception) : 'Internal server error',
      requestId: response.getHeader(REQUEST_ID_HEADER)?.toString() ?? request.id?.toString(),
    };

    response.status(statusCode).json(body);
  }
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
