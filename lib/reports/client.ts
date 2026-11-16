import type { RunState, RunStatus } from 'report-engine';

import { createSseParser } from './sse';

/**
 * The report pages' side of the API (app/api/reports). Requests that start work
 * stream the run's saved states; the rest answer with the run as JSON.
 * Browser code: only types come from the engine.
 */

export class ReportApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ReportApiError';
  }
}

/** Statuses in which the run is working, rather than waiting or done. */
const WORKING: ReadonlySet<RunStatus> = new Set(['received', 'planning', 'executing']);
export const isWorking = (status: RunStatus) => WORKING.has(status);

async function errorOf(response: Response): Promise<ReportApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) return new ReportApiError(response.status, body.error.code ?? 'error', body.error.message);
  } catch {
    // Not JSON: fall through.
  }
  return new ReportApiError(response.status, 'error', 'Something went wrong. Try again in a moment.');
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * POSTs and reads the event stream, calling `onState` for every state the
 * server saved. Resolves with the last state once the run pauses or ends, or
 * when the stream drops: the run goes on regardless, so the caller polls.
 */
export async function streamRun(url: string, body: unknown, onState: (state: RunState) => void): Promise<RunState | null> {
  const response = await fetch(url, json(body));
  if (!response.ok || !response.body) throw await errorOf(response);
  let last: RunState | null = null;
  const parser = createSseParser(({ event, data }) => {
    if (event !== 'state') return;
    last = data as RunState;
    onState(last);
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
  } catch {
    // The connection dropped. The run is saved on the server; polling picks it up.
  }
  return last;
}

export async function postRun(url: string, body: unknown = {}): Promise<RunState> {
  const response = await fetch(url, json(body));
  if (!response.ok) throw await errorOf(response);
  return ((await response.json()) as { run: RunState }).run;
}

export async function fetchRun(id: string): Promise<RunState> {
  const response = await fetch(`/api/reports/runs/${id}`, { cache: 'no-store' });
  if (!response.ok) throw await errorOf(response);
  return ((await response.json()) as { run: RunState }).run;
}
