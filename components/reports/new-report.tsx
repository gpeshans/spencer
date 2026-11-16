'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

import { RunView } from './run-view';
import { useReportRun } from './use-report-run';

interface Suggestion {
  title: string;
  request: string;
}

/**
 * Asks a question and follows the run on this page as it streams. The address
 * changes to the run's own page, so a reload (or a closed tab, later) finds it.
 */
export function NewReport({ suggestions, pollMs }: { suggestions: Suggestion[]; pollMs: number }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const report = useReportRun(null, pollMs);
  const busy = report.sending || report.streaming;

  const submit = () => {
    const request = text.trim();
    if (!request || busy) return;
    void report.start(request, (state) => window.history.replaceState(null, '', `/reports/${state.id}`));
  };

  if (report.run) {
    return (
      <div className="flex flex-col gap-4">
        <RunView
          run={report.run}
          sending={report.sending}
          onAnswer={(answer) => void report.answer(answer)}
          onApprove={() => void report.approve()}
          onReject={() => void report.reject()}
        />
        {!report.streaming && (
          <Button
            variant="outline"
            onClick={() => {
              report.reset();
              setText('');
              window.history.replaceState(null, '', '/reports');
              router.refresh();
            }}
          >
            New report
          </Button>
        )}
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor="report-request" className="sr-only">
        Your question
      </label>
      <textarea
        id="report-request"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
        }}
        rows={3}
        maxLength={2000}
        placeholder="Ask about your spending, e.g. How much did we spend per category last month?"
        className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
      />
      <Button type="submit" size="lg" className="h-12" disabled={!text.trim() || busy}>
        {busy ? 'Starting…' : 'Ask'}
      </Button>
      {suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Or start from one of these</p>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <Button key={suggestion.title} type="button" variant="outline" size="sm" onClick={() => setText(suggestion.request)}>
                {suggestion.title}
              </Button>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
