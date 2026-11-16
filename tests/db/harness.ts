import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

/** Production runs Postgres 17.6 (checked 2026-11-16). */
const IMAGE = 'postgres:17.6';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../supabase/migrations');

export function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 }).status === 0;
}

export interface TestDatabase {
  url(user: string, password: string): string;
  /** The container superuser: plays the Supabase platform and seeds data. */
  admin: postgres.Sql;
  stop(): Promise<void>;
}

/**
 * Starts a throwaway Postgres container on a random local port. Containers
 * carry the label `spencer-dbtest`, so a crashed run can be cleaned up with
 * `docker rm -f $(docker ps -q --filter label=spencer-dbtest)`.
 */
export async function startDatabase(): Promise<TestDatabase> {
  const name = `spencer-dbtest-${randomBytes(4).toString('hex')}`;
  const adminPassword = randomBytes(16).toString('hex');
  execFileSync(
    'docker',
    [
      'run', '-d', '--rm', '--name', name, '--label', 'spencer-dbtest',
      '-e', 'POSTGRES_USER=supabase_admin',
      '-e', `POSTGRES_PASSWORD=${adminPassword}`,
      '-e', 'POSTGRES_DB=postgres',
      '-p', '127.0.0.1::5432',
      IMAGE,
    ],
    { stdio: 'ignore' },
  );
  const removeContainer = () => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  };

  try {
    const mapping = execFileSync('docker', ['port', name, '5432/tcp']).toString().trim();
    const port = Number(mapping.split('\n')[0]?.split(':').pop());
    if (!Number.isInteger(port)) throw new Error(`unexpected docker port output: ${mapping}`);

    const url = (user: string, password: string) =>
      `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
    const admin = postgres(url('supabase_admin', adminPassword), { max: 1, onnotice: () => {} });
    await waitUntilReady(admin);

    return {
      url,
      admin,
      stop: async () => {
        await admin.end({ timeout: 5 });
        removeContainer();
      },
    };
  } catch (error) {
    removeContainer();
    throw error;
  }
}

// The image's init phase listens on a Unix socket only, so the first
// successful TCP query means the final server is up.
async function waitUntilReady(sql: postgres.Sql, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Creates the Supabase-shaped roles and schemas, and a login for `postgres`. */
export async function applySupabaseStub(db: TestDatabase, postgresPassword: string): Promise<void> {
  assertHex(postgresPassword);
  await db.admin.unsafe(readFileSync(path.join(HERE, 'supabase-stub.sql'), 'utf8'));
  await db.admin.unsafe(`alter role postgres password '${postgresPassword}'`);
}

/** Applies every migration in order as `postgres`, one transaction per file. */
export async function applyMigrations(db: TestDatabase, postgresPassword: string): Promise<string[]> {
  const sql = postgres(db.url('postgres', postgresPassword), { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const content = readFileSync(path.join(MIGRATIONS, file), 'utf8');
      try {
        await sql.begin((tx) => tx.unsafe(content));
      } catch (error) {
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
      applied.push(file);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return applied;
}

/** Passwords go into ALTER ROLE text, which takes no bind parameters. */
export function assertHex(value: string): void {
  if (!/^[0-9a-f]+$/.test(value)) throw new Error('expected a hex string');
}
