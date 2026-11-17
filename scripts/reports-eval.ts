/**
 * The report eval (evals/reports/README.md): 26 questions with known answers,
 * each run through the app's own report pipeline on a throwaway database
 * (Docker) of made-up data, then graded by code. It costs money: about
 * $0.15-0.40 per answered question on Claude Opus 5.5, and a few cents per
 * refused or clarifying one. --max-usd stops it from starting more.
 *
 *   npm run reports:eval -- --list               the cases and their gold, as of today (free)
 *   npm run reports:eval -- --cases a,b,c        a pilot of a few cases
 *   npm run reports:eval                         every case, once
 *   npm run reports:eval -- --reps 2 --variant v1
 *   npm run reports:eval:report                  report.html from the results
 *
 * Other flags: --concurrency N (default 3), --max-usd X (default 12).
 * --fake-llm checks the harness without the API: every run is refused at
 * stage 1, and the results go to a temporary folder, never into results/;
 * --fake-fail <id> also makes that case's attempt crash.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { todayIn } from 'report-engine';

import { buildCases, buildFixture, casesMarkdown, fakeLlm, runEval, summarize } from '../evals/reports/runner';
import { APP_TIMEZONE } from '../lib/format';
import { dockerAvailable } from '../tests/db/harness';

const ROOT = path.resolve('evals/reports');

function parse(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      index += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  const text = (name: string) => (typeof flags.get(name) === 'string' ? (flags.get(name) as string) : undefined);
  const number = (name: string, fallback: number, whole = false) => {
    const value = text(name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || (whole && !Number.isInteger(parsed))) {
      throw new Error(`--${name} needs a positive ${whole ? 'whole ' : ''}number`);
    }
    return parsed;
  };
  const known = ['list', 'cases', 'reps', 'variant', 'concurrency', 'max-usd', 'fake-llm', 'fake-fail'];
  const unknown = [...flags.keys()].filter((name) => !known.includes(name));
  if (unknown.length > 0) throw new Error(`unknown flag(s): ${unknown.map((name) => `--${name}`).join(', ')}`);
  const variant = text('variant') ?? 'baseline';
  if (!/^(baseline|v\d+)$/.test(variant)) throw new Error('--variant is "baseline" or v1, v2, ... (the report reads only those)');
  return {
    list: flags.has('list'),
    caseIds: text('cases')?.split(',').map((id) => id.trim()).filter(Boolean),
    reps: number('reps', 1, true),
    variant,
    concurrency: number('concurrency', 3, true),
    maxUsd: number('max-usd', 12),
    fake: flags.has('fake-llm'),
    fakeFail: text('fake-fail'),
  };
}

async function main(): Promise<number> {
  const options = parse(process.argv.slice(2));
  if (options.list) {
    const today = todayIn(APP_TIMEZONE, new Date());
    const cases = buildCases(buildFixture(today));
    writeFileSync(path.join(ROOT, 'CASES.md'), casesMarkdown(cases, today));
    console.log(`${cases.length} cases as of ${today}: evals/reports/CASES.md`);
    return 0;
  }
  if (!options.fake && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set (run it through npm run reports:eval, which reads .env.local).');
    return 2;
  }
  if (!dockerAvailable()) {
    console.error('Docker is needed for the throwaway database.');
    return 2;
  }
  // A fake run must never count as a result: a real run would resume past it.
  const outDir = options.fake ? mkdtempSync(path.join(tmpdir(), 'report-eval-offline-')) : path.join(ROOT, 'results');
  const summary = await runEval({
    outDir,
    variant: options.variant,
    caseIds: options.caseIds,
    reps: options.reps,
    concurrency: options.concurrency,
    maxUsd: options.maxUsd,
    timeZone: APP_TIMEZONE,
    ...(options.fake && { llm: fakeLlm(options.fakeFail) }),
  });
  const text = summarize(summary);
  writeFileSync(path.join(outDir, options.variant, 'summary.md'), text);
  console.log(`\n${text}`);
  if (options.fake) console.log(`The offline run's files are in ${outDir}.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
