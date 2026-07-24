import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-32 w-full rounded-2xl" />
      <div className="grid grid-cols-4 gap-2">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-11 w-full rounded-lg" />
      <Skeleton className="h-11 w-full rounded-lg" />
    </div>
  );
}
