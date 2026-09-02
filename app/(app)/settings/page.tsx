import { CategoryManager } from '@/components/settings/category-manager';
import { CurrencyEditor } from '@/components/settings/currency-editor';
import { TargetsEditor } from '@/components/settings/targets-editor';
import { getBucketTargets, getCategories } from '@/lib/categories-data';
import { getGroupContext } from '@/lib/session';

export default async function SettingsPage() {
  // getGroupContext() is React-cached, so this reuses the layout's auth round trip.
  const [{ expense, income }, targets, ctx] = await Promise.all([
    getCategories(),
    getBucketTargets(),
    getGroupContext(),
  ]);

  return (
    <div className="flex flex-col gap-8 px-4 pb-6 pt-4">
      <h1 className="text-xl font-semibold tracking-tight">Categories &amp; budget</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Currency</h2>
        <CurrencyEditor initial={ctx?.group.currency ?? 'EUR'} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Target distribution</h2>
        <p className="-mt-1 text-xs text-muted-foreground">
          How you aim to split income across the four buckets. Must total 100%.
        </p>
        <TargetsEditor initial={targets} />
      </section>

      <CategoryManager kind="expense" categories={expense} />
      <CategoryManager kind="income" categories={income} />
    </div>
  );
}
