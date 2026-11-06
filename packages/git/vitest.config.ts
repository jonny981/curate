import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    globalSetup: ['../../scripts/test-cache.mjs'],
    // One test file at a time in one worker: the large-history specs
    // each build hundreds of megabytes, and two at once can exhaust memory.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
