import { afterEach, describe, expect, it, vi } from 'vitest';

import { reportsEnv, ReportsNotConfigured } from './env';

const ALL = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  REPORTS_DATABASE_URL: 'postgres://reports_login.ref:pw@localhost:6543/postgres',
  NEXT_PUBLIC_SUPABASE_URL: 'https://ref.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  REPORTS_SCOPE_KEY: 'k'.repeat(64),
};

const withEnv = (values: Partial<Record<keyof typeof ALL, string>>) => {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
};

afterEach(() => vi.unstubAllEnvs());

describe('reportsEnv', () => {
  it('reads every secret, trimmed', () => {
    withEnv({ ...ALL, ANTHROPIC_API_KEY: '  sk-ant-test \n' });
    expect(reportsEnv()).toMatchObject({ anthropicApiKey: 'sk-ant-test', scopeKey: 'k'.repeat(64) });
  });

  it('names what is missing or wrong, never a value', () => {
    withEnv({ ...ALL, SUPABASE_SECRET_KEY: '', REPORTS_SCOPE_KEY: 'short-secret' });
    const error = (() => {
      try {
        reportsEnv();
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ReportsNotConfigured);
    expect((error as Error).message).toBe(
      "Reports aren't set up: SUPABASE_SECRET_KEY is missing; REPORTS_SCOPE_KEY must be at least 32 characters.",
    );
    expect((error as Error).message).not.toContain('short-secret');
  });
});
