import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-4 px-4 pb-6 pt-4">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-6 w-3/4" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-5 w-48" />
        ))}
      </div>
    </div>
  );
}
