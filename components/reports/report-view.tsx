'use client';

import { CircleAlert } from 'lucide-react';
import { formatNarrative, formatPeriod, formatValue, type FormatOptions, type ReportDocument, type ReportSection } from 'report-engine/report';

import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { ReportChart } from './report-chart';
import { ReportTable, Truncated } from './report-table';

/** A finished report, from the same document the PDF is drawn from. */
export function ReportView({ report, format, actions }: { report: ReportDocument; format: FormatOptions; actions?: React.ReactNode }) {
  const period = report.period
    ? `${formatPeriod(report.period, format)}${report.comparison ? `, compared with ${formatPeriod(report.comparison, format)}` : ''}`
    : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{report.title}</h2>
          <p className="text-sm text-muted-foreground">{report.summary}</p>
          {(period || report.assumptions.length > 0) && (
            <p className="text-xs text-muted-foreground">{[period, ...report.assumptions].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        {actions}
      </div>
      {report.narrative && (
        <div className="flex flex-col gap-1.5">
          {report.narrative.headline && <p className="font-medium">{formatNarrative(report.narrative.headline, format)}</p>}
          {report.narrative.insights.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {report.narrative.insights.map((insight, index) => (
                <li key={index}>{formatNarrative(insight, format)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {report.status === 'partial' && (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">Some sections couldn’t be computed.</p>
      )}
      {report.sections.map((section) =>
        section.block.kind === 'text' ? (
          <p key={section.id} className="text-sm">
            {section.block.text}
          </p>
        ) : (
          <SectionCard key={section.id} section={section} format={format} />
        ),
      )}
      {report.sources.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none hover:text-foreground">How these numbers were computed</summary>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 break-words">
            {report.sources.map((source) => (
              <li key={source.section}>
                <span className="font-medium">{source.title}:</span> {source.summary}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function SectionCard({ section, format }: { section: ReportSection; format: FormatOptions }) {
  const { block } = section;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{section.title}</CardTitle>
        {section.description && <CardDescription>{section.description}</CardDescription>}
        {section.verification === 'unverified' && (
          <CardAction>
            <Badge variant="outline" className="text-muted-foreground" title="These numbers couldn’t be double-checked against a second calculation.">
              Unverified
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {block.kind === 'figures' && (
          <div className="grid grid-cols-2 gap-3">
            {block.figures.map((figure, index) => (
              <div key={index} className="min-w-0 rounded-lg bg-muted/60 px-3 py-2">
                <p className="text-xs text-muted-foreground">{figure.label}</p>
                <p className="mt-0.5 text-lg font-semibold leading-tight tabular-nums">{formatValue(figure.value, figure.format, format)}</p>
              </div>
            ))}
          </div>
        )}
        {block.kind === 'chart' && (
          <>
            <ReportChart chart={block.chart} format={format} />
            {block.table.truncated && <Truncated />}
            <details className="group text-sm">
              <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                <span className="group-open:hidden">Show the numbers</span>
                <span className="hidden group-open:inline">Hide the numbers</span>
              </summary>
              <div className="mt-2">
                <ReportTable table={block.table} format={format} note={false} />
              </div>
            </details>
          </>
        )}
        {block.kind === 'table' && <ReportTable table={block.table} format={format} />}
        {block.kind === 'empty' && <p className="text-sm text-muted-foreground">No data for this section.</p>}
        {block.kind === 'failed' && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>This section couldn’t be computed.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
