'use client';

import { CircleAlert } from 'lucide-react';
import { formatValue, type FormatOptions, type ReportDocument, type ReportSection } from 'report-engine/report';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { ReportChart } from './report-chart';
import { ReportTable, Truncated } from './report-table';

/** A finished report, from the same document the PDF is drawn from. */
export function ReportView({ report, format, actions }: { report: ReportDocument; format: FormatOptions; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-semibold tracking-tight">{report.title}</h2>
          <p className="text-sm text-muted-foreground">{report.summary}</p>
        </div>
        {actions}
      </div>
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
