import type { LlmUsage } from './types';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

/**
 * List prices as of 2026-11-16. Cache writes are 1.25x the input price for the
 * 5-minute TTL and 2x for the 1-hour TTL.
 * - claude-opus-5-5 runs every stage; claude-sonnet-5-5 is the fallback model.
 * - claude-opus-5 and claude-opus-4-8 can answer Opus 5.5's refusal fallback,
 *   and claude-sonnet-5 can answer Sonnet 5.5's.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
};

/**
 * Charged for models missing from the table. It is high on purpose (the
 * priciest Claude tier), so spend is never under-counted.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  input: 10,
  output: 50,
  cacheWrite5m: 12.5,
  cacheWrite1h: 20,
  cacheRead: 1,
};

export function priceOf(model: string, prices: PriceTable = DEFAULT_PRICES): ModelPrice {
  return Object.hasOwn(prices, model) ? prices[model]! : UNKNOWN_MODEL_PRICE;
}

export function costUsd(usage: LlmUsage, price: ModelPrice): number {
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWrite5mTokens * price.cacheWrite5m +
      usage.cacheWrite1hTokens * price.cacheWrite1h) /
    1_000_000
  );
}

export const ZERO_USAGE: LlmUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
});

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
  };
}
