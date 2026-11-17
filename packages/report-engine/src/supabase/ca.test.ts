import { X509Certificate } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SUPABASE_ROOT_CA_2021 } from './ca';

const FINGERPRINT = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';

describe('SUPABASE_ROOT_CA_2021', () => {
  const cert = new X509Certificate(SUPABASE_ROOT_CA_2021);

  it('is exactly the root Supabase publishes and its poolers send', () => {
    expect(cert.fingerprint256).toBe(FINGERPRINT);
    expect(cert.subject).toContain('CN=Supabase Root 2021 CA');
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.ca).toBe(true);
    expect(SUPABASE_ROOT_CA_2021.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });

  it('has half a year left at least: renew it before it runs out', () => {
    const left = Date.parse(cert.validTo) - Date.now();
    expect(left, `Supabase Root 2021 CA expires ${cert.validTo}; fetch its successor (prod-ca-*.crt)`).toBeGreaterThan(180 * 86_400_000);
  });
});
