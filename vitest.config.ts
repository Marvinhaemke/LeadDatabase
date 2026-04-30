import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    globals: false,
  },
  resolve: {
    alias: {
      // Workspace package shortcuts so tests can import the same way
      // app code does. (vitest doesn't read package.json `exports` for
      // workspace deps the same way Next does.)
      'db/types': new URL('./packages/db/src/generated.ts', import.meta.url).pathname,
    },
  },
});
