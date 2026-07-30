import { cn } from '@/lib/utils';

/**
 * The "Spencer" logo: an alphabetic wordmark in the modern display face
 * (Space Grotesk) and the brand green. Shared by the app top bar and the login
 * hero so the mark stays identical everywhere. Size comes from `className`
 * (defaults to `text-xl`).
 */
export function Wordmark({
  as: Tag = 'span',
  className,
}: {
  as?: 'span' | 'h1';
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        'font-[family-name:var(--font-brand)] text-xl font-bold tracking-tight text-brand',
        className,
      )}
    >
      Spencer
    </Tag>
  );
}
