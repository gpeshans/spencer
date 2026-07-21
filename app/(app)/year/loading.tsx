import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="flex items-center justify-between">
        <Skeleton className="size-10 rounded-full" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="size-10 rounded-full" />
      </div>
      <Skeleton className="h-20 w-full rounded-2xl" />
      <Skeleton className="aspect-[4/3] w-full rounded-xl" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
