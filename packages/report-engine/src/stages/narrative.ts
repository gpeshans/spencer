import { z } from 'zod';

import type { GenerateRequest, LlmCallRecord, LlmProvider } from '../llm';
import type { Vocabulary } from '../plan/vocabulary';
import { fence, randomBoundary } from '../prompt/fence';
import { roleOf } from '../report/columns';
import type { Narrative, NarrativeText, ValueFormat } from '../report/document';
import { dayBefore } from '../report/format';
import type { ComputedSection, DerivedResult } from './derive';
import type { Intent } from './intent';
import type { ReportPlan } from './plan';

/**
 * Stage 8, the narrative (docs/report-engine-spec.md §4): a headline and a few
 * insights, written by the LLM at medium effort from the computed figures.
 *
 * It can't introduce a number. Every figure it may cite is listed with a
 * reference, `{v3}`, and the text says `{v3}` where the number goes; code puts
 * the value in, so the report formats it like every other value. A digit the
 * text writes itself is rejected, except a year, and so are links. A text that
 * fails gets one retry with the problems quoted; after that, the sentences
 * that still fail are dropped (decided 2026-11-17).
 */

export interface Reference {
  /** v1, v2, … */
  id: string;
  label: string;
  value: unknown;
  format: ValueFormat;
}

export const MAX_INSIGHTS = 4;
const MAX_ROWS_PER_SECTION = 25;
const MAX_REFERENCES = 200;
const MAX_SENTENCE = 400;

export interface NarrativeInput {
  request: string;
  intent: Intent | null;
  plan: ReportPlan;
  /** The rows each section shows, by section id. */
  results: ReadonlyMap<string, ComputedSection>;
  derived: readonly DerivedResult[];
  vocabulary: Pick<Vocabulary, 'relations' | 'metrics' | 'dimensions'>;
  /** Whether the LLM may see the values; without, it sees what each reference is, not what it holds. */
  shareValues: boolean;
  today: string;
  timeZone: string;
}

const NUMERIC_KINDS = new Set<ValueFormat['kind']>(['money', 'count', 'number', 'percent']);
const DATED_KINDS = new Set<ValueFormat['kind']>(['date', 'timestamp']);

const KIND_WORDS: Readonly<Record<ValueFormat['kind'], string>> = {
  money: 'amount',
  count: 'count',
  number: 'number',
  percent: 'percent',
  date: 'date',
  timestamp: 'date and time',
  text: 'text',
  boolean: 'yes or no',
};

const shown = (value: unknown) => (value === null || value === undefined ? '' : String(value));

/** Every figure the narrative may cite: the sections' numbers and dates, the derived values, the period. */
export function buildReferences(input: NarrativeInput): Reference[] {
  const references: Reference[] = [];
  const add = (label: string, value: unknown, format: ValueFormat) => {
    if (references.length < MAX_REFERENCES) references.push({ id: `v${references.length + 1}`, label, value, format });
  };
  const DAY: ValueFormat = { kind: 'date', grain: null };
  if (input.intent?.period) {
    add('First day of the period', input.intent.period.from, DAY);
    add('Last day of the period', dayBefore(input.intent.period.to), DAY);
  }
  if (input.intent?.comparison) {
    add('First day of the comparison period', input.intent.comparison.from, DAY);
    add('Last day of the comparison period', dayBefore(input.intent.comparison.to), DAY);
  }

  for (const section of input.plan.sections) {
    const result = input.results.get(section.id);
    if (section.display === 'text' || !result || result.status !== 'ok') continue;
    const roles = result.columns.map((column) => roleOf(column, section.query, input.vocabulary));
    const keys = roles.filter((role) => role.column.format.kind === 'text' || role.column.format.kind === 'boolean');
    result.rows.slice(0, MAX_ROWS_PER_SECTION).forEach((row, index) => {
      const named = input.shareValues ? keys.map((role) => shown(row[role.column.key])).filter(Boolean) : [];
      const where = named.length > 0 ? named.join(', ') : result.rows.length > 1 ? `row ${index + 1}` : '';
      for (const role of roles) {
        const kind = role.column.format.kind;
        if (!NUMERIC_KINDS.has(kind) && !DATED_KINDS.has(kind)) continue;
        add([section.title, where, role.column.label].filter(Boolean).join(' · '), row[role.column.key], role.column.format);
      }
    });
  }

  for (const value of input.derived) {
    if (value.skipped) continue;
    value.rows.slice(0, MAX_ROWS_PER_SECTION).forEach((row, index) => {
      const named = input.shareValues ? Object.values(row.key).map(shown).filter(Boolean) : [];
      const where = named.length > 0 ? named.join(', ') : value.rows.length > 1 ? `row ${index + 1}` : '';
      add([value.label, where].filter(Boolean).join(' · '), row.value, value.format);
    });
  }
  return references;
}

export const NARRATIVE_INSTRUCTIONS = `Stage 8: write the report's headline and insights, from its computed figures.

- headline: one sentence that answers the person's question.
- insights: up to ${MAX_INSIGHTS} short sentences on what stands out in the figures: the largest parts, notable differences, anything unusual. Only what the figures show: no advice, and no guesses about causes. Leave insights empty when there is nothing more to say.
- Write in the language of the request.
- Every number, amount, percentage or date you mention must be a reference to one of the figures below, written exactly like {v12}. The reference shows the value with its unit, so add no currency sign or % to it. Never write a digit yourself; the one exception is a year, such as 2026.
- Use only the listed figures. Don't compute new numbers: to compare two figures without a listed difference, say it in words ("more than", "about half").
- Plain sentences only: no links, no markdown, no lists, and no mention of queries, SQL or checks.`;

export function narrativeSchema() {
  return z.object({
    headline: z.string().describe('One sentence, with {v<n>} references for its numbers.'),
    // No maxItems: an extra insight is cut, not a reason to lose the narrative.
    insights: z.array(z.string()).describe(`At most ${MAX_INSIGHTS} short sentences, each with {v<n>} references for its numbers.`),
  });
}

export type NarrativeDraft = z.output<ReturnType<typeof narrativeSchema>>;

export function renderNarrativeInput(input: NarrativeInput, references: readonly Reference[], issues?: readonly string[], boundary = randomBoundary()): string {
  const plan = {
    title: input.plan.title,
    summary: input.plan.summary,
    sections: input.plan.sections.map((section) => ({ title: section.title, purpose: section.purpose })),
    assumptions: input.intent?.assumptions ?? [],
  };
  const lines = references.map((reference) => {
    const kind = KIND_WORDS[reference.format.kind];
    return input.shareValues
      ? `${reference.id} = ${reference.value === null || reference.value === undefined ? 'none' : String(reference.value)} (${kind}): ${reference.label}`
      : `${reference.id} (${kind}): ${reference.label}`;
  });
  const parts = [
    `Today is ${input.today}, in the time zone ${input.timeZone}.`,
    '',
    'The request:',
    fence('request', input.request, boundary),
    '',
    'The report:',
    fence('report', JSON.stringify(plan, null, 2), boundary),
    '',
    'The figures you may cite, by reference:',
    fence('figures', lines.join('\n') || '(none)', boundary),
  ];
  if (issues && issues.length > 0) {
    parts.push('', 'Your previous text had these problems. Fix them all:', fence('issues', issues.map((issue) => `- ${issue}`).join('\n'), boundary));
  }
  return parts.join('\n');
}

export function narrativeRequest(cachePrefix: string, input: NarrativeInput, references: readonly Reference[], issues?: readonly string[]): GenerateRequest<NarrativeDraft> {
  return {
    stage: 'narrative',
    cachePrefix,
    system: NARRATIVE_INSTRUCTIONS,
    input: renderNarrativeInput(input, references, issues),
    schema: narrativeSchema(),
    effort: 'medium',
    maxTokens: 8_000,
  };
}

const REFERENCE = /\{(v\d+)\}/g;
const YEAR = /\b(?:19|20)\d{2}\b/g;
const LINK = /https?:\/\/|www\./i;
const UNIT_NEXT_TO_REFERENCE = /\{v\d+\}\s*[%€$£¥]|[€$£¥]\s*\{v\d+\}/;

/** The years a text may name: today's, and those of the figures' dates. An amount like 2000 is not a year. */
export function yearsOf(references: readonly Reference[], today: string): Set<string> {
  const years = new Set([today.slice(0, 4)]);
  for (const reference of references) {
    if (reference.format.kind !== 'date' && reference.format.kind !== 'timestamp') continue;
    const year = /^(\d{4})-/.exec(String(reference.value ?? ''));
    if (year) years.add(year[1]!);
  }
  return years;
}

/** What is wrong with one sentence; nothing when it may be shown. */
export function checkSentence(text: string, references: ReadonlyMap<string, Reference>, years: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const quoted = `"${text.length > 80 ? `${text.slice(0, 80)}…` : text}"`;
  if (text.length > MAX_SENTENCE) problems.push(`${quoted} is longer than ${MAX_SENTENCE} characters.`);
  for (const [, id] of text.matchAll(REFERENCE)) {
    if (!references.has(id!)) problems.push(`${quoted} refers to {${id}}, which isn't one of the figures.`);
  }
  const bare = text.replace(REFERENCE, ' ').replace(YEAR, (year) => (years.has(year) ? ' ' : year));
  const digits = /\d+(?:[.,]\d+)*/.exec(bare);
  if (digits) problems.push(`${quoted} writes the number ${digits[0]} itself; use a reference to a figure, or words.`);
  if (UNIT_NEXT_TO_REFERENCE.test(text)) problems.push(`${quoted} puts a currency sign or % next to a reference, which shows its unit itself.`);
  if (LINK.test(text)) problems.push(`${quoted} contains a link.`);
  return problems;
}

function resolve(text: string, references: ReadonlyMap<string, Reference>): NarrativeText {
  const parts: NarrativeText = [];
  let at = 0;
  for (const match of text.matchAll(REFERENCE)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    const reference = references.get(match[1]!)!;
    parts.push({ value: reference.value, format: reference.format });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

const sentencesOf = (draft: NarrativeDraft) => [draft.headline, ...draft.insights].map((text) => text.trim()).filter(Boolean);

/** The draft with every failing sentence dropped; null when nothing is left. */
export function finishNarrative(draft: NarrativeDraft, references: readonly Reference[], years: ReadonlySet<string>): Narrative | null {
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const keep = (text: string) => {
    const trimmed = text.trim();
    return trimmed && checkSentence(trimmed, byId, years).length === 0 ? resolve(trimmed, byId) : null;
  };
  const headline = keep(draft.headline);
  const insights = draft.insights.slice(0, MAX_INSIGHTS).map(keep).filter((text): text is NarrativeText => text !== null);
  return headline || insights.length > 0 ? { headline, insights } : null;
}

export interface NarrativeDeps {
  llm: LlmProvider;
  cachePrefix: string;
  signal?: AbortSignal;
  /** Receives every call's usage, for the run's totals. */
  account(calls: readonly LlmCallRecord[]): void;
}

/**
 * Writes the narrative; null when there is nothing to write about or the LLM
 * fails. It never fails the run: a report without a narrative still stands.
 */
export async function writeNarrative(input: NarrativeInput, deps: NarrativeDeps): Promise<Narrative | null> {
  const references = buildReferences(input);
  const computed = input.plan.sections.some((section) => input.results.get(section.id)?.status === 'ok');
  if (!computed) return null;
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const years = yearsOf(references, input.today);
  let draft: NarrativeDraft | null = null;
  let issues: string[] | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await deps.llm.generate({ ...narrativeRequest(deps.cachePrefix, input, references, issues), ...(deps.signal && { signal: deps.signal }) });
    deps.account(result.calls);
    if (!result.ok) break;
    draft = result.output;
    issues = sentencesOf(draft).flatMap((text) => checkSentence(text, byId, years));
    if (draft.insights.length > MAX_INSIGHTS) issues.push(`There are ${draft.insights.length} insights; write at most ${MAX_INSIGHTS}.`);
    if (issues.length === 0) break;
  }
  return draft ? finishNarrative(draft, references, years) : null;
}
