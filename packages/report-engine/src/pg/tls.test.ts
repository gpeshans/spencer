import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSqlGuard } from '../sql-guard';
import { createPgExecutor } from './executor';
import { staysLocal, tlsProblem, trustedSsl } from './tls';

const REMOTE = 'postgres://reports_login.ref:s3cret-pw@pooler.example.com:6543/postgres';
const PLAIN = 'would reach a remote host in plain text; add sslmode=require (or verify-full) to it';

// The driver reads these too; the tests mustn't depend on the shell's.
beforeEach(() => {
  vi.stubEnv('PGHOST', undefined);
  vi.stubEnv('PGSSLMODE', undefined);
  vi.stubEnv('PGSSL', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('tlsProblem', () => {
  it.each(['sslmode=require', 'sslmode=verify-ca', 'sslmode=verify-full', 'ssl=true', 'ssl=require', 'sslrootcert=system'])(
    'accepts a remote host with %s',
    (param) => expect(tlsProblem(`${REMOTE}?${param}`)).toBeNull(),
  );

  it.each([
    'postgres://u:p@localhost:5432/db',
    'postgres://u:p@LocalHost/db',
    'postgres://u:p@127.0.0.1:54321/postgres?sslmode=disable',
    'postgres://u:p@127.1.2.3/db',
    'postgres://u:p@[::1]:5432/db',
    'postgres://u:p@localhost:5432,127.0.0.1:5433/db',
    'postgres://u:p@%2Fvar%2Frun%2Fpostgresql/db',
    'postgres://u:p@db.example.com/db?host=/var/run/postgresql',
  ])('lets %s go without TLS: it stays on this machine', (url) => expect(tlsProblem(url)).toBeNull());

  it('refuses a remote host without TLS', () => {
    expect(tlsProblem(REMOTE)).toBe(PLAIN);
    expect(tlsProblem(`${REMOTE}?sslmode=disable`)).toBe(PLAIN);
    expect(tlsProblem(`${REMOTE}?ssl=false`)).toBe(PLAIN);
  });

  it.each(['prefer', 'allow', 'Require'])('refuses sslmode=%s, which it can’t vouch for', (mode) => {
    expect(tlsProblem(`${REMOTE}?sslmode=${mode}`)).toBe(
      `asks for TLS mode "${mode}"; a remote host needs sslmode=require, verify-ca or verify-full`,
    );
  });

  it('needs every host to stay on this machine', () => {
    expect(tlsProblem('postgres://u:p@localhost,db.example.com/db')).toBe(PLAIN);
  });

  it('reads the URL the way the driver does', () => {
    // A host parameter replaces the hosts before the path.
    expect(tlsProblem('postgres://u:p@localhost/db?host=db.example.com')).toBe(PLAIN);
    // The last @ ends the user info, so a password can't pose as the host.
    expect(tlsProblem('postgres://u:p@localhost@db.example.com/db')).toBe(PLAIN);
    // A repeated parameter keeps its last value.
    expect(tlsProblem(`${REMOTE}?sslmode=require&sslmode=disable`)).toBe(PLAIN);
    expect(tlsProblem(`${REMOTE}?sslmode=disable&sslmode=require`)).toBeNull();
  });

  it('follows the environment the driver falls back to', () => {
    vi.stubEnv('PGSSLMODE', 'require');
    expect(tlsProblem(REMOTE)).toBeNull();
    vi.stubEnv('PGSSLMODE', undefined);
    vi.stubEnv('PGHOST', 'db.example.com');
    expect(tlsProblem('postgres://u:p@/db')).toBe(PLAIN);
  });

  it('never repeats the user or the password', () => {
    for (const url of [REMOTE, `${REMOTE}?sslmode=prefer`]) {
      expect(tlsProblem(url)).not.toMatch(/reports_login|s3cret/);
    }
  });
});

describe('trustedSsl', () => {
  const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

  it('verifies a remote server against the given roots, whatever the URL asks', () => {
    for (const url of [REMOTE, `${REMOTE}?sslmode=require`, `${REMOTE}?sslmode=verify-full`, `${REMOTE}?sslmode=disable`]) {
      expect(trustedSsl(url, CA)).toEqual({ ca: [CA], rejectUnauthorized: true });
    }
    expect(trustedSsl(REMOTE, [CA, CA])).toEqual({ ca: [CA, CA], rejectUnauthorized: true });
  });

  it('leaves a connection that stays on this machine to its URL', () => {
    for (const url of ['postgres://u:p@localhost:5432/db', 'postgres://u:p@127.0.0.1/db', 'postgres://u:p@%2Fvar%2Frun%2Fpostgresql/db']) {
      expect(trustedSsl(url, CA)).toBeUndefined();
    }
  });

  it('does nothing without roots', () => {
    expect(trustedSsl(REMOTE, undefined)).toBeUndefined();
    expect(trustedSsl(REMOTE, [])).toBeUndefined();
  });

  it('reads the hosts the way the driver does', () => {
    // A host parameter replaces the hosts before the path, both ways.
    expect(trustedSsl('postgres://u:p@localhost/db?host=db.example.com', CA)).toBeDefined();
    expect(trustedSsl('postgres://u:p@db.example.com/db?host=localhost', CA)).toBeUndefined();
    vi.stubEnv('PGHOST', 'db.example.com');
    expect(trustedSsl('postgres://u:p@/db', CA)).toBeDefined();
  });

  it('knows which connections stay local', () => {
    expect(staysLocal({ host: ['localhost', '127.0.0.2'], path: false })).toBe(true);
    expect(staysLocal({ host: ['localhost', 'db.example.com'], path: false })).toBe(false);
    expect(staysLocal({ host: ['db.example.com'], path: '/var/run/postgresql/.s.PGSQL.5432' })).toBe(true);
  });
});

describe('createPgExecutor', () => {
  const guard = createSqlGuard({ relations: ['reporting.spendings'] });

  it('refuses a URL that could reach a remote host in plain text', () => {
    expect(() => createPgExecutor({ url: REMOTE, role: 'reports_reader', guard })).toThrow(
      `pg executor: the connection URL ${PLAIN}.`,
    );
  });

  it('accepts a remote host over TLS, without connecting yet', async () => {
    const executor = createPgExecutor({ url: `${REMOTE}?sslmode=require`, role: 'reports_reader', guard });
    await executor.close();
  });

  it('takes roots to verify the server with, still without connecting', async () => {
    const executor = createPgExecutor({ url: `${REMOTE}?sslmode=require`, ca: '-----BEGIN CERTIFICATE-----\n', role: 'reports_reader', guard });
    await executor.close();
  });
});
