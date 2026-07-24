import { AddSpendingForm } from '@/components/add-spending-form';
import { todayISO } from '@/lib/format';
import { getRecentSpendings } from '@/lib/reports';

export default async function AddPage() {
  const recent = await getRecentSpendings(8);
  const today = todayISO();
  return <AddSpendingForm recent={recent} today={today} />;
}
