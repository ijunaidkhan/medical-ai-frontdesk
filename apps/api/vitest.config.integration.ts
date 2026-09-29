import { defineConfig } from 'vitest/config';
import { baseUrls, TEMPLATE_DATABASE, withDatabase } from './test/support/test-database.js';

const urls = baseUrls();

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.int-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    // Files are isolated by private databases, but hashing passwords is CPU heavy: keep it predictable.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Set before test files import AppModule, because ConfigModule validates at import time.
    // Each file replaces the database name with its own private database (see createIsolatedDatabase).
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGINS: 'http://localhost:4200',
      DATABASE_URL: withDatabase(urls.app, TEMPLATE_DATABASE),
      MIGRATION_DATABASE_URL: withDatabase(urls.owner, TEMPLATE_DATABASE),
      // Test-only key for throwaway databases. Not a real secret.
      ACCESS_TOKEN_SECRET: 'integration-tests-only-signing-key-0123456789',
      // Lets tests pose as different client IPs (X-Forwarded-For) so that per-IP
      // rate limits do not couple unrelated tests.
      TRUST_PROXY_HOPS: '1',
    },
  },
});
