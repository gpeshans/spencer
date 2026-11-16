/**
 * Server-sent events framing, for the requests that start work on a report run
 * (docs/report-engine-spec.md §9). The browser reads the response with fetch(),
 * not EventSource: starting a run is a POST, and EventSource reconnects by
 * itself. Plain Web APIs only, so the browser can share the parser.
 */

const EVENT_NAME = /^[a-z][a-z_]*$/;

/** One message. JSON never contains a raw line break, so the data fits on one line. */
export function sseMessage(event: string, data: unknown): string {
  if (!EVENT_NAME.test(event)) throw new Error(`sseMessage: event "${event}" must be lowercase letters and _`);
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Turns chunks of an event stream into events. Chunks may split a message
 * anywhere; comment lines (keep-alives) are skipped.
 */
export function createSseParser(onEvent: (event: SseEvent) => void): { push(chunk: string): void } {
  let buffer = '';
  // A \r at the end of a chunk may be the first half of \r\n: hold it back.
  let heldCr = false;
  return {
    push(chunk) {
      let text = (heldCr ? '\r' : '') + chunk;
      heldCr = text.endsWith('\r');
      if (heldCr) text = text.slice(0, -1);
      buffer += text.replace(/\r\n?/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length > 0) onEvent({ event, data: JSON.parse(data.join('\n')) as unknown });
        end = buffer.indexOf('\n\n');
      }
    },
  };
}

/** Sent every so often while a long LLM call has nothing to report, so no proxy drops the connection. */
export const KEEP_ALIVE_MS = 15_000;

export interface EventStream {
  /** Sends an event. Ignored once the stream is closed or the client has gone away. */
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
  readonly response: Response;
}

export function createEventStream({ keepAliveMs = KEEP_ALIVE_MS } = {}): EventStream {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stop = () => {
    closed = true;
    if (timer !== undefined) clearInterval(timer);
  };
  const write = (text: string) => {
    if (closed || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      stop();
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      timer = setInterval(() => write(': keep-alive\n\n'), keepAliveMs);
    },
    // The client went away; the work goes on, it just isn't watched.
    cancel: stop,
  });

  return {
    send: (event, data) => write(sseMessage(event, data)),
    close() {
      if (closed) return;
      stop();
      try {
        controller?.close();
      } catch {
        // Already closed by the client.
      }
    },
    get closed() {
      return closed;
    },
    response: new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    }),
  };
}
