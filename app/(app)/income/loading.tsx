import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-8 w-20" />
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="flex flex-col gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-5 flex-1" />
            <Skeleton className="h-9 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}
