import { type ArgumentsHost, BadRequestException, NotFoundException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

function setup() {
  const logger = { setContext: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status, getHeader: vi.fn().mockReturnValue('req-id-12345') };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
  } as unknown as ArgumentsHost;
  return { filter: new AllExceptionsFilter(logger), logger, host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('passes client errors through in a consistent shape without logging them as errors', () => {
    const { filter, host, status, json, logger } = setup();

    filter.catch(new NotFoundException('Nothing here'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      statusCode: 404,
      error: 'not found',
      message: 'Nothing here',
      requestId: 'req-id-12345',
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps validation message arrays intact', () => {
    const { filter, host, json } = setup();

    filter.catch(new BadRequestException(['email must be an email']), host);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: ['email must be an email'] }),
    );
  });

  it('hides the details of unexpected errors from the client but logs them', () => {
    const { filter, host, status, json, logger } = setup();
    const failure = new Error('connection string postgres://user:hunter2@db/prod refused');

    filter.catch(failure, host);

    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0]?.[0] as { message: string };
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(logger.error).toHaveBeenCalledWith({ err: failure }, 'Unhandled exception');
  });

  describe('two requests colliding in the database', () => {
    it.each([
      ['a deadlock', '40P01'],
      ['a serialization failure', '40001'],
    ])('answers 409 "try again" for %s, without leaking details, and logs a warning not an error', (_label, code) => {
      const { filter, host, status, json, logger } = setup();
      const failure = Object.assign(new Error('deadlock detected: Process 123 waits for ShareLock on relation secret_table'), { code });

      filter.catch(failure, host);

      expect(status).toHaveBeenCalledWith(409);
      const body = json.mock.calls[0]?.[0] as { message: string; error: string };
      expect(body.message).toBe('The request conflicted with another change. Please try again.');
      expect(body.error).toBe('conflict');
      expect(JSON.stringify(body)).not.toContain('secret_table');
      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('still treats other database errors as server faults', () => {
      const { filter, host, status } = setup();
      filter.catch(Object.assign(new Error('boom'), { code: '57P01' }), host);
      expect(status).toHaveBeenCalledWith(500);
    });
  });
});
