import { Circle } from 'lucide-react';

import { CATEGORY_ICONS } from '@/lib/category-icons';

/**
 * Renders a category's lucide icon by name. Resolves via object index access (not
 * a function call), so it satisfies react-hooks/static-components — the icon is
 * treated as data, like the existing `category.icon` property lookups. Works in
 * both server and client components.
 */
export function CategoryIcon({ name, className }: { name: string; className?: string }) {
  const Icon = CATEGORY_ICONS[name] ?? Circle;
  return <Icon className={className} />;
}
