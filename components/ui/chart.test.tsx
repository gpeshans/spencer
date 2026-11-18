import { describe, expect, it } from 'vitest';

import { chartColorCss, type ChartConfig } from './chart';

/**
 * chartColorCss feeds a <style dangerouslySetInnerHTML>, so its output must
 * never let an untrusted config key or colour close the <style> element or the
 * CSS rule. Config keys carry user-writable data (e.g. a spending category or a
 * category colour written straight to PostgREST, bypassing the app's checks).
 */
describe('chartColorCss', () => {
  it('emits --color custom properties for safe keys and colours', () => {
    const css = chartColorCss('chart-r1', { c0: { label: 'Groceries', color: '#2f9e44' } });
    expect(css).toContain('--color-c0: #2f9e44;');
    expect(css).toContain('[data-chart=chart-r1]');
    // Light and dark blocks.
    expect(css).toContain('.dark [data-chart=chart-r1]');
  });

  it('allows rgb()/hsl() colours (parentheses are not a breakout)', () => {
    const css = chartColorCss('chart-r1', { c0: { color: 'rgb(47, 158, 68)' } });
    expect(css).toContain('--color-c0: rgb(47, 158, 68);');
  });

  const breakout = '}</style><script>alert(document.cookie)</script>';
  const noBreakout = (css: string) => {
    expect(css).not.toContain('</style>');
    expect(css).not.toContain('<script>');
    expect(css).not.toContain(breakout);
  };

  it('drops a key that carries CSS/HTML metacharacters', () => {
    // The exact stored-category payload from the security review.
    const config: ChartConfig = { [`x:1${breakout}`]: { label: 'x', color: '#2f9e44' } };
    const css = chartColorCss('chart-r1', config);
    noBreakout(css);
    // The whole entry is dropped, so no custom property is emitted for it.
    expect(css).not.toContain('--color-x');
  });

  it('drops a colour that carries CSS/HTML metacharacters', () => {
    const css = chartColorCss('chart-r1', { c0: { color: `red${breakout}` } });
    noBreakout(css);
    expect(css).not.toContain('--color-c0');
  });

  it('refuses an unsafe data-chart id outright', () => {
    expect(chartColorCss(`chart-r1]{}${breakout}`, { c0: { color: '#000000' } })).toBe('');
  });

  it('keeps safe entries while dropping unsafe ones in the same config', () => {
    const css = chartColorCss('chart-r1', {
      c0: { color: '#2f9e44' },
      [`bad${breakout}`]: { color: '#ffffff' },
      c1: { color: `#000${breakout}` },
    });
    expect(css).toContain('--color-c0: #2f9e44;');
    expect(css).not.toContain('--color-c1');
    noBreakout(css);
  });
});
