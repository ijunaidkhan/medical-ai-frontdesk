import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { LivenessResponse, ReadinessResponse } from '@frontdesk/shared';
import { sql } from 'kysely';
import { PinoLogger } from 'nestjs-pino';
import type { Response } from 'express';
import { DB, type Db } from '../database/database.module.js';

const READINESS_TIMEOUT_MS = 2_000;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HealthController.name);
  }

  /** Liveness: the process is running and able to answer HTTP. No dependencies are checked. */
  @Get('live')
  live(): LivenessResponse {
    return { status: 'ok' };
  }

  /**
   * Readiness: the API can reach its database. Returns 503 otherwise so a load
   * balancer stops sending traffic. Reveals no connection details.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    const database = await this.checkDatabase();
    const status = database === 'up' ? 'ok' : 'unavailable';
    response.status(status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status, checks: { database } };
  }

  private async checkDatabase(): Promise<'up' | 'down'> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('database check timed out')), READINESS_TIMEOUT_MS);
      });
      await Promise.race([sql`select 1`.execute(this.db), timeout]);
      return 'up';
    } catch (error) {
      this.logger.error({ err: error }, 'Readiness check: database unavailable');
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
