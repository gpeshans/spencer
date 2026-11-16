import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEventStream, createSseParser, sseMessage, type SseEvent } from './sse';

async function readAll(response: Response): Promise<string> {
  return await response.text();
}

describe('sseMessage', () => {
  it('frames one JSON event, line breaks escaped', () => {
    expect(sseMessage('state', { text: 'two\nlines' })).toBe('event: state\ndata: {"text":"two\\nlines"}\n\n');
    expect(() => sseMessage('State!', {})).toThrow('lowercase');
  });
});

describe('createSseParser', () => {
  it('reassembles events split anywhere, and skips keep-alives', () => {
    const events: SseEvent[] = [];
    const parser = createSseParser((event) => events.push(event));
    const text = `: keep-alive\n\n${sseMessage('state', { n: 1 })}${sseMessage('state', { n: 2 })}`.replace(/\n/g, '\r\n');
    for (let start = 0; start < text.length; start += 7) parser.push(text.slice(start, start + 7));
    expect(events).toEqual([
      { event: 'state', data: { n: 1 } },
      { event: 'state', data: { n: 2 } },
    ]);
  });
});

describe('createEventStream', () => {
  afterEach(() => vi.useRealTimers());

  it('streams events until closed, as an unbuffered event stream', async () => {
    const stream = createEventStream();
    stream.send('state', { status: 'planning' });
    stream.send('state', { status: 'executing' });
    stream.close();
    stream.send('state', { status: 'ignored' });

    expect(stream.closed).toBe(true);
    expect(stream.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(stream.response.headers.get('cache-control')).toBe('no-cache, no-transform');
    const events: SseEvent[] = [];
    createSseParser((event) => events.push(event)).push(await readAll(stream.response));
    expect(events.map((event) => event.data)).toEqual([{ status: 'planning' }, { status: 'executing' }]);
  });

  it('sends keep-alives while nothing happens', async () => {
    vi.useFakeTimers();
    const stream = createEventStream({ keepAliveMs: 1000 });
    vi.advanceTimersByTime(2500);
    stream.close();
    expect(await readAll(stream.response)).toBe(': keep-alive\n\n: keep-alive\n\n');
  });

  it('stops writing, without errors, once the client goes away', async () => {
    const stream = createEventStream();
    await stream.response.body!.cancel();
    expect(stream.closed).toBe(true);
    expect(() => stream.send('state', {})).not.toThrow();
    expect(() => stream.close()).not.toThrow();
  });
});
