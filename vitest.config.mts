import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      // Unit tests of each workspace package (packages/*/vitest.config.ts).
      'packages/*',
      // spencer's own server code (lib/), outside of Next.js.
      {
        resolve: {
          alias: [
            { find: /^@\//, replacement: root },
            // `server-only` throws unless Next.js builds the code for the server.
            { find: /^server-only$/, replacement: fileURLToPath(new URL('node_modules/server-only/empty.js', import.meta.url)) },
          ],
        },
        test: {
          name: 'app',
          include: ['lib/**/*.test.ts', 'components/**/*.test.tsx', 'evals/**/*.test.ts'],
        },
      },
      // spencer's database tests: migrations on a throwaway local Postgres.
      // They skip themselves when Docker isn't available.
      {
        test: {
          name: 'db',
          include: ['tests/db/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
