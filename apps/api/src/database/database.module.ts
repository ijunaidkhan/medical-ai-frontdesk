import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from './database.types.js';

/** Injection token for the API's database connection (runtime role, subject to RLS). */
export const DB = Symbol('DB');
export type Db = Kysely<Database>;

export function createDatabase(connectionString: string): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    application_name: 'frontdesk-api',
  });
  // An error on an idle pooled client must not crash the process.
  pool.on('error', (error) => new Logger('Database').error(`Idle client error: ${error.message}`));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

@Global()
@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>): Db =>
        createDatabase(config.get('DATABASE_URL', { infer: true })),
    },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
