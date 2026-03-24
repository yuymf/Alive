import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['alive/tests/**/*.test.ts'],
    globals: true,
  },
});
