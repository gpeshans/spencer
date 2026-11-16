import { describe, expect, it } from 'vitest';

import { allGuards, createRunBudget } from './budget';
import { costUsd, DEFAULT_PRICES, priceOf, UNKNOWN_MODEL_PRICE } from './prices';
import type { SpendGuard } from './types';

describe('prices', () => {
  it('prices every kind of token', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    // Opus 5.5: $4 + $20 + $0.20 + $5 + $8.
    expect(costUsd(usage, priceOf('claude-opus-5-5'))).toBeCloseTo(37.2, 10);
  });

  it('charges unknown models the highest price, prototype keys included', () => {
    expect(priceOf('claude-made-up')).toBe(UNKNOWN_MODEL_PRICE);
    expect(priceOf('constructor')).toBe(UNKNOWN_MODEL_PRICE);
    expect(priceOf('__proto__')).toBe(UNKNOWN_MODEL_PRICE);
    for (const price of Object.values(DEFAULT_PRICES)) {
      expect(price.input).toBeLessThanOrEqual(UNKNOWN_MODEL_PRICE.input);
      expect(price.output).toBeLessThanOrEqual(UNKNOWN_MODEL_PRICE.output);
    }
  });
});

describe('createRunBudget', () => {
  it('allows calls until the spend reaches the limit', async () => {
    const budget = createRunBudget(0.5);
    expect(await budget.before('plan')).toEqual({ ok: true });
    budget.after(0.3);
    expect(await budget.before('sql')).toEqual({ ok: true });
    budget.after(0.25);
    expect(await budget.before('narrative')).toEqual({ ok: false, message: 'This run reached its budget of $0.50.' });
    expect(budget.spentUsd()).toBeCloseTo(0.55, 10);
  });

  it('can start from what the run spent in earlier requests', async () => {
    const budget = createRunBudget(0.5, 0.45);
    expect(await budget.before('sql')).toEqual({ ok: true });
    budget.after(0.06);
    expect((await budget.before('narrative')).ok).toBe(false);
    expect(() => createRunBudget(0.5, -1)).toThrow('must not be negative');
  });

  it('ignores negative costs', () => {
    const budget = createRunBudget(1);
    budget.after(-5);
    expect(budget.spentUsd()).toBe(0);
  });

  it('needs a positive limit', () => {
    for (const limit of [0, -1, Number.NaN]) expect(() => createRunBudget(limit)).toThrow('must be positive');
  });
});

describe('allGuards', () => {
  it('returns the first refusal and reports costs to every guard', async () => {
    const seen: number[] = [];
    const open: SpendGuard = { before: async () => ({ ok: true }), after: (cost) => void seen.push(cost) };
    const closed: SpendGuard = { before: async () => ({ ok: false, message: 'daily' }), after: (cost) => void seen.push(cost * 10) };

    expect(await allGuards(open, open).before('intent')).toEqual({ ok: true });
    expect(await allGuards(open, closed, open).before('intent')).toEqual({ ok: false, message: 'daily' });
    await allGuards(open, closed).after(1);
    expect(seen).toEqual([1, 10]);
  });
});
