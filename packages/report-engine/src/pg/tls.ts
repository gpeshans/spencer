import { isIPv4 } from 'node:net';

import postgres from 'postgres';

/**
 * The executor's TLS rule: a connection that leaves this machine is encrypted.
 *
 * postgres.js connects in plain text unless the URL (or PGSSLMODE) asks for
 * TLS, and its `prefer` and `allow` modes fall back to plain text when the
 * server declines. So unless a connection stays on this machine (a Unix
 * socket, localhost or a loopback address), its mode must be require,
 * verify-ca or verify-full.
 *
 * The rule reads the options postgres.js resolves from the URL and the
 * environment, so it judges the hosts and the mode the driver will really use.
 */

type Resolved = Pick<postgres.ParsedOptions, 'host' | 'path' | 'ssl'>;

/** Modes in which postgres.js stops rather than go on without TLS. */
const ENCRYPTED: ReadonlySet<unknown> = new Set(['require', 'verify-ca', 'verify-full', 'true', true]);

const isLocal = (host: string) =>
  host.toLowerCase() === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'));

/** Why these resolved options could reach a remote server in plain text, or null when they can't. */
export function plainTextProblem({ host, path, ssl }: Resolved): string | null {
  // A path means a Unix socket, which every connection then uses.
  if (path || host.every(isLocal)) return null;
  // Certificate files turn the mode into TLS options, which never fall back.
  if (ENCRYPTED.has(ssl) || (typeof ssl === 'object' && ssl !== null)) return null;
  return !ssl || ssl === 'disable'
    ? 'would reach a remote host in plain text; add sslmode=require (or verify-full) to it'
    : `asks for TLS mode "${String(ssl)}"; a remote host needs sslmode=require, verify-ca or verify-full`;
}

/** Why a connection URL could reach a remote server in plain text, or null when it can't. */
export function tlsProblem(url: string): string | null {
  // postgres() only parses here: it connects on the first query, and none runs.
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const problem = plainTextProblem(sql.options);
  void sql.end({ timeout: 0 });
  return problem;
}
