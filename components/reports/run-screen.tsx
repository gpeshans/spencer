'use client';

import type { RunState } from 'report-engine';

import type { ReportPresentation } from '@/lib/reports/presentation';

import { RunView } from './run-view';
import { useReportRun } from './use-report-run';

/** A saved run on its own page: it picks up where the run is, and polls while it works. */
export function RunScreen({ initial, pollMs, presentation }: { initial: RunState; pollMs: number; presentation: ReportPresentation }) {
  const report = useReportRun(initial, pollMs);
  if (!report.run) return null;
  return (
    <RunView
      run={report.run}
      presentation={presentation}
      sending={report.sending}
      onAnswer={(answer) => void report.answer(answer)}
      onApprove={() => void report.approve()}
      onReject={() => void report.reject()}
    />
  );
}
