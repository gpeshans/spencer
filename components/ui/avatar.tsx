import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

function Avatar({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        'relative inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full select-none',
        className,
      )}
      {...props}
    />
  );
}

function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn('size-full object-cover', className)}
      {...props}
    />
  );
}

function AvatarFallback({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        'flex size-full items-center justify-center bg-muted text-sm font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
