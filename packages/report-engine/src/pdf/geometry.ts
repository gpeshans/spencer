import type { ChartSpec } from '../report/document';

/** The arithmetic behind the PDF's charts, kept apart from the drawing so it can be tested. */

const round = (value: number) => Number(value.toPrecision(12));

/** The lowest and highest value the chart must show, zero always included: bars stand on it. */
export function extent(chart: Pick<ChartSpec, 'points' | 'stacked'>): [number, number] {
  let low = 0;
  let high = 0;
  for (const point of chart.points) {
    const values = Object.values(point.values).filter((value): value is number => value !== null);
    if (chart.stacked) {
      low = Math.min(low, values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0));
      high = Math.max(high, values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0));
    } else {
      for (const value of values) {
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  }
  return [low, high];
}

/** Round axis values covering [low, high], `count` steps or so apart: 1, 2, 2.5 or 5 times a power of ten. */
export function niceTicks(low: number, high: number, count = 4): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high)) return [0, 1];
  if (low > high) [low, high] = [high, low];
  if (low === high) {
    if (low === 0) return [0, 1];
    [low, high] = [Math.min(0, low), Math.max(0, high)];
  }
  const raw = (high - low) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw * (1 - 1e-9))!;
  const first = Math.floor(round(low / step)) * step;
  const last = Math.ceil(round(high / step)) * step;
  const ticks: number[] = [];
  for (let value = first; value <= last + step / 2; value += step) ticks.push(round(value));
  return ticks;
}

/** Every how many x labels to print, so at most `room` of them show. */
export function labelEvery(count: number, room: number): number {
  return Math.max(1, Math.ceil(count / Math.max(1, room)));
}

const at = (cx: number, cy: number, radius: number, angle: number) =>
  `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;

/** One ring segment from angle `from` to `to` (radians, clockwise from three o'clock). */
function segment(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  const rim = `M ${at(cx, cy, outer, from)} A ${outer} ${outer} 0 ${large} 1 ${at(cx, cy, outer, to)}`;
  if (inner <= 0) return `${rim} L ${cx.toFixed(2)} ${cy.toFixed(2)} Z`;
  return `${rim} L ${at(cx, cy, inner, to)} A ${inner} ${inner} 0 ${large} 0 ${at(cx, cy, inner, from)} Z`;
}

/**
 * SVG paths for a pie (or a ring, with `inner` > 0), one per value, clockwise
 * from twelve o'clock. Zero and negative values get no slice (null). A slice of
 * the whole circle is drawn as two halves, since one arc can't close on itself.
 */
export function pieSlices(values: readonly number[], cx: number, cy: number, outer: number, inner = 0): Array<string | null> {
  const total = values.reduce((sum, value) => (value > 0 ? sum + value : sum), 0);
  let angle = -Math.PI / 2;
  return values.map((value) => {
    if (!(value > 0) || total === 0) return null;
    const sweep = (value / total) * 2 * Math.PI;
    const from = angle;
    angle += sweep;
    if (sweep >= 2 * Math.PI - 1e-9) {
      return `${segment(cx, cy, outer, inner, from, from + Math.PI)} ${segment(cx, cy, outer, inner, from + Math.PI, from + 2 * Math.PI)}`;
    }
    return segment(cx, cy, outer, inner, from, angle);
  });
}
