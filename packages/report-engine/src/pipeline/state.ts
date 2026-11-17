import type { RunStatus } from '../core/run-status';
import { ZERO_USAGE, type LlmUsage } from '../llm';
import type { ParamValue, QueryColumn } from '../pg';
import type { Narrative } from '../report/document';
import type { CheckResult, DerivedResult } from '../stages/derive';
import type { Feasibility } from '../stages/feasibility';
import type { Intent } from '../stages/intent';
import type { ReportPlan } from '../stages/plan';

/**
 * A run's state (docs/report-engine-spec.md §4, "Run states"). The engine
 * keeps none of its own: each pipeline function takes a state, moves it on,
 * and hands every new state to the caller to save (spencer: report_runs).
 */

export type PlanningStage = 'understanding' | 'checking' | 'planning';
/** verifying: stage 7, the cross-checks and derived values. narrating: stage 8. */
export type ExecutionStage = 'writing_sql' | 'validating' | 'executing' | 'verifying' | 'narrating';
export type RunStage = PlanningStage | ExecutionStage;

export interface Clarification {
  question: string;
  options: string[];
  /** Null while the question is open. */
  answer: string | null;
  askedAt: string;
}

export interface RunFailure {
  stage: RunStage;
  /**
   * write_request, out_of_scope, infeasible, unclear, database,
   * sections_failed, or an LLM failure code.
   */
  code: string;
  message: string;
  details?: string[];
}

/**
 * The compiled cross-check of a section (spec §4, stage 7): its rows set
 * against those of the SQL compiled from its structured query.
 * - match: the same rows.
 * - mismatch: different rows; the compiled ones are shown.
 * - fallback: the LLM's SQL kept failing; the compiled rows are shown.
 * - unavailable: nothing to compare: the compiled SQL failed, or rows were cut.
 * - none: the section has no structured query, so nothing compiles.
 */
export type CompiledCheck = 'match' | 'mismatch' | 'fallback' | 'unavailable' | 'none';

/** One section's outcome, after its SQL was written, checked and run. */
export interface SectionResult {
  section: string;
  status: 'ok' | 'failed';
  sql: string | null;
  params: ParamValue[];
  summary: string | null;
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  /** Why rows were cut: too many rows, too many bytes, or not cut. */
  truncated: false | 'rows' | 'bytes';
  /** SQL versions tried: the first one plus repairs. */
  attempts: number;
  /** What was wrong with the last version, when it failed. */
  problems: string[];
  /** Whose SQL the rows come from; the SQL, params and summary above are that one's. Missing before M3: the LLM's. */
  source?: 'llm' | 'compiled';
  /** The compiled cross-check. Missing before M3. */
  check?: CompiledCheck;
  /** For a mismatch, what differed. */
  mismatch?: string;
}

export interface RunState {
  id: string;
  status: RunStatus;
  stage: RunStage | null;
  request: string;
  clarifications: Clarification[];
  intent: Intent | null;
  /** Reasons from stages 1 and 2 to ask for approval. */
  flags: string[];
  feasibility: Feasibility | null;
  plan: ReportPlan | null;
  planHash: string | null;
  /** Sections without a structured query, so without a compiled cross-check. */
  unchecked: string[];
  approval: { reasons: string[]; estimateUsd: number } | null;
  /** When an open question or a pending approval expires. */
  pendingUntil: string | null;
  /** Per section, once the SQL has run (stage 6). */
  results: SectionResult[] | null;
  /** Stage 7: the plan's derived values. */
  derived: DerivedResult[] | null;
  /** Stage 7: the plan's cross-checks. */
  checks: CheckResult[] | null;
  /** Stage 8: the headline and insights; null when there are none. */
  narrative: Narrative | null;
  error: RunFailure | null;
  usage: LlmUsage;
  costUsd: number;
  /** Milliseconds per stage, added up over clarification rounds and repairs. */
  stageTimings: Partial<Record<RunStage, number>>;
}

export const MAX_REQUEST_LENGTH = 2000;

const STATUS_WORDS: Readonly<Record<RunStatus, string>> = {
  received: 'just received',
  planning: 'being planned',
  needs_clarification: 'waiting for an answer',
  awaiting_approval: 'waiting for approval',
  executing: 'running',
  succeeded: 'finished',
  partial: 'finished with gaps',
  failed: 'failed',
  rejected: 'rejected',
  expired: 'expired',
};

/** A run's status in words, for messages people see: "waiting for approval". */
export function describeStatus(status: RunStatus): string {
  return STATUS_WORDS[status];
}

export class RunStateError extends Error {
  constructor(
    readonly code: 'bad_request' | 'wrong_status' | 'plan_changed' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'RunStateError';
  }
}

export function newRun(id: string, request: string): RunState {
  const text = request.trim();
  if (text.length === 0 || text.length > MAX_REQUEST_LENGTH) {
    throw new RunStateError('bad_request', `A request is 1 to ${MAX_REQUEST_LENGTH} characters.`);
  }
  return {
    id,
    status: 'received',
    stage: null,
    request: text,
    clarifications: [],
    intent: null,
    flags: [],
    feasibility: null,
    plan: null,
    planHash: null,
    unchecked: [],
    approval: null,
    pendingUntil: null,
    results: null,
    derived: null,
    checks: null,
    narrative: null,
    error: null,
    usage: ZERO_USAGE,
    costUsd: 0,
    stageTimings: {},
  };
}
