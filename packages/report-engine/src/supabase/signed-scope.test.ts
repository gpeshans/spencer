import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { signScope } from './signed-scope';

const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN = '9b2f6d1e-4c3a-4f8e-9d0a-1b2c3d4e5f60';
const KEY = 'k'.repeat(64);
const NOW = new Date('2026-11-16T12:00:00Z');

describe('signScope', () => {
  it('produces tenant.expiry.run.signature', () => {
    const scope = signScope({ tenantId: TENANT, runId: RUN, key: KEY, ttlSeconds: 300, now: NOW });
    const [tenant, expiresAt, run, signature] = scope.split('.');

    expect(tenant).toBe(TENANT);
    expect(Number(expiresAt)).toBe(NOW.getTime() / 1000 + 300);
    expect(run).toBe(RUN);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs exactly the first three parts with HMAC-SHA256', () => {
    const scope = signScope({ tenantId: TENANT, runId: RUN, key: KEY, now: NOW });
    const payload = scope.slice(0, scope.lastIndexOf('.'));
    const expected = createHmac('sha256', KEY).update(payload).digest('hex');

    expect(scope.endsWith(`.${expected}`)).toBe(true);
  });

  it('changes the signature when the key changes', () => {
    const a = signScope({ tenantId: TENANT, runId: RUN, key: KEY, now: NOW });
    const b = signScope({ tenantId: TENANT, runId: RUN, key: 'x'.repeat(64), now: NOW });

    expect(a).not.toBe(b);
  });

  it('rejects malformed input', () => {
    expect(() => signScope({ tenantId: 'not-a-uuid', runId: RUN, key: KEY })).toThrow(/tenantId/);
    expect(() => signScope({ tenantId: RUN.toUpperCase(), runId: RUN, key: KEY })).toThrow(/tenantId/);
    expect(() => signScope({ tenantId: TENANT, runId: 'run-1', key: KEY })).toThrow(/runId/);
    expect(() => signScope({ tenantId: TENANT, runId: RUN, key: 'short' })).toThrow(/key/);
    expect(() => signScope({ tenantId: TENANT, runId: RUN, key: KEY, ttlSeconds: 0 })).toThrow(/ttlSeconds/);
    expect(() => signScope({ tenantId: TENANT, runId: RUN, key: KEY, ttlSeconds: 7200 })).toThrow(/ttlSeconds/);
  });
});
