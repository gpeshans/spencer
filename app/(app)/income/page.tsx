import { IncomeForm } from '@/components/income-form';
import { SignOutButton } from '@/components/sign-out-button';
import { getCurrentIncome } from '@/lib/reports';

export default async function IncomePage() {
  const current = await getCurrentIncome();

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Monthly income</h1>
        <SignOutButton />
      </div>
      <p className="text-sm text-muted-foreground">
        Set your typical monthly income by category. It applies to this month and future
        months until you change it — past months keep their own figures.
      </p>
      <IncomeForm current={current} />
    </div>
  );
}
