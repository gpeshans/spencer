/**
 * Nearest-match suggestions for names a person typed ("grocries" → "Groceries").
 * Used when a value doesn't match exactly, to offer choices in a clarifying
 * question rather than guess.
 */

/** Lowercase, without accents, with whitespace collapsed. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Edit distance (insertions, deletions, substitutions), over code points. */
export function levenshtein(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** 1 for equal names, towards 0 for unrelated ones. Containment counts as close. */
export function similarity(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const byEdits = 1 - levenshtein(left, right) / Math.max([...left].length, [...right].length);
  const contained = left.length >= 3 && right.length >= 3 && (left.includes(right) || right.includes(left));
  return Math.max(byEdits, contained ? 0.8 : 0);
}

/** The candidate that is the same name as `value`, ignoring case, accents and spacing. */
export function findSameName(value: string, candidates: readonly string[]): string | undefined {
  const wanted = normalizeName(value);
  return candidates.find((candidate) => normalizeName(candidate) === wanted);
}

/** Up to `limit` candidates at least `threshold` similar to `value`, closest first. */
export function suggest(value: string, candidates: readonly string[], limit = 3, threshold = 0.6): string[] {
  return candidates
    .map((candidate) => ({ candidate, score: similarity(value, candidate) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
