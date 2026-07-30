import { IncomeForm } from '@/components/income-form';
import { getCurrentIncome } from '@/lib/reports';

export default async function IncomePage() {
  const current = await getCurrentIncome();

  return (
    <div className="flex flex-col gap-6 px-4 pb-6 pt-4">
      <h1 className="text-xl font-semibold tracking-tight">Monthly income</h1>
      <p className="text-sm text-muted-foreground">
        Set your typical monthly income by category. It applies to this month and future
        months until you change it — past months keep their own figures.
      </p>
      <IncomeForm current={current} />
    </div>
  );
}
