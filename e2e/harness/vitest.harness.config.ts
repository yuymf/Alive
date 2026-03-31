import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['e2e/harness/suites/**/*.test.ts'],
    globals: true,
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Force all suite files to run sequentially and in alphabetical order
    fileParallelism: false,
    sequence: {
      sequential: true,
      // Sort files alphabetically so 01→02→03→04→05
      sequencer: class {
        async shard(files: any[]) { return files; }
        async sort(files: any[]) {
          return [...files].sort((a, b) => {
            const nameA = typeof a === 'string' ? a : a.id || a.filepath || '';
            const nameB = typeof b === 'string' ? b : b.id || b.filepath || '';
            return String(nameA).localeCompare(String(nameB));
          });
        }
      },
    },
  },
});
