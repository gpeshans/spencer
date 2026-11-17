import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { trustedSsl } from './tls';

/**
 * Real TLS handshakes through postgres.js, against a fake Postgres server: it
 * answers the SSLRequest, does TLS, then refuses the login with a message of
 * its own. Seeing that message means the handshake (and its checks) passed.
 * The certificates are made here with openssl, so no key is committed.
 */

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const HANDSHAKE_OK = 'fake server: the TLS handshake passed';

/** A Postgres ErrorResponse: 'E', its length, then fields, each a type byte and a C string. */
function errorResponse(message: string): Buffer {
  const field = (type: string, value: string) => Buffer.from(`${type}${value}\0`);
  const body = Buffer.concat([field('S', 'FATAL'), field('V', 'FATAL'), field('C', '28000'), field('M', message), Buffer.from([0])]);
  const head = Buffer.alloc(5);
  head.write('E', 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

describe.skipIf(!hasOpenssl)('verifying the server, through postgres.js', () => {
  let dir: string;
  let server: net.Server;
  let port: number;
  const pem: Record<string, string> = {};
  /** The certificate the fake server presents. */
  let presenting = { key: '', cert: '' };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pg-tls-'));
    const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    // Two CAs, with the extensions a CA needs (LibreSSL and OpenSSL both take -addext).
    for (const name of ['root', 'stranger']) {
      openssl(
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2',
        '-subj', `/CN=Test ${name} CA`,
        '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      );
    }
    // Two server certificates from the root: one naming localhost, one naming another host.
    for (const [name, host] of [['local', 'localhost'], ['elsewhere', 'db.example.com']] as const) {
      openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${host}`);
      writeFileSync(
        path.join(dir, `${name}.ext`),
        `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      );
      openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`);
    }
    for (const name of ['root', 'stranger', 'local', 'elsewhere']) {
      pem[name] = readFileSync(path.join(dir, `${name}.pem`), 'utf8');
      pem[`${name}.key`] = readFileSync(path.join(dir, `${name}.key`), 'utf8');
    }

    server = net.createServer((socket) => {
      socket.on('error', () => {});
      // The SSLRequest: say yes, then do TLS on the same socket.
      socket.once('data', () => {
        socket.write('S');
        const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(presenting) });
        secure.on('error', () => {});
        // The startup message: refuse it, with a message the test can see.
        secure.once('data', () => secure.end(errorResponse(HANDSHAKE_OK)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Connects to the fake server as `localhost`, and says how it ended. */
  async function connect(ssl: postgres.Options<Record<string, never>>['ssl']): Promise<string> {
    const sql = postgres(`postgres://u:p@localhost:${port}/db`, { ssl, max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      await sql`select 1`;
      return 'connected';
    } catch (error) {
      return (error as Error).message;
    } finally {
      await sql.end({ timeout: 0 });
    }
  }

  /** What trustedSsl gives a remote server, here used for a local one. */
  const verifyingWith = (ca: string) => trustedSsl('postgres://u:p@db.example.com/db', ca)!;

  it("passes a server whose certificate chains to the root and names the host", async () => {
    presenting = { key: pem['local.key']!, cert: pem.local! };
    expect(await connect(verifyingWith(pem.root!))).toBe(HANDSHAKE_OK);
  });

  it("stops at a server whose certificate chains to another root", async () => {
    presenting = { key: pem['local.key']!, cert: pem.local! };
    expect(await connect(verifyingWith(pem.stranger!))).toMatch(
      /unable to get local issuer certificate|unable to verify the first certificate|self[- ]signed certificate in certificate chain/,
    );
  });

  it('stops at a certificate for another host, even from the right root', async () => {
    presenting = { key: pem['elsewhere.key']!, cert: pem.elsewhere! };
    expect(await connect(verifyingWith(pem.root!))).toMatch(/does not match certificate's altnames/);
  });

  it('accepts any certificate with sslmode=require alone: encrypted, not verified', async () => {
    presenting = { key: pem['elsewhere.key']!, cert: pem.elsewhere! };
    expect(await connect('require')).toBe(HANDSHAKE_OK);
  });
});
