import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types.js';
import type { LanguageModel } from '../../src/agent/model/language-model.js';
import type { Db } from '../../src/database/database.module.js';

/**
 * Starts the real application (same setup as production) against the database
 * named by process.env.DATABASE_URL. AppModule is imported here, after the
 * caller has pointed the environment at its private database, because the
 * configuration is read when the module is first imported.
 */
export async function startTestApp(options: { database?: Db; model?: LanguageModel } = {}): Promise<INestApplication<App>> {
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/app.setup.js');
  const { DB } = await import('../../src/database/database.module.js');
  const { LANGUAGE_MODEL } = await import('../../src/agent/model/language-model.js');

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.database) {
    builder = builder.overrideProvider(DB).useValue(options.database);
  }
  if (options.model) {
    builder = builder.overrideProvider(LANGUAGE_MODEL).useValue(options.model);
  }
  const app = (await builder.compile()).createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}
