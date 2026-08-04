'use client';

import { BarChart3, PieChart, Plus } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/', label: 'Add', icon: Plus },
  { href: '/overview', label: 'Month', icon: PieChart },
  { href: '/year', label: 'Year', icon: BarChart3 },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-md border-t bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <ul className="grid grid-cols-3 pb-[env(safe-area-inset-bottom)]">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors active:scale-95',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-6" strokeWidth={active ? 2.5 : 2} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
