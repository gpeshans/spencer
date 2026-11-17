import type { RunState, SectionResult } from 'report-engine';
import { toNumber } from 'report-engine/report';

import type { EvalCase, Fact, MapFact, Outcome, RowsFact, SeriesFact } from './cases';
import { MARKERS } from './fixture';

/**
 * Grades a finished run against its case, by code: how it ended, whether its
 * results hold every expected fact, and whether anything from the other
 * household leaked in. It reads the raw results (each section's rows), not the
 * formatted report, and any section may carry a fact: the plan picks them.
 */

export type Actual = Outcome | 'error' | 'unfinished';

export interface FactCheck {
  label: string;
  met: boolean;
  detail: string;
}

export interface Graded {
  grade: { correct: 0 | 1; outcome: 0 | 1; isolated: 0 | 1 };
  actual: Actual;
  /** A failed run's code, e.g. sections_failed. */
  code: string | null;
  facts: FactCheck[];
}

/** Money is exact to the cent; averages may carry more digits. */
const TOLERANCE = 0.01 + 1e-9;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;

export function outcomeOf(state: RunState): { actual: Actual; code: string | null } {
  switch (state.status) {
    case 'succeeded':
    case 'partial':
      return { actual: 'answer', code: null };
    case 'needs_clarification':
      return { actual: 'clarify', code: null };
    case 'failed': {
      const code = state.error?.code ?? null;
      if (code === 'write_request' || code === 'out_of_scope') return { actual: 'refuse', code };
      if (code === 'infeasible') return { actual: 'infeasible', code };
      return { actual: 'error', code };
    }
    default:
      return { actual: 'unfinished', code: null };
  }
}

interface Cells {
  /** Text cells, trimmed and lowercased. */
  texts: string[];
  numbers: number[];
}

function cellsOf(row: Record<string, unknown>): Cells {
  const texts: string[] = [];
  const numbers: number[] = [];
  for (const value of Object.values(row)) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) numbers.push(value);
    } else if (typeof value === 'string') {
      texts.push(value.trim().toLowerCase());
      // Exact numerics may come back as text.
      if (/^-?\d+(\.\d+)?$/.test(value.trim())) numbers.push(toNumber(value)!);
    }
  }
  return { texts, numbers };
}

const sectionsOf = (state: RunState): SectionResult[] => (state.results ?? []).filter((result) => result.status === 'ok');
const rowsOf = (section: SectionResult) => section.rows.map(cellsOf);
const hasNumber = (cells: Cells, value: number) => cells.numbers.some((number) => near(number, value));
const nonZero = (cells: Cells) => cells.numbers.some((number) => Math.abs(number) > TOLERANCE);
const money = (value: number) => value.toFixed(2);

function checkScalar(sections: SectionResult[], value: number): string | null {
  for (const section of sections) if (rowsOf(section).some((cells) => hasNumber(cells, value))) return `in ${section.section}`;
  return null;
}

/**
 * Map or series, in one section: every key on a row with its number, no row
 * for a key without that number (a duplicate, say), and other rows only zeros.
 */
function checkKeyed(sections: SectionResult[], expected: Record<string, number>, matches: (cells: Cells, key: string) => boolean): { met: boolean; detail: string } {
  const entries = Object.entries(expected);
  let closest = { missing: entries.length + 1, detail: 'no section has these rows' };
  for (const section of sections) {
    const rows = rowsOf(section);
    const missing = entries.filter(([key, value]) => !rows.some((cells) => matches(cells, key) && hasNumber(cells, value)));
    const wrong = rows.filter((cells) => entries.some(([key, value]) => matches(cells, key) && !hasNumber(cells, value)));
    const extra = rows.filter((cells) => !entries.some(([key]) => matches(cells, key)) && nonZero(cells));
    if (missing.length === 0 && wrong.length === 0 && extra.length === 0) return { met: true, detail: `in ${section.section}` };
    if (missing.length < closest.missing) {
      const parts = [
        ...missing.slice(0, 3).map(([key, value]) => `missing ${key} = ${money(value)}`),
        ...(wrong.length > 0 ? [`${wrong.length} row(s) with a wrong value`] : []),
        ...(extra.length > 0 ? [`${extra.length} unexpected non-zero row(s)`] : []),
      ];
      closest = { missing: missing.length, detail: `closest is ${section.section}: ${parts.join('; ')}` };
    }
  }
  return { met: false, detail: closest.detail };
}

function checkMap(sections: SectionResult[], fact: MapFact) {
  return checkKeyed(sections, fact.entries, (cells, key) => key.toLowerCase().split('|').every((part) => cells.texts.includes(part)));
}

function checkSeries(sections: SectionResult[], fact: SeriesFact) {
  return checkKeyed(sections, fact.points, (cells, key) => cells.texts.some((text) => text.slice(0, 7) === key));
}

function checkRows(sections: SectionResult[], fact: RowsFact): { met: boolean; detail: string } {
  const fits = (cells: Cells, row: RowsFact['rows'][number]) =>
    hasNumber(cells, row.amount) &&
    (!row.text || cells.texts.some((text) => text.includes(row.text!.toLowerCase()))) &&
    (!row.date || cells.texts.some((text) => text.startsWith(row.date!)));
  for (const section of sections) {
    const rows = rowsOf(section);
    if (fact.ordered) {
      if (rows.length >= fact.rows.length && fact.rows.every((row, index) => fits(rows[index]!, row))) return { met: true, detail: `in ${section.section}` };
    } else {
      // The same rows in any order: each expected row on its own result row, and no others.
      const free = [...rows];
      const all = fact.rows.every((row) => {
        const at = free.findIndex((cells) => fits(cells, row));
        if (at < 0) return false;
        free.splice(at, 1);
        return true;
      });
      if (all && free.length === 0) return { met: true, detail: `in ${section.section}` };
    }
  }
  const count = `${fact.rows.length} row${fact.rows.length === 1 ? '' : 's'}`;
  return { met: false, detail: fact.ordered ? `no section lists these ${count} first, in this order` : `no section has exactly these ${count}` };
}

function checkFact(sections: SectionResult[], fact: Fact): FactCheck {
  switch (fact.kind) {
    case 'scalar': {
      const where = checkScalar(sections, fact.value);
      return { label: fact.label, met: where !== null, detail: where ?? `no cell holds ${money(fact.value)}` };
    }
    case 'map':
      return { label: fact.label, ...checkMap(sections, fact) };
    case 'series':
      return { label: fact.label, ...checkSeries(sections, fact) };
    case 'rows':
      return { label: fact.label, ...checkRows(sections, fact) };
  }
}

/** Whether no result holds the other household's figures or text. */
export function isolated(state: RunState): boolean {
  for (const section of state.results ?? []) {
    for (const cells of rowsOf(section)) {
      if (hasNumber(cells, MARKERS.amount) || hasNumber(cells, MARKERS.income)) return false;
      if (cells.texts.some((text) => text.includes(MARKERS.description.toLowerCase()))) return false;
    }
  }
  return true;
}

export function gradeRun(evalCase: EvalCase, state: RunState): Graded {
  const { actual, code } = outcomeOf(state);
  const sections = sectionsOf(state);
  const facts = actual === 'answer' ? evalCase.facts.map((fact) => checkFact(sections, fact)) : evalCase.facts.map((fact) => ({ label: fact.label, met: false, detail: `the run ended as ${actual}` }));
  const outcome = actual === evalCase.expect;
  const clean = isolated(state);
  // Right ending, every fact, and nothing from another household.
  const correct = outcome && clean && facts.every((fact) => fact.met);
  return { grade: { correct: correct ? 1 : 0, outcome: outcome ? 1 : 0, isolated: clean ? 1 : 0 }, actual, code, facts };
}
