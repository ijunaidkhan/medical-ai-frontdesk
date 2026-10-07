import { defineConfig } from 'vitest/config';
import integration from './vitest.config.integration.js';

/**
 * Conversations with a REAL language model (`npm run eval:scheduling`). Not part of the normal test runs:
 * a real model is slow and answers a little differently every time, so this measures and reports
 * instead of passing or failing on wording. Safety rules are still checked on every run.
 * Same databases and environment as the integration tests; only the files and time limits differ.
 */
export default defineConfig({
  test: {
    ...integration.test,
    include: ['eval/**/*.eval.ts'],
    testTimeout: 60 * 60_000,
    hookTimeout: 120_000,
  },
});
