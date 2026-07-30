import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-4">
      <div className="flex items-center justify-between">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="size-10 rounded-full" />
      </div>
      <Skeleton className="h-20 w-full rounded-2xl" />
      <Skeleton className="mx-auto size-[240px] rounded-full" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
