import { defineConfig } from 'vitest/config';
import { testDatabaseUrls } from './test/support/test-database.js';

const urls = testDatabaseUrls();

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    // All files share one database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    // Set before test files import AppModule, because ConfigModule validates at import time.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGINS: '',
      DATABASE_URL: urls.app,
      MIGRATION_DATABASE_URL: urls.owner,
    },
  },
});
