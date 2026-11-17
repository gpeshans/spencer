/**
 * Builds supabase/reporting/semantic-model.json (docs/report-engine-spec.md §4, stage 0).
 *
 *   npm run reports:model              build from the migrations, on a throwaway local Postgres (Docker)
 *   npm run reports:model -- --check   change nothing; exit 1 if the committed model is stale or has problems
 *   npm run reports:model:live         check the committed model against the live database (REPORTS_DATABASE_URL)
 *
 * The relations and schemaHash are regenerated. The curated sections (metrics,
 * dimensions, synonyms, examples, suggested reports) are kept and checked.
 * Warnings mean a query could read past row-level security, and fail the run.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import postgres from 'postgres';
import {
  buildSemanticModel,
  checkFreshness,
  introspect,
  parseSemanticModel,
  SUPABASE_ROOT_CA_2021,
  tlsProblem,
  trustedSsl,
  type Introspection,
} from 'report-engine';

import { reportsConfig } from '../reports.config';
import { applyMigrations, applySupabaseStub, dockerAvailable, startDatabase } from '../tests/db/harness';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const live = args.has('--url');

async function fromMigrations(): Promise<Introspection> {
  if (!dockerAvailable()) {
    throw new Error('Docker is needed to build the model from the migrations (or check the live database with --url).');
  }
  const db = await startDatabase();
  try {
    const postgresPassword = randomBytes(16).toString('hex');
    await applySupabaseStub(db, postgresPassword);
    await applyMigrations(db, postgresPassword);
    return await introspect(db.admin, reportsConfig.model);
  } finally {
    await db.stop();
  }
}

async function fromDatabase(url: string): Promise<Introspection> {
  // Verify the server as the reports do: its certificate chains to Supabase's root and names the host.
  const ssl = trustedSsl(url, SUPABASE_ROOT_CA_2021);
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {}, ...(ssl && { ssl }) });
  try {
    return await introspect(sql, reportsConfig.model);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<number> {
  const file = path.resolve(reportsConfig.model.path);
  const previous = existsSync(file) ? parseSemanticModel(JSON.parse(readFileSync(file, 'utf8'))) : undefined;

  let introspection: Introspection;
  if (live) {
    const url = process.env.REPORTS_DATABASE_URL;
    if (!url) {
      console.error('Set REPORTS_DATABASE_URL (in .env.local) to check the live database.');
      return 2;
    }
    // Reports refuse such a URL, so the check doesn't use it either.
    const tls = tlsProblem(url);
    if (tls) {
      console.error(`REPORTS_DATABASE_URL ${tls}.`);
      return 2;
    }
    introspection = await fromDatabase(url);
  } else {
    introspection = await fromMigrations();
  }

  const { model, problems, warnings } = await buildSemanticModel({ introspection, previous });
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const problem of problems) console.error(`problem: ${problem}`);
  const clean = problems.length === 0 && warnings.length === 0;

  if (checkOnly || live) {
    if (!previous) {
      console.error(`There is no ${reportsConfig.model.path} yet. Run npm run reports:model.`);
      return 1;
    }
    const freshness = checkFreshness(previous, introspection);
    if (freshness.fresh) {
      console.log(`The model is up to date (schema ${freshness.model.slice(0, 12)}).`);
    } else {
      console.error(
        `The model is stale: built from schema ${freshness.model.slice(0, 12)}, but the database is ` +
          `${freshness.database.slice(0, 12)}. Run npm run reports:model.`,
      );
    }
    return freshness.fresh && clean ? 0 : 1;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`);
  console.log(
    `Wrote ${reportsConfig.model.path}: ${model.relations.length} relations, schema ${model.schemaHash.slice(0, 12)}.`,
  );
  return clean ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
