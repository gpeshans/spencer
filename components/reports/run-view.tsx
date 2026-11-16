'use client';

import { CircleAlert, CircleCheck, LoaderCircle, Send } from 'lucide-react';
import { useState } from 'react';
import type { PlanSection, RunStage, RunState, SectionResult } from 'report-engine';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { isWorking } from '@/lib/reports/client';

import { StatusBadge } from './status-badge';
import { LOCALE } from '@/lib/format';

/** What a run looks like on the page, by status: progress, a question, a plan to approve, or results. */

const STAGES: ReadonlyArray<{ stage: RunStage; label: string }> = [
  { stage: 'understanding', label: 'Understanding the question' },
  { stage: 'checking', label: 'Checking the data' },
  { stage: 'planning', label: 'Planning the report' },
  { stage: 'writing_sql', label: 'Writing the SQL' },
  { stage: 'validating', label: 'Checking the SQL' },
  { stage: 'executing', label: 'Running the queries' },
];

const usd = (value: number) => `$${value.toFixed(value < 0.1 ? 3 : 2)}`;

/** An open question or approval past its time can't be acted on, whatever the page last saw. */
const pastDue = (run: RunState) => run.pendingUntil !== null && Date.parse(run.pendingUntil) <= Date.now();

export interface RunViewProps {
  run: RunState;
  /** A request of ours is under way: actions wait for it. */
  sending: boolean;
  onAnswer(answer: string): void;
  onApprove(): void;
  onReject(): void;
}

export function RunView({ run, sending, onAnswer, onApprove, onReject }: RunViewProps) {
  const expired = run.status === 'expired' || ((run.status === 'needs_clarification' || run.status === 'awaiting_approval') && pastDue(run));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-base font-medium leading-snug">“{run.request}”</p>
        <StatusBadge status={expired ? 'expired' : run.status} />
      </div>
      {run.costUsd > 0 && <p className="-mt-2 text-xs text-muted-foreground">{usd(run.costUsd)} spent on this report</p>}

      {isWorking(run.status) && <Progress run={run} />}
      {expired && (
        <Note>This run waited too long for an answer and has expired. Ask again to start over.</Note>
      )}
      {!expired && run.status === 'needs_clarification' && <Question run={run} sending={sending} onAnswer={onAnswer} />}
      {!expired && run.status === 'awaiting_approval' && (
        <PlanReview run={run} sending={sending} onApprove={onApprove} onReject={onReject} />
      )}
      {(run.status === 'succeeded' || run.status === 'partial') && <Results run={run} />}
      {run.status === 'failed' && <Failure run={run} />}
      {run.status === 'rejected' && <Note>You declined this run. Nothing was run.</Note>}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

function Progress({ run }: { run: RunState }) {
  // An approved run that hasn't started yet is about to write its SQL.
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

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString(LOCALE, { maximumFractionDigits: 2 });
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function Results({ run }: { run: RunState }) {
  const plan = run.plan;
  if (!plan) return null;
  const results = new Map((run.results ?? []).map((result) => [result.section, result]));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-tight">{plan.title}</h2>
        <p className="text-sm text-muted-foreground">{plan.summary}</p>
      </div>
      {run.status === 'partial' && <Note>Some sections couldn’t be computed; they say why below.</Note>}
      {plan.sections.map((section) =>
        section.display === 'text' ? (
          <p key={section.id} className="text-sm">
            {section.purpose}
          </p>
        ) : (
          <SectionCard key={section.id} section={section} result={results.get(section.id)} unchecked={run.unchecked.includes(section.id)} />
        ),
      )}
    </div>
  );
}

function SectionCard({ section, result, unchecked }: { section: PlanSection; result?: SectionResult; unchecked: boolean }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{section.title}</CardTitle>
        {result?.summary && <CardDescription>{result.summary}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!result || result.status === 'failed' ? (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              This section couldn’t be computed
              {result && result.problems.length > 0 ? `: ${result.problems.join(' ')}` : '.'}
            </span>
          </div>
        ) : result.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rows.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  {result.columns.map((column) => (
                    <th key={column.name} className="px-2 py-1.5 font-medium">
                      {column.name.replaceAll('_', ' ')}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={index} className="border-b last:border-0">
                    {result.columns.map((column) => (
                      <td
                        key={column.name}
                        className={column.type === 'number' || column.type === 'integer' ? 'px-2 py-1.5 text-right tabular-nums' : 'px-2 py-1.5'}
                      >
                        {formatValue(row[column.name])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result?.truncated && (
          <p className="text-xs text-muted-foreground">Only the first rows are shown: the result was too large.</p>
        )}
        {unchecked && (
          <p className="text-xs text-muted-foreground">This section had no compiled cross-check.</p>
        )}
        {result?.sql && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">SQL</summary>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-2 font-mono">{result.sql}</pre>
            {result.params.length > 0 && (
              <p className="mt-1 font-mono text-muted-foreground">Parameters: {JSON.stringify(result.params)}</p>
            )}
          </details>
        )}
      </CardContent>
    </Card>
  );
}

function Failure({ run }: { run: RunState }) {
  const error = run.error;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm">
      <div className="flex items-start gap-2 text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{error?.message ?? 'The run failed.'}</span>
      </div>
      {error?.details && error.details.length > 0 && (
        <ul className="list-disc pl-6 text-muted-foreground">
          {error.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
