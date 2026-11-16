import type { Vocabulary } from '../plan/vocabulary';
import type { SemanticModel } from '../semantic';
import { contentBoundary, fence, FENCE_RULE } from './fence';

/**
 * The prefix every LLM stage starts with: the engine's rules, then the
 * semantic model as fenced text. It is the same for every stage and every
 * call, so it can be cached (the stage instructions come after it).
 */

const RULES = [
  'You are one stage of a read-only reporting engine. People ask questions about their own data in plain ' +
    'language. Each stage turns its input into a structured result, and code checks that result before the ' +
    'next stage runs.',
  FENCE_RULE,
  'Use only the views, columns, metrics and dimensions described in the schema block. Never invent names.',
  'Dates are written YYYY-MM-DD. A period is half-open: "from" is the first day included and "to" is the ' +
    'first day after it. For example, "last month" on 2026-11-16 is from 2026-10-01 to 2026-11-01.',
  "Don't guess. When the request leaves a choice open that would change the result, say so instead of choosing.",
];

/** The semantic model as plain text, in a fixed order, so the same model always gives the same text. */
export function renderModel(model: SemanticModel, vocabulary: Vocabulary): string {
  const lines: string[] = ['Views:'];
  for (const relation of model.relations) {
    lines.push(`- ${relation.name} (${relation.kind})${relation.description ? `: ${relation.description}` : ''}`);
    const time = vocabulary.relation(relation.name)?.time;
    if (time) lines.push(`  Dated by ${time.column}; periods and grain apply to it.`);
    for (const column of relation.columns) {
      lines.push(`  - ${column.name} (${column.type})${column.description ? `: ${column.description}` : ''}`);
    }
  }
  lines.push('', 'Metrics:');
  for (const metric of model.metrics) {
    lines.push(`- ${metric.name} = ${metric.expression} over ${metric.relation}, in ${metric.unit}: ${metric.description}`);
  }
  lines.push('', 'Dimensions:');
  for (const dimension of model.dimensions) {
    lines.push(`- ${dimension.name} = ${dimension.relation}.${dimension.column}: ${dimension.description}`);
  }
  if (model.synonyms.length > 0) {
    lines.push('', 'Words people use:');
    for (const synonym of model.synonyms) lines.push(`- "${synonym.term}" means ${synonym.means}`);
  }
  if (model.examples.length > 0) {
    lines.push('', 'Example questions, with SQL that answers them:');
    for (const example of model.examples) {
      lines.push(`- ${example.question}`);
      lines.push(...example.sql.split('\n').map((line) => `    ${line}`));
      if (example.params.length > 0) lines.push(`    -- parameters: ${JSON.stringify(example.params)}`);
    }
  }
  return lines.join('\n');
}

export function cachePrefix(model: SemanticModel, vocabulary: Vocabulary): string {
  const schema = renderModel(model, vocabulary);
  return [
    'Rules:',
    ...RULES.map((rule, index) => `${index + 1}. ${rule}`),
    '',
    'The schema you work with:',
    fence('schema', schema, contentBoundary(schema)),
  ].join('\n');
}
