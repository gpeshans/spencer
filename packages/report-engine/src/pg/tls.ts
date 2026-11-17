import { isIPv4 } from 'node:net';

import postgres from 'postgres';

/**
 * The executor's TLS rules.
 *
 * 1. A connection that leaves this machine is encrypted. postgres.js connects
 *    in plain text unless the URL (or PGSSLMODE) asks for TLS, and its `prefer`
 *    and `allow` modes fall back to plain text when the server declines. So
 *    unless a connection stays on this machine (a Unix socket, localhost or a
 *    loopback address), its mode must be require, verify-ca or verify-full.
 * 2. Given certificates to trust, such a connection also verifies the server:
 *    its certificate must chain to one of them and name the host (libpq's
 *    verify-full). `require` alone encrypts but accepts any certificate.
 *
 * Both read the options postgres.js resolves from the URL and the environment,
 * so they judge the hosts and the mode the driver will really use.
 */

type Resolved = Pick<postgres.ParsedOptions, 'host' | 'path' | 'ssl'>;

/** Modes in which postgres.js stops rather than go on without TLS. */
const ENCRYPTED: ReadonlySet<unknown> = new Set(['require', 'verify-ca', 'verify-full', 'true', true]);

const isLocal = (host: string) =>
  host.toLowerCase() === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'));

/** Whether every connection stays on this machine: a Unix socket, or only local hosts. */
export function staysLocal({ host, path }: Pick<Resolved, 'host' | 'path'>): boolean {
  // A path means a Unix socket, which every connection then uses.
  return Boolean(path) || host.every(isLocal);
}

/** Why these resolved options could reach a remote server in plain text, or null when they can't. */
export function plainTextProblem({ host, path, ssl }: Resolved): string | null {
  if (staysLocal({ host, path })) return null;
  // Certificate files turn the mode into TLS options, which never fall back.
  if (ENCRYPTED.has(ssl) || (typeof ssl === 'object' && ssl !== null)) return null;
  return !ssl || ssl === 'disable'
    ? 'would reach a remote host in plain text; add sslmode=require (or verify-full) to it'
    : `asks for TLS mode "${String(ssl)}"; a remote host needs sslmode=require, verify-ca or verify-full`;
}

/** The options postgres.js resolves from a URL and the environment. */
function resolve(url: string): Resolved {
  // postgres() only parses here: it connects on the first query, and none runs.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const { host, path, ssl } = sql.options;
  void sql.end({ timeout: 0 });
  return { host, path, ssl };
}

/** Why a connection URL could reach a remote server in plain text, or null when it can't. */
export function tlsProblem(url: string): string | null {
  return plainTextProblem(resolve(url));
}

/** postgres.js TLS options that verify the server's certificate against chosen roots. */
export interface TrustedSsl {
  ca: string[];
  rejectUnauthorized: true;
}

/**
 * The TLS options that make a connection to a remote server verify it: its
 * certificate must chain to one of `ca` and name the host (libpq's
 * verify-full), whatever the URL's sslmode says. Pass them as postgres.js's
 * `ssl` option. Undefined without `ca`, or when the connection stays on this
 * machine, where the URL's own mode stands (a local database without TLS).
 */
export function trustedSsl(url: string, ca: string | readonly string[] | undefined): TrustedSsl | undefined {
  const roots = typeof ca === 'string' ? [ca] : [...(ca ?? [])];
  if (roots.length === 0 || staysLocal(resolve(url))) return undefined;
  return { ca: roots, rejectUnauthorized: true };
}
