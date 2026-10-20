import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // `node:sqlite` is a built-in, and Vite's resolver tries to load it as
        // a package unless it is told it is external. The load test needs it:
        // it runs the generated SQL against a real SQLite, which is what D1 is.
        external: ['node:sqlite'],
      },
    },
  },
});
