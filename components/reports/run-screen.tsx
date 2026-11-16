'use client';

import type { RunState } from 'report-engine';

import { RunView } from './run-view';
import { useReportRun } from './use-report-run';

/** A saved run on its own page: it picks up where the run is, and polls while it works. */
export function RunScreen({ initial, pollMs }: { initial: RunState; pollMs: number }) {
  const report = useReportRun(initial, pollMs);
  if (!report.run) return null;
  return (
    <RunView
      run={report.run}
      sending={report.sending}
      onAnswer={(answer) => void report.answer(answer)}
      onApprove={() => void report.approve()}
      onReject={() => void report.reject()}
    />
  );
}
