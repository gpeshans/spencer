'use client';

import { CircleAlert, CircleCheck, LoaderCircle, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PlanSection, RunStage, RunState } from 'report-engine';
import { buildReport, reportFileName } from 'report-engine/report';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DEFAULT_CURRENCY, LOCALE, todayISO } from '@/lib/format';
import { isWorking } from '@/lib/reports/client';
import type { ReportPresentation } from '@/lib/reports/presentation';

import { DownloadPdf } from './download-pdf';
import { ReportView } from './report-view';
import { StatusBadge } from './status-badge';

/**
 * What a run looks like on the page, by status: progress, a question, a plan
 * to approve, or the report. How it was computed (cost, why a section failed)
 * waits in a collapsed "Details" line at the end; the SQL stays in the logs.
 */

const STAGES: ReadonlyArray<{ stage: RunStage; label: string }> = [
  { stage: 'understanding', label: 'Understanding the question' },
  { stage: 'checking', label: 'Checking the data' },
  { stage: 'planning', label: 'Planning the report' },
  { stage: 'writing_sql', label: 'Writing the queries' },
  { stage: 'validating', label: 'Checking the queries' },
  { stage: 'executing', label: 'Running the queries' },
];

const usd = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

/** An open question or approval past its time can't be acted on, whatever the page last saw. */
const pastDue = (run: RunState) => run.pendingUntil !== null && Date.parse(run.pendingUntil) <= Date.now();

/** Failure details people can act on: the dates that have data, or the question still open. */
const USEFUL_DETAILS: ReadonlySet<string> = new Set(['infeasible', 'unclear']);

export interface RunViewProps {
  run: RunState;
  /** Names, units and colours for the report. */
  presentation: ReportPresentation;
  /** A request of ours is under way: actions wait for it. */
  sending: boolean;
  onAnswer(answer: string): void;
  onApprove(): void;
  onReject(): void;
}

export function RunView({ run, presentation, sending, onAnswer, onApprove, onReject }: RunViewProps) {
  const expired = run.status === 'expired' || ((run.status === 'needs_clarification' || run.status === 'awaiting_approval') && pastDue(run));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-base font-medium leading-snug">“{run.request}”</p>
        <StatusBadge status={expired ? 'expired' : run.status} />
      </div>

      {isWorking(run.status) && <Progress run={run} />}
      {expired && (
        <Note>This run waited too long for an answer and has expired. Ask again to start over.</Note>
      )}
      {!expired && run.status === 'needs_clarification' && <Question run={run} sending={sending} onAnswer={onAnswer} />}
      {!expired && run.status === 'awaiting_approval' && (
        <PlanReview run={run} sending={sending} onApprove={onApprove} onReject={onReject} />
      )}
      {(run.status === 'succeeded' || run.status === 'partial') && <Results run={run} presentation={presentation} />}
      {run.status === 'failed' && <Failure run={run} />}
      {run.status === 'rejected' && <Note>You declined this run. Nothing was run.</Note>}
      <RunDetails run={run} />
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

function Progress({ run }: { run: RunState }) {
  // An approved run that hasn't started yet is about to write its queries.
  const current = run.stage ?? (run.status === 'executing' ? 'writing_sql' : 'understanding');
  const at = STAGES.findIndex((entry) => entry.stage === current);
  const visible = run.status === 'executing' ? STAGES : STAGES.slice(0, 3);
  return (
    <ol className="flex flex-col gap-2" aria-live="polite">
      {visible.map((entry, index) => (
        <li
          key={entry.stage}
          className={index > at ? 'flex items-center gap-2 text-sm text-muted-foreground' : 'flex items-center gap-2 text-sm'}
        >
          {index < at ? (
            <CircleCheck className="size-4 text-primary" />
          ) : index === at ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <span className="size-4 rounded-full border" />
          )}
          {entry.label}
        </li>
      ))}
    </ol>
  );
}

function Question({ run, sending, onAnswer }: { run: RunState; sending: boolean; onAnswer(answer: string): void }) {
  const [text, setText] = useState('');
  const open = run.clarifications.at(-1);
  if (!open) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{open.question}</CardTitle>
        <CardDescription>Your answer goes back into planning.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {open.options.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {open.options.map((option) => (
              <Button key={option} variant="outline" size="sm" disabled={sending} onClick={() => onAnswer(option)}>
                {option}
              </Button>
            ))}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) onAnswer(text.trim());
          }}
        >
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Or answer in your own words"
            maxLength={500}
            disabled={sending}
            aria-label="Your answer"
          />
          <Button type="submit" size="icon-lg" disabled={sending || !text.trim()} aria-label="Send the answer">
            <Send />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const DISPLAY_LABEL: Record<PlanSection['display'], string> = {
  figure: 'Figure',
  table: 'Table',
  bar: 'Bar chart',
  line: 'Line chart',
  pie: 'Pie chart',
  text: 'Text',
};

function PlanReview({
  run,
  sending,
  onApprove,
  onReject,
}: {
  run: RunState;
  sending: boolean;
  onApprove(): void;
  onReject(): void;
}) {
  const plan = run.plan;
  if (!plan) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{plan.title}</CardTitle>
        <CardDescription>{plan.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {run.approval && run.approval.reasons.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm">
            <p className="font-medium">Why it asks before running</p>
            <ul className="list-disc pl-5 text-muted-foreground">
              {run.approval.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        <ol className="flex flex-col gap-3">
          {plan.sections.map((section) => (
            <li key={section.id} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-medium">{section.title}</span>
                <Badge variant="outline">{DISPLAY_LABEL[section.display]}</Badge>
              </div>
              <span className="text-sm text-muted-foreground">{section.purpose}</span>
            </li>
          ))}
        </ol>
        {run.approval && (
          <p className="text-xs text-muted-foreground">
            Running it costs about {usd(run.approval.estimateUsd)} more.
          </p>
        )}
        <div className="flex gap-2">
          <Button size="lg" className="flex-1" disabled={sending} onClick={onApprove}>
            {sending ? 'Working…' : 'Approve and run'}
          </Button>
          <Button size="lg" variant="outline" disabled={sending} onClick={onReject}>
            Decline
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Results({ run, presentation }: { run: RunState; presentation: ReportPresentation }) {
  const report = useMemo(
    () => buildReport(run, presentation.vocabulary, { currency: DEFAULT_CURRENCY, styles: presentation.styles }),
    [run, presentation],
  );
  if (!report) return null;
  return (
    <ReportView
      report={report}
      format={{ locale: LOCALE, currency: report.currency }}
      actions={<DownloadPdf runId={run.id} fileName={reportFileName(report.title, todayISO())} />}
    />
  );
}

function Failure({ run }: { run: RunState }) {
  const error = run.error;
  const details = error && USEFUL_DETAILS.has(error.code) ? (error.details ?? []) : [];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm">
      <div className="flex items-start gap-2 text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{error?.message ?? 'The run failed.'}</span>
      </div>
      {details.length > 0 && (
        <ul className="list-disc pl-6 text-muted-foreground">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How the run went, for the curious: its cost and why anything failed. Collapsed, at the end. */
function RunDetails({ run }: { run: RunState }) {
  const titles = new Map(run.plan?.sections.map((section) => [section.id, section.title]));
  const failed = (run.results ?? []).filter((result) => result.status === 'failed' && result.problems.length > 0);
  // A run whose sections failed lists the same problems per section, above.
  const errorDetails =
    run.error && !USEFUL_DETAILS.has(run.error.code) && run.error.code !== 'sections_failed' ? (run.error.details ?? []) : [];
  if (run.costUsd <= 0 && failed.length === 0 && errorDetails.length === 0) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none hover:text-foreground">Details</summary>
      <div className="mt-2 flex flex-col gap-2 break-words">
        {run.costUsd > 0 && <p>This report cost {usd(run.costUsd)} in model usage.</p>}
        {failed.map((result) => (
          <div key={result.section}>
            <p className="font-medium">{titles.get(result.section) ?? result.section} couldn’t be computed:</p>
            <ul className="list-disc pl-5">
              {result.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ))}
        {errorDetails.length > 0 && (
          <ul className="list-disc pl-5">
            {errorDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
