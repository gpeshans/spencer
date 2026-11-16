import type { RunStatus } from '../core/run-status';
import { ZERO_USAGE, type LlmUsage } from '../llm';
import type { ParamValue, QueryColumn } from '../pg';
import type { Feasibility } from '../stages/feasibility';
import type { Intent } from '../stages/intent';
import type { ReportPlan } from '../stages/plan';

/**
 * A run's state (docs/report-engine-spec.md §4, "Run states"). The engine
 * keeps none of its own: each pipeline function takes a state, moves it on,
 * and hands every new state to the caller to save (spencer: report_runs).
 */

export type PlanningStage = 'understanding' | 'checking' | 'planning';
export type ExecutionStage = 'writing_sql' | 'validating' | 'executing';
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
  error: RunFailure | null;
  usage: LlmUsage;
  costUsd: number;
  /** Milliseconds per stage, added up over clarification rounds and repairs. */
  stageTimings: Partial<Record<RunStage, number>>;
}

export const MAX_REQUEST_LENGTH = 2000;

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
    error: null,
    usage: ZERO_USAGE,
    costUsd: 0,
    stageTimings: {},
  };
}
