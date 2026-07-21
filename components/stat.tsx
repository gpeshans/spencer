import { cn } from '@/lib/utils';

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-0.5 text-sm font-semibold leading-tight tabular-nums',
          tone === 'positive' && 'text-green-700 dark:text-green-400',
          tone === 'negative' && 'text-red-600 dark:text-red-400',
        )}
      >
        {value}
      </p>
    </div>
  );
}
