import { z } from 'zod';

import { findSameName, suggest } from '../core/similarity';
import type { GenerateRequest } from '../llm';
import { checkPeriod, nameOf, namesOf, PeriodSchema, type Period } from '../plan/query';
import { GRAINS, type Grain, type Vocabulary } from '../plan/vocabulary';
import { fence, randomBoundary } from '../prompt/fence';
import type { HouseholdValues } from './values';

/**
 * Stage 1: understand the request (docs/report-engine-spec.md §4). The LLM
 * returns an Intent at low effort; code then checks it against the semantic
 * model and the household's values, and decides whether to go on, ask a
 * clarifying question, or refuse.
 */

export const INTENT_KINDS = [
  'figure',
  'breakdown',
  'trend',
  'comparison',
  'listing',
  'report',
  'out_of_scope',
  'write_request',
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export interface Intent {
  kind: IntentKind;
  restated: string;
  metrics: string[];
  dimensions: string[];
  grain: Grain | null;
  filters: Array<{ dimension: string; values: string[] }>;
  period: Period | null;
  comparison: Period | null;
  assumptions: string[];
  ambiguities: Array<{ question: string; options: string[] }>;
  confidence: 'high' | 'medium' | 'low';
  refusal: string | null;
}

export function intentSchema(vocabulary: Vocabulary): z.ZodType<Intent> {
  const metrics = vocabulary.metrics.map((metric) => metric.name);
  const dimensions = vocabulary.dimensions.map((dimension) => dimension.name);
  const schema = z.object({
    kind: z.enum(INTENT_KINDS),
    restated: z.string().describe('The request in one plain sentence, as you understood it.'),
    metrics: z.array(nameOf(metrics)).describe('Metrics the answer needs.'),
    dimensions: namesOf(dimensions).describe('Dimensions to break the answer down by.'),
    grain: z.enum(GRAINS).nullable().describe('For a trend, the size of each period; otherwise null.'),
    filters: z.array(
      z.object({
        dimension: nameOf(dimensions),
        values: z.array(z.string()).min(1).describe('Spelled exactly as in the household values, when listed.'),
      }),
    ),
    period: PeriodSchema.nullable().describe('The period asked about, resolved to dates; null for all time.'),
    comparison: PeriodSchema.nullable().describe('A second period to compare against, or null.'),
    assumptions: z.array(z.string()).describe('Choices you made that the person should know about.'),
    ambiguities: z
      .array(z.object({ question: z.string(), options: z.array(z.string()) }))
      .describe('Open choices that would change the result, each a short question with options.'),
    confidence: z.enum(['high', 'medium', 'low']),
    refusal: z.string().nullable().describe('For out_of_scope and write_request, why, in one sentence; else null.'),
  });
  // Built from the model at run time; its output is an Intent.
  return schema as z.ZodType<Intent>;
}

export const INTENT_INSTRUCTIONS = `Stage 1 of 3 before any SQL: understand the request.

Return what the person is asking for:
- kind: figure (one number), breakdown (a figure split by a dimension), trend (a figure over time), comparison (two periods or two groups), listing (individual records), report (several of these together), out_of_scope (not about this data, or not answerable from it), or write_request (asks to add, change or delete data: this engine only reads).
- metrics, dimensions, grain and filters, using only names from the schema. When household values are listed, spell a filter's values exactly as listed. Map the person's words onto them, e.g. "food shopping" onto a category named "Groceries".
- period: resolve relative dates ("last month", "this year so far", "in March") against today's date in the given time zone. Use null when the request covers all time.
- comparison: the second period of a comparison such as "compared with the month before"; otherwise null.
- assumptions: choices you made that the person should see, e.g. reading "this year" as the calendar year to date.
- ambiguities: only open choices that would change the result and that neither the request nor the earlier answers settle. Write each as a short question with options.
- confidence: how sure you are that you understood the request.
- refusal: for out_of_scope and write_request, one sentence saying why; otherwise null.`;

export interface IntentInput {
  request: string;
  /** Earlier clarifying questions and the person's answers, oldest first. */
  clarifications: ReadonlyArray<{ question: string; answer: string }>;
  /** Values the LLM may see; null when the deployment shares none. */
  values: HouseholdValues | null;
  /** Today, YYYY-MM-DD, in `timeZone`. */
  today: string;
  timeZone: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekday(isoDate: string): string {
  return WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()] ?? '';
}

export function renderIntentInput(input: IntentInput, boundary = randomBoundary()): string {
  const parts = [`Today is ${input.today}, a ${weekday(input.today)}, in the time zone ${input.timeZone}.`, ''];
  if (input.values) {
    const listed = Object.entries(input.values).map(([dimension, values]) => `${dimension}: ${JSON.stringify(values)}`);
    parts.push('Household values, per dimension:', fence('values', listed.join('\n') || '(none)', boundary), '');
  } else {
    parts.push("The household's values aren't shared with you. Write filter values as the person wrote them.", '');
  }
  parts.push('The request:', fence('request', input.request, boundary));
  if (input.clarifications.length > 0) {
    const answers = input.clarifications.map((entry) => `Question: ${entry.question}\nAnswer: ${entry.answer}`);
    parts.push('', 'Answers to earlier clarifying questions:', fence('clarifications', answers.join('\n\n'), boundary));
  }
  return parts.join('\n');
}

export function intentRequest(vocabulary: Vocabulary, cachePrefix: string, input: IntentInput): GenerateRequest<Intent> {
  return {
    stage: 'intent',
    cachePrefix,
    system: INTENT_INSTRUCTIONS,
    input: renderIntentInput(input),
    schema: intentSchema(vocabulary),
    effort: 'low',
    maxTokens: 8_000,
  };
}

export type IntentVerdict =
  /** Go on to planning. `flags` are reasons to ask for approval before running it. */
  | { verdict: 'ok'; intent: Intent; flags: string[] }
  /** Ask the person; their answer goes back to this stage. */
  | { verdict: 'clarify'; question: string; options: string[] }
  /** Refuse with a reason; nothing runs. */
  | { verdict: 'refuse'; code: 'out_of_scope' | 'write_request'; reason: string }
  /** The LLM's answer doesn't fit the model; the stage should be tried again. */
  | { verdict: 'invalid'; issues: string[] };

export interface IntentCheckContext {
  vocabulary: Vocabulary;
  values: HouseholdValues;
  today: string;
}

const MAX_LISTED_OPTIONS = 10;
const humanize = (name: string) => name.replaceAll('_', ' ');

/** Checks an intent and returns it with filter values in their canonical spelling. */
export function checkIntent(intent: Intent, context: IntentCheckContext): IntentVerdict {
  const { vocabulary, values } = context;
  if (intent.kind === 'out_of_scope' || intent.kind === 'write_request') {
    const fallback =
      intent.kind === 'write_request'
        ? 'Reports only read data; they never change it.'
        : "This can't be answered from the data reports can read.";
    return { verdict: 'refuse', code: intent.kind, reason: intent.refusal?.trim() || fallback };
  }

  const issues: string[] = [];
  for (const metric of intent.metrics) {
    if (!vocabulary.metric(metric)) issues.push(`unknown metric ${metric}`);
  }
  for (const dimension of [...intent.dimensions, ...intent.filters.map((filter) => filter.dimension)]) {
    if (!vocabulary.dimension(dimension)) issues.push(`unknown dimension ${dimension}`);
  }
  if (intent.period) issues.push(...checkPeriod(intent.period));
  if (intent.comparison) {
    issues.push(...checkPeriod(intent.comparison, 'comparison'));
    if (!intent.period) issues.push('a comparison needs a period to compare with');
  }
  if (intent.filters.some((filter) => filter.values.length === 0)) issues.push('every filter needs a value');
  const dated = intent.metrics.some((name) => {
    const metric = vocabulary.metric(name);
    return metric !== undefined && Boolean(vocabulary.relation(metric.relation)?.time);
  });
  if (intent.grain && intent.metrics.length > 0 && !dated) {
    issues.push(`no metric here is dated, so it can't be grouped by ${intent.grain}`);
  }
  if (issues.length > 0) return { verdict: 'invalid', issues };

  const [ambiguity] = intent.ambiguities;
  if (ambiguity) return { verdict: 'clarify', question: ambiguity.question, options: ambiguity.options };

  if (intent.metrics.length === 0 && intent.kind !== 'listing') {
    return {
      verdict: 'clarify',
      question: 'Which figure should the report show?',
      options: vocabulary.metrics.map((metric) => humanize(metric.name)),
    };
  }

  // Every dimension must apply to the relation of at least one requested metric.
  const relations = new Set(intent.metrics.map((metric) => vocabulary.metric(metric)!.relation));
  if (relations.size > 0) {
    for (const name of [...intent.dimensions, ...intent.filters.map((filter) => filter.dimension)]) {
      const dimension = vocabulary.dimension(name)!;
      if (relations.has(dimension.relation)) continue;
      const fitting = vocabulary.dimensions.filter((candidate) => relations.has(candidate.relation));
      return {
        verdict: 'clarify',
        question: `${humanize(name)} doesn't apply to ${intent.metrics.map(humanize).join(' or ')}. Which of these did you mean?`,
        options: fitting.map((candidate) => humanize(candidate.name)),
      };
    }
  }

  const flags: string[] = [];
  const filters: Intent['filters'] = [];
  for (const filter of intent.filters) {
    const known = values[filter.dimension];
    if (!known) {
      flags.push(`The values for ${humanize(filter.dimension)} couldn't be checked; they are used as written.`);
      filters.push(filter);
      continue;
    }
    const canonical: string[] = [];
    for (const value of filter.values) {
      const same = findSameName(value, known);
      if (same !== undefined) {
        canonical.push(same);
        continue;
      }
      const close = suggest(value, known);
      return {
        verdict: 'clarify',
        question:
          close.length > 0
            ? `There's no ${humanize(filter.dimension)} called "${value}". Did you mean one of these?`
            : `There's no ${humanize(filter.dimension)} called "${value}". Which one did you mean?`,
        options: close.length > 0 ? close : known.slice(0, MAX_LISTED_OPTIONS),
      };
    }
    filters.push({ ...filter, values: [...new Set(canonical)] });
  }

  if (intent.confidence === 'low') flags.push('The request was understood with low confidence.');
  // A period that has started ("this month") is fine; one that hasn't can have no data yet.
  for (const [label, period] of [['period', intent.period], ['comparison', intent.comparison]] as const) {
    if (period && period.from > context.today) {
      flags.push(`The ${label} starts after today (${context.today}), so there is no data for it yet.`);
    }
  }
  return { verdict: 'ok', intent: { ...intent, filters }, flags };
}
