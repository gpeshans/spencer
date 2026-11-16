import type { z } from 'zod';

/**
 * The engine's view of an LLM, independent of any one provider
 * (docs/report-engine-spec.md §6). The Anthropic adapter implements it today;
 * OpenRouter and others can implement it later.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface GenerateRequest<T> {
  /** Pipeline stage, for logs and cost attribution, e.g. "intent". */
  stage: string;
  /**
   * Stable context shared by many calls: the semantic model and the fixed rules.
   * It is sent first and cached, so keep it byte-identical between calls.
   */
  cachePrefix: string;
  /** This stage's instructions, sent after the cached prefix. */
  system: string;
  /** The user turn. Untrusted text inside it must already be fenced. */
  input: string;
  /**
   * The answer must match this schema. It is also converted to JSON Schema for
   * the provider, so use plain data types: no transforms, no recursion.
   */
  schema: z.ZodType<T>;
  effort: Effort;
  /** Room for thinking plus the answer. Default 16,000. */
  maxTokens?: number;
  /** Deadline for each HTTP attempt; overrides the provider's default. */
  timeoutMs?: number;
  /** Cancels the whole call, retries and fallbacks included. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  /** Input tokens not served from the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** One attempt at one model, successful or not. Spencer stores these in report_llm_calls. */
export interface LlmCallRecord {
  stage: string;
  /** 1 for the first attempt of a generate() call, then 2, 3, ... */
  attempt: number;
  provider: string;
  modelRequested: string;
  /**
   * The model that produced the response. It differs from modelRequested when
   * the provider's refusal fallback answered. Null when no response came back.
   */
  modelServed: string | null;
  /**
   * Why this attempt was made: null for the first one, "retry:<errorClass>" for
   * the second try on the same model, "fallback:<errorClass>" for the first try
   * on the fallback model, or "refusal" when the provider's refusal fallback ran.
   */
  fallbackReason: string | null;
  effort: Effort;
  usage: LlmUsage;
  costUsd: number;
  /** Wall time of the attempt, including the SDK's own retries. */
  latencyMs: number;
  /** Time to first token; null for providers that don't stream. */
  ttftMs: number | null;
  stopReason: string | null;
  requestId: string | null;
  /**
   * Null when the attempt produced a valid answer. Otherwise why it didn't:
   * - the answer: refused, truncated, empty, unparseable;
   * - the request: overloaded, server_error, rate_limited, conflict, connection,
   *   timeout, aborted, bad_request, authentication, permission, not_found,
   *   http_<status>, client_error, unknown.
   */
  errorClass: string | null;
}

export type LlmFailureCode =
  /** The model declined, and so did the refusal fallback if one ran. */
  | 'refused'
  /** The answer didn't fit in the token limit. */
  | 'truncated'
  /** The answer was empty or didn't match the schema. */
  | 'invalid_output'
  /** Overload, rate limits, server or network errors, after retries and the fallback model. */
  | 'unavailable'
  /** The API rejected the request: bad request, authentication, permission, unknown model, ... */
  | 'request_failed'
  | 'budget_exceeded'
  | 'aborted';

export interface LlmFailure {
  code: LlmFailureCode;
  message: string;
  /** For refusals: the provider's category (e.g. "cyber"), when it gave one. */
  category?: string;
}

export type GenerateResult<T> =
  | { ok: true; output: T; calls: LlmCallRecord[] }
  | { ok: false; error: LlmFailure; calls: LlmCallRecord[] };

export interface LlmProvider {
  generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/**
 * Decides whether another call may start, and learns what each one cost.
 * Spencer combines a per-run budget with a daily one backed by the database.
 *
 * The check runs before every attempt, so spend can pass the limit by at most
 * one attempt (up to maxTokens of output).
 */
export interface SpendGuard {
  before(stage: string): Promise<{ ok: true } | { ok: false; message: string }>;
  after(costUsd: number): void | Promise<void>;
}
