import { describe, expect, it } from 'vitest';

import { findSameName, levenshtein, normalizeName, similarity, suggest } from './similarity';

describe('similarity', () => {
  it('normalizes case, accents and spacing', () => {
    expect(normalizeName('  Café   Bar ')).toBe('cafe bar');
    expect(normalizeName('Lebensmittel')).toBe(normalizeName('LEBENSMITTEL'));
  });

  it('counts edits over code points', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('🍎a', '🍎b')).toBe(1);
  });

  it('scores equal names 1 and containment as close', () => {
    expect(similarity('Groceries', 'groceries')).toBe(1);
    expect(similarity('car', 'Car insurance')).toBe(0.8);
    expect(similarity('rent', 'Groceries')).toBeLessThan(0.6);
    expect(similarity('', 'x')).toBe(0);
  });

  it('finds the same name regardless of case and accents', () => {
    expect(findSameName('cafe', ['Café', 'Rent'])).toBe('Café');
    expect(findSameName('caf', ['Café'])).toBeUndefined();
  });

  it('suggests the closest names first', () => {
    const categories = ['Groceries', 'Rent', 'Restaurants', 'Car insurance', 'Gifts'];
    expect(suggest('grocries', categories)).toEqual(['Groceries']);
    expect(suggest('restaurant', categories)).toEqual(['Restaurants']);
    expect(suggest('car', categories)).toEqual(['Car insurance']);
    expect(suggest('xyz', categories)).toEqual([]);
    expect(suggest('re', categories, 1, 0)).toHaveLength(1);
  });
});
