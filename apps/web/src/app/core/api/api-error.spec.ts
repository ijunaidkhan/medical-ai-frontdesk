import { HttpErrorResponse } from '@angular/common/http';
import { errorMessage, httpStatusOf } from './api-error';

const failure = (status: number, error?: unknown) => new HttpErrorResponse({ status, error });

describe('httpStatusOf', () => {
  it('reads the status of an HTTP error, and nothing else', () => {
    expect(httpStatusOf(failure(403))).toBe(403);
    expect(httpStatusOf(new Error('x'))).toBeNull();
    expect(httpStatusOf('x')).toBeNull();
  });
});

describe('errorMessage', () => {
  it('tells the person when the server cannot be reached', () => {
    expect(errorMessage(failure(0))).toMatch(/Cannot reach the server/);
  });

  it.each([502, 503, 504])('says the service is not responding for a %i from a gateway', (status) => {
    expect(errorMessage(failure(status))).toBe('The service is not responding right now. Please try again in a moment.');
  });

  it('explains rate limiting', () => {
    expect(errorMessage(failure(429))).toMatch(/Too many requests/);
  });

  it('shows the API’s own message for client errors', () => {
    expect(errorMessage(failure(403, { statusCode: 403, message: 'You do not have permission to do that' }))).toBe(
      'You do not have permission to do that',
    );
  });

  it('shows the first validation message when there are several', () => {
    expect(errorMessage(failure(400, { message: ['email must be an email', 'password too long'] }))).toBe('email must be an email');
  });

  it('never repeats server error details, whatever they contain', () => {
    const message = errorMessage(failure(500, { message: 'connection to postgres://user:hunter2@db refused' }));
    expect(message).toBe('Something went wrong. Please try again.');
    expect(message).not.toContain('hunter2');
  });

  it.each([
    ['a non-HTTP error', new Error('boom')],
    ['a body with no message', failure(400, {})],
    ['a body that is a string', failure(400, 'oops')],
    ['a body with an empty message', failure(400, { message: '' })],
    ['a body with a non-text message', failure(400, { message: 42 })],
  ])('falls back for %s', (_label, error) => {
    expect(errorMessage(error)).toBe('Something went wrong. Please try again.');
  });

  it('uses a custom fallback', () => {
    expect(errorMessage(new Error('boom'), 'Could not save.')).toBe('Could not save.');
  });
});
