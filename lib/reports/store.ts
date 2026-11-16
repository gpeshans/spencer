import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Clarification,
  Feasibility,
  Intent,
  LlmCallRecord,
  QueryAttempt,
  QueryOutcome,
  ReportPlan,
  ReportQuery,
  RunFailure,
  RunStage,
  RunState,
  RunStatus,
  SectionResult,
} from 'report-engine';

import type { Database, Json, ReportEventAction, ReportRunRow } from '@/types/database';

import { reportsEnv } from './env';
import { FINISHED, isStalled, type StoredRun } from './status';

/**
 * Where runs and their logs live (docs/report-engine-spec.md §7). People read
 * their own rows under RLS. Only the server writes, with the secret key, which
 * bypasses RLS: so every write here names the owner explicitly.
 */

type Client = SupabaseClient<Database>;
type RunUpdate = Database['public']['Tables']['report_runs']['Update'];

let admin: Client | null = null;

function adminClient(): Client {
  if (!admin) {
    const env = reportsEnv();
    admin = createClient<Database>(env.supabaseUrl, env.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}

export class StoreError extends Error {
  constructor(action: string, message: string) {
    super(`reports store: ${action} failed: ${message}`);
    this.name = 'StoreError';
  }
}

const asJson = (value: unknown) => value as Json;

/** The columns a run's state is stored in. The intent and plan carry their bookkeeping alongside. */
export function toRow(state: RunState, now = new Date()): RunUpdate {
  return {
    status: state.status,
    stage: state.stage,
    intent: state.intent ? asJson({ intent: state.intent, flags: state.flags }) : null,
    feasibility: asJson(state.feasibility),
    plan: state.plan ? asJson({ plan: state.plan, unchecked: state.unchecked, approval: state.approval }) : null,
    plan_hash: state.planHash,
    clarification: asJson(state.clarifications),
    result: state.results ? asJson({ sections: state.results }) : null,
    error: asJson(state.error),
    input_tokens: state.usage.inputTokens,
    output_tokens: state.usage.outputTokens,
    cache_read_tokens: state.usage.cacheReadTokens,
    cache_write_tokens: state.usage.cacheWrite5mTokens + state.usage.cacheWrite1hTokens,
    cost_usd: Math.round(state.costUsd * 1e6) / 1e6,
    stage_timings: asJson(state.stageTimings),
    approval_expires_at: state.pendingUntil,
    finished_at: FINISHED.includes(state.status) ? now.toISOString() : null,
  };
}

/** The run's state as the engine works with it. Cache writes come back as one figure. */
export function fromRow(row: ReportRunRow): RunState {
  const intent = row.intent as { intent: Intent; flags: string[] } | null;
  const plan = row.plan as { plan: ReportPlan; unchecked: string[]; approval: RunState['approval'] } | null;
  const result = row.result as { sections: SectionResult[] } | null;
  return {
    id: row.id,
    status: row.status,
    stage: row.stage as RunStage | null,
    request: row.request,
    clarifications: (row.clarification as Clarification[] | null) ?? [],
    intent: intent?.intent ?? null,
    flags: intent?.flags ?? [],
    feasibility: row.feasibility as Feasibility | null,
    plan: plan?.plan ?? null,
    planHash: row.plan_hash,
    unchecked: plan?.unchecked ?? [],
    approval: plan?.approval ?? null,
    pendingUntil: row.approval_expires_at,
    results: result?.sections ?? null,
    error: row.error as RunFailure | null,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWrite5mTokens: row.cache_write_tokens,
      cacheWrite1hTokens: 0,
    },
    costUsd: Number(row.cost_usd),
    stageTimings: (row.stage_timings as RunState['stageTimings'] | null) ?? {},
  };
}

export interface Owner {
  ownerId: string;
  groupId: string;
}

export async function insertRun(state: RunState, { ownerId, groupId }: Owner): Promise<void> {
  const now = new Date();
  const { error } = await adminClient()
    .from('report_runs')
    .insert({ ...toRow(state, now), id: state.id, owner_id: ownerId, group_id: groupId, request: state.request, started_at: now.toISOString() });
  if (error) throw new StoreError('insert run', error.message);
}

const FINISHED_LIST = `(${FINISHED.join(',')})`;

/**
 * Saves a run that is still going. A run that has ended (say, marked failed
 * because it stalled) is never written again, and the late writer is stopped.
 */
export async function saveRun(state: RunState, ownerId: string): Promise<void> {
  const { data, error } = await adminClient()
    .from('report_runs')
    .update(toRow(state))
    .eq('id', state.id)
    .eq('owner_id', ownerId)
    .not('status', 'in', FINISHED_LIST)
    .select('id');
  if (error) throw new StoreError('save run', error.message);
  if (data.length === 0) throw new StoreError('save run', 'the run has already ended');
}

/**
 * Saves `next` only if the run is still in one of `from`, and, when given,
 * still has `planHash` (an approval) or was last saved at `updatedAt` (no one
 * has written since it was read). Of two requests racing, one wins.
 */
export async function claimRun(
  next: RunState,
  ownerId: string,
  from: readonly RunStatus[],
  { planHash, updatedAt }: { planHash?: string; updatedAt?: string } = {},
): Promise<boolean> {
  let query = adminClient()
    .from('report_runs')
    .update(toRow(next))
    .eq('id', next.id)
    .eq('owner_id', ownerId)
    .in('status', [...from]);
  if (planHash !== undefined) query = query.eq('plan_hash', planHash);
  if (updatedAt !== undefined) query = query.eq('updated_at', updatedAt);
  const { data, error } = await query.select('id');
  if (error) throw new StoreError('claim run', error.message);
  return data.length === 1;
}

/** Reads a run as the signed-in person, under RLS: someone else's run is simply not there. */
export async function loadRun(client: Client, id: string): Promise<StoredRun | null> {
  const { data, error } = await client.from('report_runs').select('*').eq('id', id).maybeSingle();
  if (error) throw new StoreError('load run', error.message);
  return data ? { state: fromRow(data), updatedAt: data.updated_at } : null;
}

export interface RunSummary {
  id: string;
  request: string;
  status: RunStatus;
  createdAt: string;
}

export async function recentRuns(client: Client, limit = 10): Promise<RunSummary[]> {
  const { data, error } = await client
    .from('report_runs')
    .select('id, request, status, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new StoreError('list runs', error.message);
  const now = new Date();
  return data.map((row) => ({
    id: row.id,
    request: row.request,
    // Opening a stalled run marks it failed; the list says so already.
    status: isStalled(row.status, row.updated_at, now) ? 'failed' : row.status,
    createdAt: row.created_at,
  }));
}

export async function runsStartedSince(ownerId: string, since: Date): Promise<number> {
  const { count, error } = await adminClient()
    .from('report_runs')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .gte('created_at', since.toISOString());
  if (error) throw new StoreError('count runs', error.message);
  return count ?? 0;
}

const PAGE = 1000;
const MAX_PAGES = 20;

/**
 * LLM spend across the household since `since`; the API key is shared. The
 * API returns at most 1,000 rows at a time, so it reads page by page. Beyond
 * 20 pages the budget is treated as spent, failing closed.
 */
export async function spentSince(since: Date): Promise<number> {
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await adminClient()
      .from('report_llm_calls')
      .select('cost_usd')
      .gte('created_at', since.toISOString())
      .order('id')
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new StoreError('sum spend', error.message);
    total += data.reduce((sum, row) => sum + Number(row.cost_usd), 0);
    if (data.length < PAGE) return total;
  }
  return Number.POSITIVE_INFINITY;
}

export async function recordLlmCall(runId: string, ownerId: string, call: LlmCallRecord): Promise<void> {
  const { error } = await adminClient()
    .from('report_llm_calls')
    .insert({
      run_id: runId,
      owner_id: ownerId,
      stage: call.stage,
      attempt: call.attempt,
      provider: call.provider,
      model_requested: call.modelRequested,
      model_served: call.modelServed,
      fallback_reason: call.fallbackReason,
      effort: call.effort,
      input_tokens: call.usage.inputTokens,
      output_tokens: call.usage.outputTokens,
      cache_read_tokens: call.usage.cacheReadTokens,
      cache_write_tokens: call.usage.cacheWrite5mTokens + call.usage.cacheWrite1hTokens,
      cost_usd: Math.round(call.costUsd * 1e6) / 1e6,
      latency_ms: call.latencyMs,
      ttft_ms: call.ttftMs,
      stop_reason: call.stopReason,
      request_id: call.requestId,
      error_class: call.errorClass,
    });
  if (error) throw new StoreError('record LLM call', error.message);
}

export async function recordQuery(runId: string, attempt: QueryAttempt): Promise<void> {
  const { error } = await adminClient()
    .from('report_queries')
    .insert({
      run_id: runId,
      section_id: attempt.section,
      attempt: attempt.attempt,
      source: attempt.source,
      sql: attempt.sql,
      fingerprint: attempt.fingerprint,
      summary: attempt.summary,
      validation: asJson({ verdict: attempt.verdict, params: attempt.params }),
      explain_cost: attempt.cost,
      row_count: attempt.rows,
      truncated: attempt.truncated !== false,
      duration_ms: attempt.durationMs,
      error: attempt.problems.length > 0 ? asJson({ problems: attempt.problems }) : null,
    });
  if (error) throw new StoreError('record query', error.message);
}

/** The code-built probes of stages 1 and 2, logged like every other SQL the run executed. */
export async function recordProbes(runId: string, queries: readonly ReportQuery[], outcomes: readonly QueryOutcome[]): Promise<void> {
  if (queries.length === 0) return;
  const { error } = await adminClient()
    .from('report_queries')
    .insert(
      queries.map((query) => {
        const outcome = outcomes.find((candidate) => candidate.id === query.id);
        return {
          run_id: runId,
          section_id: query.id,
          source: 'probe' as const,
          sql: query.sql,
          fingerprint: outcome?.ok ? outcome.fingerprint : null,
          validation: asJson({ params: query.params ?? [] }),
          explain_cost: outcome?.ok ? outcome.cost : null,
          row_count: outcome?.ok ? outcome.rows.length : null,
          truncated: outcome?.ok ? outcome.truncated !== false : false,
          duration_ms: outcome?.durationMs ?? null,
          error: outcome && !outcome.ok ? asJson({ code: outcome.error.code, message: outcome.error.message }) : null,
        };
      }),
    );
  if (error) throw new StoreError('record probes', error.message);
}

export async function recordEvent(
  action: ReportEventAction,
  { ownerId, groupId }: Owner,
  runId: string,
  details: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const { error } = await adminClient()
    .from('report_events')
    .insert({ action, actor_id: ownerId, group_id: groupId, run_id: runId, details });
  if (error) throw new StoreError('record event', error.message);
}
