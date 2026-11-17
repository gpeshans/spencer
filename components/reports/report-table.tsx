import { formatValue, isNumeric, type FormatOptions, type ReportTable as Table } from 'report-engine/report';

import { cn } from '@/lib/utils';

/**
 * A section's rows, each value shown as its column says: amounts in the
 * currency, months by name. `note` says when rows were cut; it's off where the
 * section says so itself.
 */
export function ReportTable({ table, format, note = true }: { table: Table; format: FormatOptions; note?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {table.columns.map((column, index) => (
                <th key={index} className={cn('px-2 py-1.5 font-medium', isNumeric(column.format) && 'text-right')}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b last:border-0">
                {table.columns.map((column, index) => (
                  <td
                    key={index}
                    className={cn('px-2 py-1.5', isNumeric(column.format) && 'text-right whitespace-nowrap tabular-nums')}
                  >
                    {formatValue(row[column.key], column.format, format)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && table.truncated && <Truncated />}
    </div>
  );
}

export function Truncated() {
  return <p className="text-xs text-muted-foreground">Only the first rows are shown: the result was too large.</p>;
}
