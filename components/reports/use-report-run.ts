'use client';

import { useCallback, useEffect, useState } from 'react';
import type { RunState } from 'report-engine';
import { toast } from 'sonner';

import { fetchRun, isWorking, postRun, ReportApiError, startPolling, streamRun } from '@/lib/reports/client';

const say = (error: unknown) =>
  toast.error(error instanceof ReportApiError ? error.message : 'Something went wrong. Try again in a moment.');

/**
 * One report run on a page: it streams while a request of ours drives it, and
 * polls while it works without a stream (after an approval, after a reload,
 * or when a stream dropped).
 */
export function useReportRun(initial: RunState | null, pollMs: number) {
  const [run, setRun] = useState<RunState | null>(initial);
  const [streaming, setStreaming] = useState(false);
  const [sending, setSending] = useState(false);

  const refresh = useCallback(async (id: string) => {
    try {
      setRun(await fetchRun(id));
    } catch {
      // The next poll or action tries again.
    }
  }, []);

  const stream = useCallback(async (url: string, body: unknown, onFirst?: (state: RunState) => void) => {
    setSending(true);
    setStreaming(true);
    let first = true;
    try {
      await streamRun(url, body, (state) => {
        setRun(state);
        if (first) {
          first = false;
          onFirst?.(state);
        }
      });
    } catch (error) {
      say(error);
    } finally {
      setStreaming(false);
      setSending(false);
    }
  }, []);

  const id = run?.id;
  const working = run ? isWorking(run.status) : false;
  useEffect(() => {
    if (!id || !working || streaming) return;
    // Stopped when a stream starts or the status changes; a late answer is dropped.
    return startPolling(id, pollMs, setRun);
  }, [id, working, streaming, pollMs]);

  const act = useCallback(
    async (action: 'approve' | 'reject', body: unknown) => {
      if (!id) return;
      setSending(true);
      try {
        setRun(await postRun(`/api/reports/runs/${id}/${action}`, body));
      } catch (error) {
        say(error);
        await refresh(id);
      } finally {
        setSending(false);
      }
    },
    [id, refresh],
  );

  return {
    run,
    streaming,
    sending,
    start: (request: string, onFirst?: (state: RunState) => void) =>
      stream('/api/reports/runs', { request }, onFirst),
    answer: (text: string) => (id ? stream(`/api/reports/runs/${id}/clarify`, { answer: text }) : Promise.resolve()),
    approve: () => act('approve', { planHash: run?.planHash ?? '' }),
    reject: () => act('reject', {}),
    reset: () => setRun(null),
  };
}
