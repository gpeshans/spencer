import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-8 px-4 pb-6 pt-4">
      <Skeleton className="h-7 w-48" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-56 w-full rounded-2xl" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-36" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
