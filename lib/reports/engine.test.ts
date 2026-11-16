import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reportEngine } from './engine';
import { ReportsNotConfigured } from './env';

const REMOTE = 'postgres://reports_login.ref:s3cret-pw@pooler.example.com:6543/postgres';

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://ref.supabase.co');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test');
  vi.stubEnv('REPORTS_SCOPE_KEY', 'k'.repeat(64));
  // The driver reads these too; the tests mustn't depend on the shell's.
  for (const name of ['PGHOST', 'PGSSLMODE', 'PGSSL']) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('reportEngine', () => {
  it('treats a database URL without TLS as a setup error that names the variable', () => {
    vi.stubEnv('REPORTS_DATABASE_URL', REMOTE);
    expect(() => reportEngine()).toThrow(ReportsNotConfigured);
    expect(() => reportEngine()).toThrow(
      "Reports aren't set up: REPORTS_DATABASE_URL would reach a remote host in plain text; add sslmode=require (or verify-full) to it.",
    );
  });

  it('builds once the URL asks for TLS', async () => {
    vi.stubEnv('REPORTS_DATABASE_URL', `${REMOTE}?sslmode=require`);
    const engine = reportEngine();
    expect(engine.model.relations.length).toBeGreaterThan(0);
    await engine.executor.close();
  });
});
