import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The capture tests connect a real inspector session to the test process,
    // which requires a plain child process rather than a worker thread.
    pool: 'forks',
    testTimeout: 20000,
  },
})
