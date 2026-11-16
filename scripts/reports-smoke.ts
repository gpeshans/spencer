/**
 * A live planning pass (report-engine stages 1-3) against the real model, to
 * check prompts and schemas. It costs money: an intent call and a plan call on
 * Claude Opus 5.5, about $0.05-0.15, capped by a $0.50 run budget.
 *
 * It runs on a throwaway local Postgres (Docker) with the made-up households of
 * tests/db, so no real data is sent anywhere. Needs ANTHROPIC_API_KEY.
 *
 *   npm run reports:smoke
 *   npm run reports:smoke -- "Show spending per category last month"
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  buildVocabulary,
  cachePrefix,
  createAnthropicProvider,
  createPgExecutor,
  createRunBudget,
  createSqlGuard,
  newRun,
  parseSemanticModel,
  planRun,
  priceOf,
  signScope,
  type LlmCallRecord,
} from 'report-engine';

import { reportsConfig } from '../reports.config';
import { FAMILY, prepareDatabase } from '../tests/db/fixtures';
import { dockerAvailable } from '../tests/db/harness';

const BUDGET_USD = 0.5;
const question = process.argv.slice(2).join(' ').trim() || 'How much did we spend per category last month?';

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set; run it through npm run reports:smoke.');
  if (!dockerAvailable()) throw new Error('Docker is needed for the throwaway database.');

  const model = parseSemanticModel(JSON.parse(readFileSync(reportsConfig.model.path, 'utf8')));
  const vocabulary = buildVocabulary(model);
  const prefix = cachePrefix(model, vocabulary);
  const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });

  console.log(`Starting a throwaway database…`);
  const prepared = await prepareDatabase();
  const executor = createPgExecutor({ url: prepared.readerUrl, role: reportsConfig.model.role, guard });
  const budget = createRunBudget(BUDGET_USD);
  const calls: LlmCallRecord[] = [];
  const llm = createAnthropicProvider({ guard: budget, onCall: (call) => void calls.push(call) });
  const runId = randomUUID();

  try {
    console.log(`Planning: "${question}"`);
    const state = await planRun(newRun(runId, question), {
      vocabulary,
      cachePrefix: prefix,
      llm,
      query: (queries) =>
        executor.run({
          scope: {
            setting: reportsConfig.scope.setting,
            value: signScope({ tenantId: FAMILY, runId, key: prepared.scopeKey }),
            verifySql: reportsConfig.scope.verifySql,
            expectedTenant: FAMILY,
          },
          queries,
        }),
      shareValues: true,
      timeZone: process.env.NEXT_PUBLIC_TIMEZONE || 'Europe/Berlin',
      now: () => new Date(),
      remainingUsd: () => BUDGET_USD - budget.spentUsd(),
      price: priceOf('claude-opus-5-5'),
      save: async (next) => console.log(`  → ${next.status}${next.stage ? ` (${next.stage})` : ''}`),
    });

    console.log('\nCalls:');
    for (const call of calls) {
      const { inputTokens, outputTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } = call.usage;
      console.log(
        `  ${call.stage} #${call.attempt} ${call.modelServed ?? call.modelRequested}: ${call.errorClass ?? 'ok'}, ` +
          `stop ${call.stopReason}, ${call.latencyMs} ms, in ${inputTokens} / out ${outputTokens} / ` +
          `cache read ${cacheReadTokens} / write ${cacheWrite5mTokens + cacheWrite1hTokens}, $${call.costUsd.toFixed(4)}` +
          (call.fallbackReason ? `, ${call.fallbackReason}` : '') +
          (call.requestId ? `, ${call.requestId}` : ''),
      );
    }
    console.log(`\nStatus: ${state.status}. Cost: $${state.costUsd.toFixed(4)}. Stage times: ${JSON.stringify(state.stageTimings)}`);
    const { status, error, clarifications, intent, flags, feasibility, plan, planHash, unchecked, approval } = state;
    console.log(JSON.stringify({ status, error, clarifications, intent, flags, feasibility, plan, planHash, unchecked, approval }, null, 2));
  } finally {
    await executor.close();
    await prepared.db.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
