import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['scripts/test-cache.mjs'],
    // One test file at a time in one worker, as in each package.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
