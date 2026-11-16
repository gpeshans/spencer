import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      // Unit tests of each workspace package (packages/*/vitest.config.ts).
      'packages/*',
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
