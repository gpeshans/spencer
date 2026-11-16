import type { RunState } from 'report-engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchRun, postRun, ReportApiError, startPolling, streamRun } from './client';
import { sseMessage } from './sse';

const state = (status: RunState['status']) => ({ id: 'run-1', status }) as RunState;

function respondWith(response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** A streamed body that arrives in awkward pieces. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let start = 0; start < bytes.length; start += 5) controller.enqueue(bytes.slice(start, start + 5));
      controller.close();
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('streamRun', () => {
  it('posts JSON and hands over every streamed state, resolving with the last', async () => {
    const body = `${sseMessage('state', state('planning'))}: keep-alive\n\n${sseMessage('state', state('awaiting_approval'))}`;
    const fetch = respondWith(new Response(streamOf(body), { headers: { 'content-type': 'text/event-stream' } }));
    const seen: string[] = [];

    const last = await streamRun('/api/reports/runs', { request: 'x' }, (next) => seen.push(next.status));

    expect(seen).toEqual(['planning', 'awaiting_approval']);
    expect(last?.status).toBe('awaiting_approval');
    expect(fetch).toHaveBeenCalledWith('/api/reports/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"request":"x"}',
    });
  });

  it("turns an error answer into the server's message", async () => {
    respondWith(Response.json({ error: { code: 'rate_limited', message: 'You can start 20 reports an hour.' } }, { status: 429 }));
    const error = await streamRun('/api/reports/runs', {}, () => {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReportApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', message: 'You can start 20 reports an hour.' });
  });

  it('resolves with what it got when the connection drops, so the page can poll', async () => {
    // The first event arrives, then the connection fails on the next read.
    let delivered = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered) return controller.error(new Error('network'));
        delivered = true;
        controller.enqueue(new TextEncoder().encode(sseMessage('state', state('planning'))));
      },
    });
    respondWith(new Response(broken));
    expect((await streamRun('/x', {}, () => {}))?.status).toBe('planning');
  });
});

describe('postRun and fetchRun', () => {
  it('return the run from JSON answers', async () => {
    respondWith(Response.json({ run: state('executing') }, { status: 202 }));
    expect((await postRun('/api/reports/runs/run-1/approve', { planHash: 'h' })).status).toBe('executing');
    respondWith(Response.json({ run: state('succeeded') }));
    expect((await fetchRun('run-1')).status).toBe('succeeded');
  });

  it('fall back to a generic message when the error is not JSON', async () => {
    respondWith(new Response('<html>', { status: 502 }));
    await expect(fetchRun('run-1')).rejects.toMatchObject({ status: 502, message: 'Something went wrong. Try again in a moment.' });
  });
});

describe('startPolling', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps one request in flight, and asks again a poll interval after each answer', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(run: RunState) => void> = [];
    const load = vi.fn(() => new Promise<RunState>((resolve) => resolvers.push(resolve)));
    const seen: string[] = [];
    const stop = startPolling('run-1', 1000, (run) => seen.push(run.status), load);

    await vi.advanceTimersByTimeAsync(5000); // a slow answer: no second request meanwhile
    expect(load).toHaveBeenCalledTimes(1);
    resolvers[0]!(state('executing'));
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['executing']);
    stop();
  });

  it('drops an answer that arrives after it was stopped', async () => {
    vi.useFakeTimers();
    let resolve: (run: RunState) => void = () => {};
    const load = vi.fn(() => new Promise<RunState>((done) => (resolve = done)));
    const seen: string[] = [];
    const stop = startPolling('run-1', 1000, (run) => seen.push(run.status), load);

    await vi.advanceTimersByTimeAsync(1000);
    stop();
    resolve(state('executing'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(seen).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a failed request', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(state('succeeded'));
    const seen: string[] = [];
    const stop = startPolling('run-1', 1000, (run) => seen.push(run.status), load);
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual(['succeeded']);
    stop();
  });
});
