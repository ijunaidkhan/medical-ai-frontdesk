import { HttpErrorResponse } from '@angular/common/http';

export function httpStatusOf(error: unknown): number | null {
  return error instanceof HttpErrorResponse ? error.status : null;
}

/**
 * Every message of a refusal that lists several (for example what still blocks
 * turning the AI on), or the single safe message otherwise.
 */
export function errorMessages(error: unknown, fallback?: string): string[] {
  if (httpStatusOf(error) !== null) {
    const body: unknown = (error as HttpErrorResponse).error;
    const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
    if (Array.isArray(message) && message.length > 0 && message.every((item) => typeof item === 'string')) {
      return message as string[];
    }
  }
  return [errorMessage(error, fallback)];
}

/**
 * A message safe to show a person. The API never puts internals in error
 * messages, but anything unexpected still falls back to a generic sentence.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const status = httpStatusOf(error);
  if (status === null) {
    return fallback;
  }
  if (status === 0) {
    return 'Cannot reach the server. Check your connection and try again.';
  }
  if (status === 429) {
    return 'Too many requests. Please wait a minute and try again.';
  }
  // Our own API sometimes says 503 on purpose and explains why (for example, "the AI model is not set up yet").
  // That explanation is written for people, so it is shown as it is.
  const ownMessage = (error as HttpErrorResponse).error as { message?: unknown } | string | null;
  if (status === 503 && typeof ownMessage === 'object' && ownMessage !== null && typeof ownMessage.message === 'string' && ownMessage.message.length > 0) {
    return ownMessage.message;
  }
  // A gateway in front of the API answered instead of the API: it is down or restarting.
  if (status === 502 || status === 503 || status === 504) {
    return 'The service is not responding right now. Please try again in a moment.';
  }
  if (status >= 500) {
    return fallback;
  }

  const body: unknown = (error as HttpErrorResponse).error;
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  if (typeof message === 'string' && message.length > 0) {
    return message;
  }
  if (Array.isArray(message) && typeof message[0] === 'string') {
    return message[0];
  }
  return fallback;
}
