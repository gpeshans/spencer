import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createAnthropicProvider, type AnthropicProviderOptions } from './anthropic';
import { createRunBudget } from './budget';
import type { GenerateRequest, LlmCallRecord, SpendGuard } from './types';

// Every test answers from a stubbed fetch: nothing here reaches the API.

const Answer = z.object({ answer: z.number().int().min(0) });
type Answer = z.infer<typeof Answer>;

type Reply =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | { hang: true }
  | { throws: Error };

interface SentRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(replies: Reply[]) {
  const requests: SentRequest[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('stub: no reply left for this request');
    if ('throws' in reply) throw reply.throws;
    if ('hang' in reply) {
      // Like a real fetch, settle only when the request is aborted.
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': `req_${requests.length}`, ...reply.headers },
    });
  };
  return { fetch, requests };
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 1000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 4000,
  cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 },
  iterations: null,
};
// At Opus 5.5 prices: 100 x $4 + 1000 x $20 + 4000 x $5 (5-minute writes), per million.
const USAGE_COST = 0.0404;

function message(fields: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '{"answer":42}' },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: USAGE,
    ...fields,
  };
}

const ok = (fields: Record<string, unknown> = {}): Reply => ({ body: message(fields) });
const answering = (text: string, fields: Record<string, unknown> = {}): Reply =>
  ok({ content: [{ type: 'text', text }], ...fields });
const apiError = (status: number, type: string, headers?: Record<string, string>): Reply => ({
  status,
  body: { type: 'error', error: { type, message: `stub ${type}` } },
  ...(headers && { headers }),
});

function request(fields: Partial<GenerateRequest<Answer>> = {}): GenerateRequest<Answer> {
  return {
    stage: 'test',
    cachePrefix: 'PREFIX',
    system: 'INSTRUCTIONS',
    input: 'QUESTION',
    schema: Answer,
    effort: 'high',
    ...fields,
  };
}

function setup(replies: Reply[], options: AnthropicProviderOptions = {}) {
  const stub = stubFetch(replies);
  const records: LlmCallRecord[] = [];
  const llm = createAnthropicProvider({
    apiKey: 'test-key',
    fetch: stub.fetch,
    maxRetries: 0,
    onCall: (record) => {
      records.push(record);
    },
    ...options,
  });
  return { llm, requests: stub.requests, records };
}

describe('anthropic provider: the request', () => {
  it('sends structured output, adaptive thinking, the effort, a cached prefix and the refusal fallback', async () => {
    const { llm, requests } = setup([ok()]);
    await llm.generate(request());

    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent!.url).toContain('/v1/messages');
    expect(sent!.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    const body = sent!.body;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(16_000);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.fallbacks).toBe('default');
    expect(body.system).toEqual([
      { type: 'text', text: 'PREFIX', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { type: 'text', text: 'INSTRUCTIONS' },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: 'QUESTION' }]);
    const outputConfig = body.output_config as { effort: string; format: { type: string; schema: Record<string, unknown> } };
    expect(outputConfig.effort).toBe('high');
    expect(outputConfig.format.type).toBe('json_schema');
    expect(outputConfig.format.schema).toMatchObject({ type: 'object', properties: { answer: {} } });
    // Sampling parameters are rejected by these models, and `betas` belongs in the header.
    for (const key of ['temperature', 'top_p', 'top_k', 'betas', 'stream']) expect(body).not.toHaveProperty(key);
  });

  it('keeps enum constraints in the schema, so the API enforces them while decoding', async () => {
    const Kind = z.object({ kind: z.enum(['table', 'chart']) });
    const { llm, requests } = setup([answering('{"kind":"chart"}')]);
    const result = await llm.generate({ ...request(), schema: Kind });

    expect(result).toMatchObject({ ok: true, output: { kind: 'chart' } });
    const { format } = requests[0]!.body.output_config as { format: { schema: { properties: Record<string, unknown> } } };
    // SDK releases before 1.7.0 moved enum and const into the description instead.
    expect(format.schema.properties.kind).toEqual({ enum: ['table', 'chart'] });
  });

  it('can turn the refusal fallback off and cache for an hour', async () => {
    const { llm, requests } = setup([ok()], { refusalFallback: false, cacheTtl: '1h' });
    await llm.generate(request());

    const { headers, body } = requests[0]!;
    expect(headers.get('anthropic-beta')).toBeNull();
    expect(body).not.toHaveProperty('fallbacks');
    expect((body.system as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
  });

  it('leaves out empty system parts', async () => {
    const { llm, requests } = setup([ok(), ok()]);
    await llm.generate(request({ system: '  ' }));
    await llm.generate(request({ cachePrefix: '', system: '' }));

    expect(requests[0]!.body.system).toEqual([
      { type: 'text', text: 'PREFIX', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ]);
    expect(requests[1]!.body).not.toHaveProperty('system');
  });

  it('uses the configured model and max tokens', async () => {
    const { llm, requests } = setup([ok()], { model: 'claude-sonnet-5-5' });
    await llm.generate(request({ maxTokens: 4000, effort: 'low' }));

    expect(requests[0]!.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4000 });
    expect((requests[0]!.body.output_config as { effort: string }).effort).toBe('low');
  });
});

describe('anthropic provider: answers', () => {
  it('returns the validated answer and records the attempt', async () => {
    const { llm, records } = setup([ok()]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: true, output: { answer: 42 } });
    expect(result.calls).toEqual(records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      stage: 'test',
      attempt: 1,
      provider: 'anthropic',
      modelRequested: 'claude-opus-5-5',
      modelServed: 'claude-opus-5-5',
      fallbackReason: null,
      effort: 'high',
      usage: { inputTokens: 100, outputTokens: 1000, cacheReadTokens: 0, cacheWrite5mTokens: 4000, cacheWrite1hTokens: 0 },
      ttftMs: null,
      stopReason: 'end_turn',
      requestId: 'req_1',
      errorClass: null,
    });
    expect(records[0]!.costUsd).toBeCloseTo(USAGE_COST, 10);
    expect(records[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('counts cache reads, and writes without a TTL breakdown at the requested TTL', async () => {
    const { llm, records } = setup(
      [
        ok({ usage: { ...USAGE, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, cache_creation: null } }),
        ok({ usage: { ...USAGE, cache_creation: null } }),
      ],
      { cacheTtl: '1h' },
    );
    await llm.generate(request());
    await llm.generate(request());

    expect(records[0]!.usage).toMatchObject({ cacheReadTokens: 4000, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });
    // 100 x $4 + 1000 x $20 + 4000 x $0.20, per million.
    expect(records[0]!.costUsd).toBeCloseTo(0.0212, 10);
    expect(records[1]!.usage).toMatchObject({ cacheWrite5mTokens: 0, cacheWrite1hTokens: 4000 });
  });

  it('reports a refusal without retrying it', async () => {
    const { llm, requests, records } = setup([
      ok({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } }),
    ]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: false, error: { code: 'refused', category: 'cyber' } });
    expect(requests).toHaveLength(1);
    expect(records[0]).toMatchObject({ stopReason: 'refusal', errorClass: 'refused' });
  });

  it('takes the answer of the refusal fallback and bills every model that ran', async () => {
    const { llm, records } = setup([
      ok({
        model: 'claude-opus-5',
        content: [
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
          { type: 'text', text: '{"answer":7}' },
        ],
        usage: {
          ...USAGE,
          iterations: [
            { type: 'message', model: 'claude-opus-5-5', input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
            { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 100, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null },
          ],
        },
      }),
    ]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: true, output: { answer: 7 } });
    expect(records[0]).toMatchObject({
      modelRequested: 'claude-opus-5-5',
      modelServed: 'claude-opus-5',
      fallbackReason: 'refusal',
      usage: { inputTokens: 200, outputTokens: 1000 },
    });
    // 100 x $4 on Opus 5.5, then 100 x $5 + 1000 x $25 on Opus 5, per million.
    expect(records[0]!.costUsd).toBeCloseTo(0.0259, 10);
  });

  it('reads only the answer after the last fallback boundary', async () => {
    const { llm } = setup([
      ok({
        content: [
          { type: 'text', text: '{"answ' },
          { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
          { type: 'text', text: '{"answer":3}' },
        ],
      }),
    ]);
    expect(await llm.generate(request())).toMatchObject({ ok: true, output: { answer: 3 } });
  });

  it('retries a truncated answer with twice the room, and records what the truncated one cost', async () => {
    const { llm, requests, records } = setup([ok({ stop_reason: 'max_tokens', content: [] }), ok()]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: true, output: { answer: 42 } });
    expect(requests.map((sent) => sent.body.max_tokens)).toEqual([16_000, 32_000]);
    expect(records.map((call) => [call.errorClass, call.fallbackReason])).toEqual([
      ['truncated', null],
      [null, 'retry:truncated'],
    ]);
    expect(records[0]!.costUsd).toBeCloseTo(USAGE_COST, 10);
  });

  it('never lowers a large max tokens on the retry', async () => {
    const { llm, requests } = setup([ok({ stop_reason: 'max_tokens', content: [] }), ok()]);
    await llm.generate(request({ maxTokens: 40_000 }));

    expect(requests.map((sent) => sent.body.max_tokens)).toEqual([40_000, 40_000]);
  });

  it('retries an answer that fails the schema once, then moves on to the fallback model', async () => {
    const { llm, requests, records } = setup([answering('{"answer":-1}'), answering('not json'), ok()]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: true, output: { answer: 42 } });
    expect(requests.map((sent) => [sent.body.model, sent.body.max_tokens])).toEqual([
      ['claude-opus-5-5', 16_000],
      ['claude-opus-5-5', 16_000],
      ['claude-sonnet-5-5', 16_000],
    ]);
    expect(records.map((call) => [call.attempt, call.errorClass, call.fallbackReason])).toEqual([
      [1, 'unparseable', null],
      [2, 'unparseable', 'retry:unparseable'],
      [3, null, 'fallback:unparseable'],
    ]);
  });

  it('fails with the schema issues after every model has tried', async () => {
    const { llm, records } = setup([1, 2, 3, 4].map(() => answering('{"answer":-1}')));
    const result = await llm.generate(request());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_output');
    expect(result.error.message).toContain('answer:');
    expect(records).toHaveLength(4);
  });

  it('treats a response without text as empty', async () => {
    const { llm, records } = setup([ok({ content: [{ type: 'thinking', thinking: '', signature: 'sig' }] }), ok()]);
    const result = await llm.generate(request());

    expect(result.ok).toBe(true);
    expect(records.map((call) => call.errorClass)).toEqual(['empty', null]);
  });
});

describe('anthropic provider: errors', () => {
  it('moves on to the fallback model when the main one is overloaded', async () => {
    const { llm, requests, records } = setup([apiError(529, 'overloaded_error'), ok({ model: 'claude-sonnet-5-5' })]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: true, output: { answer: 42 } });
    expect(requests.map((sent) => sent.body.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(records[0]).toMatchObject({
      errorClass: 'overloaded',
      modelServed: null,
      costUsd: 0,
      requestId: 'req_1',
      stopReason: null,
    });
    expect(records[1]).toMatchObject({ modelServed: 'claude-sonnet-5-5', fallbackReason: 'fallback:overloaded' });
  });

  it('lets the SDK retry before it moves on', async () => {
    const { llm, requests, records } = setup([apiError(500, 'api_error', { 'retry-after-ms': '1' }), ok()], {
      maxRetries: 1,
    });
    const result = await llm.generate(request());

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(records).toHaveLength(1);
    expect(records[0]!.modelRequested).toBe('claude-opus-5-5');
  });

  it.each([
    [400, 'invalid_request_error', 'bad_request'],
    [401, 'authentication_error', 'authentication'],
    [403, 'permission_error', 'permission'],
    [404, 'not_found_error', 'not_found'],
  ])('fails at once on a %i', async (status, type, errorClass) => {
    const { llm, requests, records } = setup([apiError(status, type)]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: false, error: { code: 'request_failed' } });
    expect(requests).toHaveLength(1);
    expect(records[0]!.errorClass).toBe(errorClass);
  });

  it("keeps the API's explanation of a rejected request", async () => {
    const { llm } = setup([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too   complex for compilation.' } } },
    ]);
    expect(await llm.generate(request())).toMatchObject({
      ok: false,
      error: { code: 'request_failed', message: 'The model request was rejected (bad_request): Schema is too complex for compilation.' },
    });
  });

  it('classifies rate limits and server errors as transient', async () => {
    const { llm, records } = setup([apiError(429, 'rate_limit_error'), apiError(500, 'api_error')]);
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(records.map((call) => [call.modelRequested, call.errorClass])).toEqual([
      ['claude-opus-5-5', 'rate_limited'],
      ['claude-sonnet-5-5', 'server_error'],
    ]);
  });

  it('treats a failed connection as transient', async () => {
    const { llm, records } = setup([{ throws: new TypeError('fetch failed') }, ok()]);
    const result = await llm.generate(request());

    expect(result.ok).toBe(true);
    expect(records.map((call) => call.errorClass)).toEqual(['connection', null]);
  });

  it('gives each attempt a deadline', async () => {
    const { llm, records } = setup([{ hang: true }, ok()], { timeoutMs: 20 });
    const result = await llm.generate(request());

    expect(result.ok).toBe(true);
    expect(records.map((call) => [call.modelRequested, call.errorClass])).toEqual([
      ['claude-opus-5-5', 'timeout'],
      ['claude-sonnet-5-5', null],
    ]);
  });

  it('lets a request set its own deadline', async () => {
    const { llm, records } = setup([{ hang: true }, ok()], { timeoutMs: 60_000 });
    const result = await llm.generate(request({ timeoutMs: 20 }));

    expect(result.ok).toBe(true);
    expect(records[0]!.errorClass).toBe('timeout');
  });

  it('stops when the caller cancels, without trying the fallback model', async () => {
    const { llm, requests, records } = setup([{ hang: true }, ok()]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await llm.generate(request({ signal: controller.signal }));

    expect(result).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(requests).toHaveLength(1);
    expect(records.map((call) => call.errorClass)).toEqual(['aborted']);
  });

  it('sends nothing when already cancelled', async () => {
    const { llm, requests, records } = setup([ok()]);
    const result = await llm.generate(request({ signal: AbortSignal.abort() }));

    expect(result).toMatchObject({ ok: false, error: { code: 'aborted' } });
    expect(requests).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('has no fallback model when it is turned off', async () => {
    const { llm, records } = setup([apiError(529, 'overloaded_error')], { fallbackModel: null });
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(records).toHaveLength(1);
  });
});

describe('anthropic provider: budget and recording', () => {
  it('checks the guard before sending anything', async () => {
    const guard: SpendGuard = {
      before: async () => ({ ok: false, message: 'Daily budget reached.' }),
      after: () => {},
    };
    const { llm, requests } = setup([ok()], { guard });
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: false, error: { code: 'budget_exceeded', message: 'Daily budget reached.' } });
    expect(requests).toHaveLength(0);
  });

  it('stops a run once its budget is spent', async () => {
    const budget = createRunBudget(0.04);
    const { llm, requests } = setup([ok(), ok()], { guard: budget });

    expect((await llm.generate(request())).ok).toBe(true);
    expect(budget.spentUsd()).toBeCloseTo(USAGE_COST, 10);
    expect(await llm.generate(request())).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(requests).toHaveLength(1);
  });

  it('checks the budget before a retry too', async () => {
    const budget = createRunBudget(0.04);
    const { llm, requests, records } = setup([ok({ stop_reason: 'max_tokens', content: [] }), ok()], {
      guard: budget,
    });
    const result = await llm.generate(request());

    expect(result).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(requests).toHaveLength(1);
    expect(records.map((call) => call.errorClass)).toEqual(['truncated']);
  });

  it('fails the call when recording fails, and still tells the guard what it cost', async () => {
    const budget = createRunBudget(1);
    const { llm } = setup([ok()], {
      guard: budget,
      onCall: () => {
        throw new Error('insert failed');
      },
    });

    await expect(llm.generate(request())).rejects.toThrow('insert failed');
    expect(budget.spentUsd()).toBeCloseTo(USAGE_COST, 10);
  });

  it('merges custom prices over the defaults', async () => {
    const price = { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 };
    const { llm, records } = setup([ok()], {
      model: 'claude-test',
      prices: { 'claude-test': price },
    });
    await llm.generate(request());

    // 100 + 1000 + 4000 tokens at $1 per million.
    expect(records[0]!.costUsd).toBeCloseTo(0.0051, 10);
  });
});
