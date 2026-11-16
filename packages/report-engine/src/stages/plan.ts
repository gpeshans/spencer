import { z } from 'zod';

import { canonicalJson, sha256Hex } from '../core/canonical';
import { findSameName } from '../core/similarity';
import type { GenerateRequest, ModelPrice } from '../llm';
import {
  nameOf,
  queryDraftSchema,
  toQueryDraft,
  toStructuredQuery,
  type AggregateQuery,
  type QueryDraft,
  type StructuredQuery,
} from '../plan/query';
import type { Vocabulary } from '../plan/vocabulary';
import { fence, randomBoundary } from '../prompt/fence';
import type { Feasibility } from './feasibility';
import type { Intent } from './intent';
import type { HouseholdValues } from './values';

/**
 * Stage 3: plan (docs/report-engine-spec.md §4). The LLM turns the checked
 * intent into a ReportPlan at high effort; code checks it, hashes it for
 * approval, estimates what the rest of the run will cost, and decides whether
 * the person has to approve it first.
 */

export const SECTION_DISPLAYS = ['figure', 'table', 'bar', 'line', 'pie', 'text'] as const;
export const DERIVED_KINDS = ['share_of_total', 'change', 'difference', 'ratio'] as const;
export const MAX_SECTIONS = 8;

export type SectionDisplay = (typeof SECTION_DISPLAYS)[number];
export type DerivedKind = (typeof DERIVED_KINDS)[number];

export interface PlanSection {
  id: string;
  title: string;
  purpose: string;
  display: SectionDisplay;
  /** Null for text, and for a section the structured shapes can't describe (no compiled cross-check). */
  query: StructuredQuery | null;
  essential: boolean;
}

export interface DerivedValue {
  id: string;
  kind: DerivedKind;
  label: string;
  section: string;
  metric: string;
  /** The other side, for change, difference and ratio. */
  against: { section: string; metric: string } | null;
}

export interface CrossCheck {
  kind: 'sums_to';
  /** The section with the breakdown. */
  parts: string;
  /** The section with the total. */
  total: string;
  metric: string;
}

export interface ReportPlan {
  title: string;
  summary: string;
  sections: PlanSection[];
  derived: DerivedValue[];
  crossChecks: CrossCheck[];
}

/** A section as the LLM writes it: the query is a flat draft (see queryDraftSchema). */
export interface PlanSectionDraft extends Omit<PlanSection, 'query'> {
  query: QueryDraft;
}

/** A plan as the LLM writes it; checkPlan turns it into a ReportPlan. */
export interface PlanDraft extends Omit<ReportPlan, 'sections'> {
  sections: PlanSectionDraft[];
}

/** The draft a plan comes from: the inverse of checkPlan's conversion. */
export function toPlanDraft(plan: ReportPlan): PlanDraft {
  return { ...plan, sections: plan.sections.map((section) => ({ ...section, query: toQueryDraft(section.query) })) };
}

const ID = /^[a-z][a-z0-9_]{0,31}$/;

export function planSchema(vocabulary: Vocabulary): z.ZodType<PlanDraft> {
  const metrics = vocabulary.metrics.map((metric) => metric.name);
  const id = z.string().regex(ID).describe('Lowercase letters, digits and underscores, e.g. "by_category".');
  const schema = z.object({
    title: z.string().describe('A short title for the report.'),
    summary: z.string().describe('What the report shows and what it assumes, in two or three plain sentences.'),
    sections: z
      .array(
        z.object({
          id,
          title: z.string(),
          purpose: z.string().describe('What this section answers. When query is null, exactly what to compute.'),
          display: z.enum(SECTION_DISPLAYS),
          query: queryDraftSchema(vocabulary),
          essential: z.boolean().describe('True when the report is useless without this section.'),
        }),
      )
      .min(1)
      .max(MAX_SECTIONS),
    derived: z.array(
      z.object({
        id,
        kind: z.enum(DERIVED_KINDS),
        label: z.string(),
        section: z.string().describe('Id of the section it is computed from.'),
        metric: nameOf(metrics),
        against: z
          .object({ section: z.string(), metric: nameOf(metrics) })
          .nullable()
          .describe('For change, difference and ratio, the other side; null for share_of_total.'),
      }),
    ),
    crossChecks: z.array(
      z.object({
        kind: z.literal('sums_to'),
        parts: z.string().describe('Id of the section with the breakdown.'),
        total: z.string().describe('Id of the section with the total it must add up to.'),
        metric: nameOf(metrics),
      }),
    ),
  });
  // Built from the model at run time; its output is a PlanDraft.
  return schema as z.ZodType<PlanDraft>;
}

export const PLAN_INSTRUCTIONS = `Stage 3 of 3 before any SQL: plan the report.

Turn the checked request into a report plan:
- title, and a summary in plain language of what the report shows and what it assumes.
- sections, at most ${MAX_SECTIONS}, in reading order. Give each an id, a title, its purpose, a display, a structured query, and whether the report is useless without it (essential).
  - display: figure (one or a few numbers), table, bar (a breakdown), line (over time), pie (shares of one whole, few slices), or text (words only, no query).
  - query: shape aggregate (metrics, dimensions, grain) for figures, breakdowns and trends; shape rows (columns) for listings of individual records; shape none for text. Fill only the fields of the shape you choose and leave the others empty ([], none or 0). Use the period, filters and grain of the checked request unless a section needs another, such as the comparison period.
  - When a section needs something the shapes can't express, use shape none and say exactly what to compute in its purpose.
- derived: values code computes from sections. share_of_total is each row's share of its section's total. change compares a section with the same breakdown over the comparison period. difference and ratio combine two sections with the same dimensions and grain, e.g. income minus spending per month.
- crossChecks: sums_to, when a breakdown must add up to a total shown in another section.
Keep the plan small: one section per thing the person asked for, plus a headline figure when it helps.`;

export interface PlanInput {
  request: string;
  intent: Intent;
  feasibility: Feasibility;
  /** Values the LLM may see; null when the deployment shares none. */
  values: HouseholdValues | null;
  today: string;
  timeZone: string;
  /** Problems with the previous plan, when this is the second try. */
  issues?: readonly string[];
}

export function renderPlanInput(input: PlanInput, boundary = randomBoundary()): string {
  const parts = [`Today is ${input.today}, in the time zone ${input.timeZone}.`, ''];
  parts.push('The checked request, from stage 1:', fence('intent', JSON.stringify(input.intent, null, 2), boundary), '');
  const coverage = input.feasibility.coverage.map(
    (entry) =>
      `${entry.relation}: ${entry.rows} rows in the period` +
      (entry.first ? `, data from ${entry.first} to ${entry.last}` : '') +
      (entry.comparisonRows === null ? '' : `, ${entry.comparisonRows} rows in the comparison period`),
  );
  const notes = [...coverage, ...input.feasibility.gaps.map((gap) => `Gap: ${gap}`)];
  parts.push('Data coverage, from stage 2:', fence('coverage', notes.join('\n') || '(nothing to check)', boundary), '');
  if (input.values) {
    const listed = Object.entries(input.values).map(([dimension, values]) => `${dimension}: ${JSON.stringify(values)}`);
    parts.push('Household values, per dimension:', fence('values', listed.join('\n') || '(none)', boundary), '');
  }
  parts.push('The original request:', fence('request', input.request, boundary));
  if (input.issues && input.issues.length > 0) {
    parts.push(
      '',
      'Your previous plan had these problems. Fix them all:',
      fence('issues', input.issues.map((issue) => `- ${issue}`).join('\n'), boundary),
    );
  }
  return parts.join('\n');
}

export function planRequest(vocabulary: Vocabulary, cachePrefix: string, input: PlanInput): GenerateRequest<PlanDraft> {
  return {
    stage: 'plan',
    cachePrefix,
    system: PLAN_INSTRUCTIONS,
    input: renderPlanInput(input),
    schema: planSchema(vocabulary),
    effort: 'high',
    maxTokens: 16_000,
  };
}

export type PlanVerdict =
  /** `unchecked`: ids of sections with no structured query, so no compiled cross-check. */
  | { verdict: 'ok'; plan: ReportPlan; unchecked: string[] }
  | { verdict: 'invalid'; issues: string[] };

export interface PlanCheckContext {
  vocabulary: Vocabulary;
  values: HouseholdValues;
}

const aggregateOf = (section: PlanSection | undefined): AggregateQuery | null =>
  section?.query?.shape === 'aggregate' ? section.query : null;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

/**
 * Turns the LLM's draft into a ReportPlan and checks it. Filter values come
 * back spelled as the household spells them.
 */
export function checkPlan(plan: PlanDraft, context: PlanCheckContext): PlanVerdict {
  const issues: string[] = [];
  if (plan.sections.length === 0) issues.push('a plan needs at least one section');
  if (plan.sections.length > MAX_SECTIONS) issues.push(`a plan has at most ${MAX_SECTIONS} sections`);

  const ids = new Set<string>();
  const sections = plan.sections.map((section) => {
    if (!ID.test(section.id)) issues.push(`section id "${section.id}" must be lowercase letters, digits and _`);
    if (ids.has(section.id)) issues.push(`section id ${section.id} is used twice`);
    ids.add(section.id);
    const converted = toStructuredQuery(section.query, context.vocabulary);
    if (!converted.ok) issues.push(...converted.issues.map((issue) => `${section.id}: ${issue}`));
    const query = converted.ok && converted.query ? canonicalFilters(section.id, converted.query, context, issues) : null;
    const checked: PlanSection = { ...section, query };
    if (converted.ok) issues.push(...checkDisplay(checked));
    return checked;
  });

  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const value of plan.derived) {
    if (!ID.test(value.id) || ids.has(value.id)) issues.push(`derived id "${value.id}" must be new and lowercase`);
    ids.add(value.id);
    issues.push(...checkDerived(value, byId));
  }
  for (const check of plan.crossChecks) issues.push(...checkCrossCheck(check, byId));

  if (issues.length > 0) return { verdict: 'invalid', issues };
  const result = { ...plan, sections };
  const unchecked = sections.filter((section) => section.display !== 'text' && !section.query).map((section) => section.id);
  return { verdict: 'ok', plan: result, unchecked };
}

/**
 * Spells filter values as the household does. Exact SQL comparison would miss
 * "groceries" for "Groceries", so a value that matches no known one is an issue.
 * Listings are covered too, when they filter a column that a dimension reads.
 */
function canonicalFilters(
  sectionId: string,
  query: StructuredQuery,
  { vocabulary, values }: PlanCheckContext,
  issues: string[],
): StructuredQuery {
  const spell = (dimension: string, value: string) => {
    const known = values[dimension];
    if (!known) return value;
    const same = findSameName(value, known);
    if (same === undefined) issues.push(`${sectionId}: there is no ${dimension} called "${value}"`);
    return same ?? value;
  };
  if (query.shape === 'aggregate') {
    const filters = query.filters.map((filter) => ({
      ...filter,
      values: filter.values.map((value) => spell(filter.dimension, value)),
    }));
    return { ...query, filters };
  }
  const filters = query.filters.map((filter) => {
    const dimension = vocabulary.dimensions.find(
      (candidate) => candidate.relation === query.relation && candidate.column === filter.column,
    );
    if (!dimension || !['eq', 'in', 'not_in'].includes(filter.op)) return filter;
    return {
      ...filter,
      values: filter.values.map((value) => (typeof value === 'string' ? spell(dimension.name, value) : value)),
    };
  });
  return { ...query, filters };
}

function checkDisplay(section: PlanSection): string[] {
  const { id, display, query } = section;
  const aggregate = query?.shape === 'aggregate' ? query : null;
  switch (display) {
    case 'text':
      return query ? [`${id}: a text section has no query`] : [];
    case 'table':
      return [];
    case 'figure':
      if (!query) return [];
      return aggregate && aggregate.dimensions.length === 0 && !aggregate.grain
        ? []
        : [`${id}: a figure is an aggregate with no dimensions and no grain`];
    case 'line':
      if (!query) return [];
      return aggregate?.grain ? [] : [`${id}: a line chart needs an aggregate with a grain`];
    case 'bar':
    case 'pie': {
      if (!query) return [];
      const grouped = aggregate && (aggregate.dimensions.length > 0 || aggregate.grain !== null);
      if (!grouped) return [`${id}: a ${display} chart needs an aggregate grouped by a dimension or a grain`];
      return display === 'pie' && aggregate.metrics.length !== 1 ? [`${id}: a pie chart shows exactly one metric`] : [];
    }
  }
}

function checkDerived(value: DerivedValue, sections: ReadonlyMap<string, PlanSection>): string[] {
  const base = aggregateOf(sections.get(value.section));
  if (!base) return [`${value.id}: section ${value.section} must exist and have an aggregate query`];
  const issues: string[] = [];
  if (!base.metrics.includes(value.metric)) issues.push(`${value.id}: section ${value.section} has no ${value.metric}`);
  if (value.kind === 'share_of_total') {
    if (value.against) issues.push(`${value.id}: share_of_total takes no "against"`);
    if (base.dimensions.length === 0 && !base.grain) issues.push(`${value.id}: section ${value.section} has nothing to share out`);
    return issues;
  }
  if (!value.against) return [...issues, `${value.id}: ${value.kind} needs "against"`];
  const other = aggregateOf(sections.get(value.against.section));
  if (!other) return [...issues, `${value.id}: section ${value.against.section} must exist and have an aggregate query`];
  if (!other.metrics.includes(value.against.metric)) {
    issues.push(`${value.id}: section ${value.against.section} has no ${value.against.metric}`);
  }
  if (!sameSet(base.dimensions, other.dimensions) || base.grain !== other.grain) {
    issues.push(`${value.id}: ${value.section} and ${value.against.section} must share their dimensions and grain`);
  }
  return issues;
}

function checkCrossCheck(check: CrossCheck, sections: ReadonlyMap<string, PlanSection>): string[] {
  const parts = aggregateOf(sections.get(check.parts));
  const total = aggregateOf(sections.get(check.total));
  const label = `cross-check ${check.parts} → ${check.total}`;
  if (!parts || !total) return [`${label}: both sections must exist and have aggregate queries`];
  const issues: string[] = [];
  if (!parts.metrics.includes(check.metric) || !total.metrics.includes(check.metric)) {
    issues.push(`${label}: both sections must compute ${check.metric}`);
  }
  if (parts.dimensions.length === 0 && !parts.grain) issues.push(`${label}: ${check.parts} must be a breakdown`);
  if (total.dimensions.length > 0 || total.grain) issues.push(`${label}: ${check.total} must be a single total`);
  if (canonicalJson(parts.period) !== canonicalJson(total.period)) issues.push(`${label}: both must cover the same period`);
  return issues;
}

/** The hash an approval refers to: the same plan always gives the same hash. */
export function planHash(plan: ReportPlan): string {
  return sha256Hex(canonicalJson(plan));
}

/**
 * Rough token counts for the stages after the plan: writing SQL (high effort),
 * the narrative (medium), and repairs. To be replaced by measured figures.
 */
export const COST_ASSUMPTIONS = {
  sql: { input: 600, inputPerSection: 400, output: 3_000, outputPerSection: 700 },
  narrative: { input: 600, inputPerSection: 300, output: 1_500, outputPerSection: 200 },
  /** Extra share of the SQL stage spent on repairs. */
  repairShare: 0.25,
} as const;

/** What the rest of the run will cost, in USD, if each stage writes the cached prefix once. */
export function estimateRemainingCost(plan: ReportPlan, price: ModelPrice, prefixTokens: number): number {
  const sections = plan.sections.filter((section) => section.display !== 'text').length;
  const stage = (assumed: { input: number; inputPerSection: number; output: number; outputPerSection: number }) =>
    (prefixTokens * price.cacheWrite5m +
      (assumed.input + assumed.inputPerSection * sections) * price.input +
      (assumed.output + assumed.outputPerSection * sections) * price.output) /
    1_000_000;
  const sql = stage(COST_ASSUMPTIONS.sql);
  return sql * (1 + COST_ASSUMPTIONS.repairShare) + stage(COST_ASSUMPTIONS.narrative);
}

/** A plan with more sections than this needs approval. */
export const SECTIONS_WITHOUT_APPROVAL = 4;

export interface ApprovalInput {
  /** Flags raised by stages 1 and 2. */
  flags: readonly string[];
  plan: ReportPlan;
  estimateUsd: number;
  remainingUsd: number;
}

/** Whether the run pauses for approval, and why (spec §4, stage 3). */
export function approvalReasons({ flags, plan, estimateUsd, remainingUsd }: ApprovalInput): string[] {
  const reasons = [...flags];
  if (plan.sections.length > SECTIONS_WITHOUT_APPROVAL) {
    reasons.push(`The plan has ${plan.sections.length} sections, more than ${SECTIONS_WITHOUT_APPROVAL}.`);
  }
  if (estimateUsd > remainingUsd) {
    reasons.push(
      `The rest of the run is estimated at $${estimateUsd.toFixed(2)}, more than the $${Math.max(0, remainingUsd).toFixed(2)} left in its budget.`,
    );
  }
  return reasons;
}
