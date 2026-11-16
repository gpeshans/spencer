import 'server-only';

/**
 * The report engine's secrets, read from the environment on first use. A
 * missing one is named in the error; values are never logged.
 */
export interface ReportsEnv {
  anthropicApiKey: string;
  /** The pooler URL for reports_login (migration 0008), transaction mode. */
  databaseUrl: string;
  supabaseUrl: string;
  /** The secret key (sb_secret_...): the server writes runs and logs with it. */
  supabaseSecretKey: string;
  /** Signs the household scope; the same value is in Vault as reports_scope_key. */
  scopeKey: string;
}

const REQUIRED = {
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  databaseUrl: 'REPORTS_DATABASE_URL',
  supabaseUrl: 'NEXT_PUBLIC_SUPABASE_URL',
  supabaseSecretKey: 'SUPABASE_SECRET_KEY',
  scopeKey: 'REPORTS_SCOPE_KEY',
} as const satisfies Record<keyof ReportsEnv, string>;

export class ReportsNotConfigured extends Error {
  /** What is wrong, e.g. "SUPABASE_SECRET_KEY is missing"; never a value. */
  constructor(readonly problems: string[]) {
    super(`Reports aren't set up: ${problems.join('; ')}.`);
    this.name = 'ReportsNotConfigured';
  }
}

/** signScope's minimum; checked here so a short key is a setup error, not a failed run. */
const MIN_SCOPE_KEY_LENGTH = 32;

export function reportsEnv(): ReportsEnv {
  const problems = Object.values(REQUIRED)
    .filter((name) => !process.env[name]?.trim())
    .map((name) => `${name} is missing`);
  const scopeKey = process.env.REPORTS_SCOPE_KEY?.trim();
  if (scopeKey && scopeKey.length < MIN_SCOPE_KEY_LENGTH) {
    problems.push(`REPORTS_SCOPE_KEY must be at least ${MIN_SCOPE_KEY_LENGTH} characters`);
  }
  if (problems.length > 0) throw new ReportsNotConfigured(problems);
  return Object.fromEntries(
    Object.entries(REQUIRED).map(([key, name]) => [key, process.env[name]!.trim()]),
  ) as unknown as ReportsEnv;
}
