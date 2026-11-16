import { createHmac } from 'node:crypto';

/**
 * Signs the value the executor puts in the `reports.scope` setting at the
 * start of every report transaction (docs/report-engine-spec.md §5.2).
 *
 * Format: `<tenantId>.<expiresAtUnix>.<runId>.<hmacHex>`. The HMAC-SHA256
 * covers the first three parts and uses the same key the database reads from
 * Supabase Vault in `reporting.scope_group_id()`, so a query running inside
 * that transaction cannot forge a scope for another tenant.
 */
export interface SignScopeInput {
  /** The tenant (in spencer: the household) the run may read. */
  tenantId: string;
  /** The run this scope belongs to. */
  runId: string;
  /** Shared secret, also stored in Vault as `reports_scope_key`. */
  key: string;
  /** How long the database accepts the scope. Default 300 s, at most 3600 s. */
  ttlSeconds?: number;
  /** Clock override for tests. */
  now?: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_KEY_LENGTH = 32;
const MAX_TTL_SECONDS = 3600;

export function signScope({
  tenantId,
  runId,
  key,
  ttlSeconds = 300,
  now = new Date(),
}: SignScopeInput): string {
  if (!UUID.test(tenantId)) throw new Error('signScope: tenantId must be a lowercase UUID');
  if (!UUID.test(runId)) throw new Error('signScope: runId must be a lowercase UUID');
  if (key.length < MIN_KEY_LENGTH) {
    throw new Error(`signScope: key must be at least ${MIN_KEY_LENGTH} characters`);
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`signScope: ttlSeconds must be an integer from 1 to ${MAX_TTL_SECONDS}`);
  }

  const expiresAt = Math.floor(now.getTime() / 1000) + ttlSeconds;
  const payload = `${tenantId}.${expiresAt}.${runId}`;
  const signature = createHmac('sha256', key).update(payload).digest('hex');
  return `${payload}.${signature}`;
}
