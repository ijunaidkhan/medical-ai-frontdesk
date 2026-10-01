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
      // The test setup reads the developer's .env for the database address, which would also leak their
      // personal AI model and phone settings into the tests. These are pinned to "off" so a test run behaves
      // the same on every machine; a test that needs one of them sets it for itself.
      LLM_PROVIDER: 'none',
      ANTHROPIC_API_KEY: '',
      VOICE_PROVIDER: 'none',
      TWILIO_AUTH_TOKEN: '',
      PUBLIC_BASE_URL: '',
      VOICE_TTS_PROVIDER: '',
      VOICE_STT_PROVIDER: '',
    },
  },
});
