import 'server-only';

import {
  buildVocabulary,
  cachePrefix,
  createPgExecutor,
  createSqlGuard,
  parseSemanticModel,
  priceOf,
  type ModelPrice,
  type ReportExecutor,
  type SemanticModel,
  type SqlGuard,
  type Vocabulary,
} from 'report-engine';

import { APP_TIMEZONE } from '@/lib/format';
import { reportsConfig } from '@/reports.config';
import modelFile from '@/supabase/reporting/semantic-model.json';

import { reportsEnv } from './env';

/**
 * What every run shares, built once per server instance: the semantic model
 * and its prompt prefix, the SQL guard, and the executor's connection pool.
 */
export interface ReportEngine {
  model: SemanticModel;
  vocabulary: Vocabulary;
  cachePrefix: string;
  guard: SqlGuard;
  executor: ReportExecutor;
  /** Price of the model that runs the stages, for cost estimates. */
  price: ModelPrice;
}

/** The model the Anthropic provider uses by default. */
const MODEL = 'claude-opus-5-5';

let engine: ReportEngine | undefined;

export function reportEngine(): ReportEngine {
  if (!engine) {
    const model = parseSemanticModel(modelFile);
    const vocabulary = buildVocabulary(model);
    const guard = createSqlGuard({ relations: model.relations.map((relation) => relation.name) });
    engine = {
      model,
      vocabulary,
      cachePrefix: cachePrefix(model, vocabulary),
      guard,
      // Supavisor pools connections; a run only ever holds one.
      executor: createPgExecutor({
        url: reportsEnv().databaseUrl,
        role: reportsConfig.model.role,
        guard,
        timeZone: APP_TIMEZONE,
        maxConnections: 3,
      }),
      price: priceOf(MODEL),
    };
  }
  return engine;
}
