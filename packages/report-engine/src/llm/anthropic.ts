import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';

import { addUsage, costUsd, DEFAULT_PRICES, priceOf, ZERO_USAGE, type PriceTable } from './prices';
import type { GenerateRequest, GenerateResult, LlmCallRecord, LlmFailure, LlmProvider, LlmUsage, SpendGuard } from './types';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaTextBlock = Anthropic.Beta.Messages.BetaTextBlock;
type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
type CacheTtl = '5m' | '1h';

/**
 * The Anthropic provider, on the official SDK (docs/report-engine-spec.md §6).
 *
 * Each request:
 * - asks for structured output in the stage's schema. The answer is validated
 *   with zod here, after the stop reason and the usage have been read;
 * - turns adaptive thinking on and sets `effort` explicitly (Opus 5.5 defaults
 *   to medium). It sends no sampling parameters, which these models reject;
 * - puts a cache breakpoint after the shared prefix, ahead of the stage's
 *   instructions. The cache key also covers the model, the effort and the
 *   output schema, so stages don't share an entry. It pays off when the same
 *   stage runs again within the TTL: a retry, a repair, the next question;
 * - opts into the server-side refusal fallback (`fallbacks: "default"`), which
 *   re-runs a policy decline on another model within the same call.
 *
 * When an attempt fails:
 * - 408, 409, 429, 5xx, connection errors and timeouts have already been
 *   retried with backoff by the SDK. If they persist, the call moves on to the
 *   fallback model (Sonnet 5.5);
 * - an answer that is truncated, empty or doesn't match the schema gets one
 *   more try on the same model (with twice the room, for a truncated one), then
 *   moves on to the fallback model;
 * - a refusal, any other 4xx error, or cancellation ends the call.
 *
 * Requests don't stream. Answers are small JSON documents, every attempt has a
 * deadline, and a non-streamed refusal fallback returns only the final model's
 * answer.
 */

export interface AnthropicProviderOptions {
  /** Defaults to the SDK's own lookup (ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Sends requests through this fetch, e.g. a stub in tests. */
  fetch?: typeof globalThis.fetch;
  /**
   * Default claude-opus-5-5. Like the fallback model, it must support adaptive
   * thinking, effort and structured output, as Opus 5.5 and Sonnet 5.5 do.
   */
  model?: string;
  /** Tried when the main model keeps failing; null turns it off. Default claude-sonnet-5-5. */
  fallbackModel?: string | null;
  /** Anthropic's server-side refusal fallback. Default on. */
  refusalFallback?: boolean;
  /**
   * How long the cached prefix lives. Default 5 minutes. The 1-hour TTL doubles
   * the write price and pays off only when the same stage runs again 5 to 60
   * minutes later.
   */
  cacheTtl?: CacheTtl;
  /** SDK retries within each attempt. Default 2. */
  maxRetries?: number;
  /** Deadline for each HTTP attempt. Default 120 s. */
  timeoutMs?: number;
  /** Merged over DEFAULT_PRICES. */
  prices?: PriceTable;
  /**
   * Asked before every attempt. The guard and onCall belong to the provider, so
   * create one provider per run when they are run-scoped; that is cheap.
   */
  guard?: SpendGuard;
  /**
   * Receives every attempt. If it throws, generate() rejects with that error:
   * a call that can't be recorded must not lead to more calls.
   */
  onCall?: (record: LlmCallRecord) => void | Promise<void>;
}

const PROVIDER = 'anthropic';
const DEFAULT_MAX_TOKENS = 16_000;
/** A truncated answer is retried with twice the room, up to this. */
const MAX_RETRY_TOKENS = 32_000;
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Errors the SDK has already retried. If they persist, the fallback model gets a turn. */
const TRANSIENT = new Set(['overloaded', 'server_error', 'rate_limited', 'conflict', 'connection', 'timeout']);

export function createAnthropicProvider(options: AnthropicProviderOptions = {}): LlmProvider {
  const client = new Anthropic({
    ...(options.apiKey !== undefined && { apiKey: options.apiKey }),
    ...(options.fetch && { fetch: options.fetch }),
    maxRetries: options.maxRetries ?? 2,
    timeout: options.timeoutMs ?? 120_000,
  });
  const primary = options.model ?? 'claude-opus-5-5';
  const fallback = options.fallbackModel === undefined ? 'claude-sonnet-5-5' : options.fallbackModel;
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];
  const refusalFallback = options.refusalFallback ?? true;
  const cacheTtl = options.cacheTtl ?? '5m';
  const prices: PriceTable = { ...DEFAULT_PRICES, ...options.prices };

  async function record(calls: LlmCallRecord[], call: LlmCallRecord): Promise<void> {
    calls.push(call);
    try {
      await options.onCall?.(call);
    } finally {
      await options.guard?.after(call.costUsd);
    }
  }

  async function generate<T>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const calls: LlmCallRecord[] = [];
    const fail = (error: LlmFailure): GenerateResult<T> => ({ ok: false, error, calls });
    const format = outputFormat(request.schema);
    const system = systemBlocks(request.cachePrefix, request.system, cacheTtl);
    let failure: LlmFailure = { code: 'unavailable', message: 'The model could not be reached.' };
    let previousError: string | null = null;

    for (const model of models) {
      let maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;

      for (let tryOnModel = 0; tryOnModel < 2; tryOnModel += 1) {
        if (request.signal?.aborted) return fail(aborted());
        const verdict = options.guard ? await options.guard.before(request.stage) : { ok: true as const };
        if (!verdict.ok) return fail({ code: 'budget_exceeded', message: verdict.message });

        const base = {
          stage: request.stage,
          attempt: calls.length + 1,
          provider: PROVIDER,
          modelRequested: model,
          fallbackReason: previousError && `${tryOnModel === 0 ? 'fallback' : 'retry'}:${previousError}`,
          effort: request.effort,
          ttftMs: null,
        };
        const started = performance.now();
        let response: BetaMessage & { _request_id?: string | null };
        try {
          response = await client.beta.messages.create(
            {
              model,
              max_tokens: maxTokens,
              thinking: { type: 'adaptive' },
              output_config: { effort: request.effort, format },
              ...(system.length > 0 && { system }),
              messages: [{ role: 'user', content: request.input }],
              ...(refusalFallback && { betas: [REFUSAL_FALLBACK_BETA], fallbacks: 'default' as const }),
            },
            {
              ...(request.signal && { signal: request.signal }),
              ...(request.timeoutMs !== undefined && { timeout: request.timeoutMs }),
            },
          );
        } catch (error) {
          const kind = errorKind(error);
          await record(calls, {
            ...base,
            modelServed: null,
            usage: ZERO_USAGE,
            costUsd: 0,
            latencyMs: elapsedSince(started),
            stopReason: null,
            requestId: error instanceof Anthropic.APIError ? (error.requestID ?? null) : null,
            errorClass: kind,
          });
          if (kind === 'aborted') return fail(aborted());
          if (!TRANSIENT.has(kind)) {
            // Keep the API's own explanation: it's what tells a bad schema from a missing beta or a bad key.
            const detail = apiMessageOf(error);
            return fail({
              code: 'request_failed',
              message: `The model request was rejected (${kind})${detail ? `: ${detail}` : '.'}`,
            });
          }
          failure = { code: 'unavailable', message: `The model is unavailable (${kind}).` };
          previousError = kind;
          break; // The SDK has already retried this model.
        }

        const billing = billingOf(response.usage, model, prices, cacheTtl);
        const answer = readAnswer(response, request.schema);
        await record(calls, {
          ...base,
          ...(billing.refusalFallbackRan && { fallbackReason: 'refusal' }),
          modelServed: response.model,
          usage: billing.usage,
          costUsd: billing.costUsd,
          latencyMs: elapsedSince(started),
          stopReason: response.stop_reason,
          requestId: response._request_id ?? null,
          errorClass: answer.ok ? null : answer.kind,
        });
        if (answer.ok) return { ok: true, output: answer.output, calls };
        if (answer.kind === 'refused') {
          return fail({
            code: 'refused',
            message: 'The model declined the request.',
            ...(answer.category && { category: answer.category }),
          });
        }
        failure = { code: answer.kind === 'truncated' ? 'truncated' : 'invalid_output', message: answer.message };
        previousError = answer.kind;
        if (answer.kind === 'truncated' && maxTokens < MAX_RETRY_TOKENS) {
          maxTokens = Math.min(maxTokens * 2, MAX_RETRY_TOKENS);
        }
      }
    }
    return fail(failure);
  }

  return { generate };
}

function aborted(): LlmFailure {
  return { code: 'aborted', message: 'The request was cancelled.' };
}

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * The SDK's helper turns the zod schema into the JSON Schema subset the API
 * accepts. Only that schema is sent; the answer is checked against the full zod
 * schema afterwards, so constraints the API can't express are still enforced.
 */
function outputFormat(schema: z.ZodType): Anthropic.Beta.Messages.BetaJSONOutputFormat {
  return { type: 'json_schema', schema: betaZodOutputFormat(schema).schema };
}

function systemBlocks(cachePrefix: string, instructions: string, ttl: CacheTtl): BetaTextBlockParam[] {
  const blocks: BetaTextBlockParam[] = [];
  if (cachePrefix.trim() !== '') {
    blocks.push({ type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral', ttl } });
  }
  if (instructions.trim() !== '') blocks.push({ type: 'text', text: instructions });
  return blocks;
}

type Answer<T> =
  | { ok: true; output: T }
  | { ok: false; kind: 'refused'; category?: string }
  | { ok: false; kind: 'truncated' | 'empty' | 'unparseable'; message: string };

function readAnswer<T>(response: BetaMessage, schema: z.ZodType<T>): Answer<T> {
  // The stop reason comes first: a refusal can arrive with no content at all.
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category;
    return { ok: false, kind: 'refused', ...(category && { category }) };
  }
  if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
    return { ok: false, kind: 'truncated', message: 'The answer did not fit in the token limit.' };
  }
  // After a refusal fallback, the answer is whatever follows the last switch point.
  const start = response.content.findLastIndex((block) => block.type === 'fallback') + 1;
  const text = response.content.slice(start).find((block): block is BetaTextBlock => block.type === 'text');
  if (!text || text.text.trim() === '') {
    return { ok: false, kind: 'empty', message: 'The model returned no answer.' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text.text);
  } catch {
    return { ok: false, kind: 'unparseable', message: 'The answer was not valid JSON.' };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'unparseable',
      message: `The answer did not match the schema: ${describeIssues(parsed.error.issues)}`,
    };
  }
  return { ok: true, output: parsed.data };
}

/** Paths and messages only: zod's messages describe the schema, not the values. */
function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const shown = issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return issues.length > 3 ? `${shown}; and ${issues.length - 3} more` : shown;
}

interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null;
}

function usageOf(counts: TokenCounts, ttl: CacheTtl): LlmUsage {
  // The TTL breakdown is normally there. Without it, writes count at the TTL we asked for.
  const writes = counts.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: counts.input_tokens,
    outputTokens: counts.output_tokens,
    cacheReadTokens: counts.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: counts.cache_creation?.ephemeral_5m_input_tokens ?? (ttl === '5m' ? writes : 0),
    cacheWrite1hTokens: counts.cache_creation?.ephemeral_1h_input_tokens ?? (ttl === '1h' ? writes : 0),
  };
}

/**
 * Tokens and cost of one response. After a refusal fallback, `usage.iterations`
 * lists every model that ran, each billed at its own price, while the top-level
 * usage covers only the model that answered. Declined attempts are counted even
 * where Anthropic doesn't bill them: over-counting is the safe side for budgets.
 */
function billingOf(
  usage: BetaMessage['usage'],
  model: string,
  prices: PriceTable,
  ttl: CacheTtl,
): { usage: LlmUsage; costUsd: number; refusalFallbackRan: boolean } {
  const iterations = usage.iterations ?? [];
  if (iterations.length === 0) {
    const total = usageOf(usage, ttl);
    return { usage: total, costUsd: costUsd(total, priceOf(model, prices)), refusalFallbackRan: false };
  }
  let total = ZERO_USAGE;
  let cost = 0;
  for (const iteration of iterations) {
    const part = usageOf(iteration, ttl);
    total = addUsage(total, part);
    const ranOn = ('model' in iteration && iteration.model) || model;
    cost += costUsd(part, priceOf(ranOn, prices));
  }
  return {
    usage: total,
    costUsd: cost,
    refusalFallbackRan: iterations.some((iteration) => iteration.type === 'fallback_message'),
  };
}

/** The API's message for a failed request, shortened; null when there is none. */
function apiMessageOf(error: unknown): string | null {
  const message = error instanceof Anthropic.APIError ? error.apiMessage : null;
  if (!message) return null;
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

function errorKind(error: unknown): string {
  if (error instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (error instanceof Anthropic.APIConnectionError) return 'connection';
  if (error instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (error instanceof Anthropic.InternalServerError) {
    return error.status === 529 || error.type === 'overloaded_error' ? 'overloaded' : 'server_error';
  }
  if (error instanceof Anthropic.ConflictError) return 'conflict';
  if (error instanceof Anthropic.AuthenticationError) return 'authentication';
  if (error instanceof Anthropic.PermissionDeniedError) return 'permission';
  if (error instanceof Anthropic.NotFoundError) return 'not_found';
  if (error instanceof Anthropic.BadRequestError) return 'bad_request';
  if (error instanceof Anthropic.APIError) return error.status === 408 ? 'timeout' : `http_${String(error.status)}`;
  if (error instanceof Anthropic.AnthropicError) return 'client_error';
  return 'unknown';
}
