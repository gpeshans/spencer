import type { SpendGuard } from './types';

/**
 * A per-run spend limit (docs/report-engine-spec.md §5.7; default $0.50). A run
 * spans several requests (planning, then execution after approval), so it can
 * start from what the run has already spent.
 */
export function createRunBudget(maxUsd: number, alreadySpentUsd = 0): SpendGuard & { spentUsd(): number } {
  if (!(maxUsd > 0)) throw new Error('createRunBudget: maxUsd must be positive');
  if (!(alreadySpentUsd >= 0)) throw new Error('createRunBudget: alreadySpentUsd must not be negative');
  let spent = alreadySpentUsd;
  return {
    async before() {
      return spent < maxUsd
        ? { ok: true }
        : { ok: false, message: `This run reached its budget of $${maxUsd.toFixed(2)}.` };
    },
    after(cost) {
      spent += Math.max(0, cost);
    },
    spentUsd: () => spent,
  };
}

/** Allows a call only when every guard does; reports each call's cost to all of them. */
export function allGuards(...guards: SpendGuard[]): SpendGuard {
  return {
    async before(stage) {
      for (const guard of guards) {
        const verdict = await guard.before(stage);
        if (!verdict.ok) return verdict;
      }
      return { ok: true };
    },
    async after(cost) {
      for (const guard of guards) await guard.after(cost);
    },
  };
}
