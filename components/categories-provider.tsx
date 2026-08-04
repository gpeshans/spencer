'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';

import {
  type Category,
  type CategoryDTO,
  resolveCategory,
  toCategory,
} from '@/lib/categories';

type CategoriesValue = {
  /** Active expense categories, sorted — for pickers. */
  expense: Category[];
  /** Active income categories, sorted — for pickers. */
  income: Category[];
  /** All expense categories (incl. archived), by key — for resolving history. */
  expenseByKey: Record<string, Category>;
  incomeByKey: Record<string, Category>;
};

const CategoriesContext = createContext<CategoriesValue | null>(null);

function byKey(list: Category[]): Record<string, Category> {
  return Object.fromEntries(list.map((c) => [c.key, c]));
}

export function CategoriesProvider({
  expense,
  income,
  children,
}: {
  expense: CategoryDTO[];
  income: CategoryDTO[];
  children: React.ReactNode;
}) {
  const value = useMemo<CategoriesValue>(() => {
    const activeSorted = (list: CategoryDTO[]) =>
      list.filter((d) => d.active).sort((a, b) => a.sort - b.sort).map(toCategory);
    return {
      expense: activeSorted(expense),
      income: activeSorted(income),
      expenseByKey: byKey(expense.map(toCategory)),
      incomeByKey: byKey(income.map(toCategory)),
    };
  }, [expense, income]);

  return <CategoriesContext.Provider value={value}>{children}</CategoriesContext.Provider>;
}

function useCategoriesContext(): CategoriesValue {
  const ctx = useContext(CategoriesContext);
  if (!ctx) throw new Error('useCategories* must be used within a CategoriesProvider');
  return ctx;
}

/** Active expense categories, sorted (for pickers/chips). */
export function useExpenseCategories(): Category[] {
  return useCategoriesContext().expense;
}

/** Active income categories, sorted (for the income form). */
export function useIncomeCategories(): Category[] {
  return useCategoriesContext().income;
}

/** A stable resolver key→Category over ALL expense categories (incl. archived). */
export function useExpenseResolver(): (key: string) => Category {
  const { expenseByKey } = useCategoriesContext();
  return useCallback((key: string) => resolveCategory(expenseByKey, key), [expenseByKey]);
}
