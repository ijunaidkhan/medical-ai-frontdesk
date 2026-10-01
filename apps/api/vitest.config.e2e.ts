import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // Must be set before test files import AppModule, because ConfigModule
    // validates the environment at import time.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGINS: 'http://localhost:4200',
      // These tests never query the database (the pool connects lazily), so a
      // placeholder is enough. Database behaviour is covered by the integration tests.
      DATABASE_URL: 'postgres://frontdesk_app:placeholder@127.0.0.1:1/unused',
      // Test-only key. Not a real secret.
      ACCESS_TOKEN_SECRET: 'e2e-tests-only-signing-key-0123456789abcdef',
      // Never inherit a developer's personal AI model or phone settings.
      LLM_PROVIDER: 'none',
      ANTHROPIC_API_KEY: '',
      VOICE_PROVIDER: 'none',
      TWILIO_AUTH_TOKEN: '',
      PUBLIC_BASE_URL: '',
    },
  },
});
