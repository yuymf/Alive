import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['e2e/**/*.test.ts'],
    globals: true,
    testTimeout: 3600000,
  },
});
