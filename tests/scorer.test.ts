import { describe, expect, it } from 'vitest';
import {
  ADD_THRESHOLD,
  TOP_K,
  clusterTabs,
  pairScore,
  scoreCandidates,
  tokenize,
  type ScorerGroupInput,
  type ScorerTabInput,
} from '../src/lib/scorer';

// These fixtures mirror core/src/scorer.rs tests — the TS mirror and
// the Rust core must agree on all of them.

function tab(
  id: number,
  title: string,
  url: string,
  fuzzyKey: string | null = null,
): ScorerTabInput {
  return { id, title, url, exactKey: null, fuzzyKey };
}

const recipeTabs: ScorerTabInput[] = [
  tab(1, 'Best Chicken Tikka Masala Recipe', 'https://www.allrecipes.com/recipe/228293/chicken-tikka-masala'),
  tab(2, 'Chicken Parmesan Recipe', 'https://www.seriouseats.com/chicken-parmesan-recipe'),
  tab(3, 'Easy Chicken Soup Recipe', 'https://www.bbcgoodfood.com/recipes/chicken-soup'),
  tab(4, 'Seattle Weather Forecast', 'https://weather.com/weather/today/seattle'),
];

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics, drops stopwords and 1-char tokens', () => {
    expect([...tokenize('The Best Chicken-Parmigiana Recipe!')].sort()).toEqual([
      'best',
      'chicken',
      'parmigiana',
      'recipe',
    ]);
  });
});

describe('clusterTabs', () => {
  it('clusters the recipes together, not the weather tab', () => {
    const clusters = clusterTabs(recipeTabs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].tabIds).toEqual([1, 2, 3]);
    expect(clusters[0].nameSeed).toBe('chicken');
    expect(clusters[0].cohesion).toBeGreaterThan(0.3);
  });

  it('does not cluster same-host tabs with unrelated titles', () => {
    const tabs = [
      tab(1, 'Quarterly earnings call notes', 'https://example.com/a'),
      tab(2, 'Totally unrelated opinion piece', 'https://example.com/b'),
    ];
    expect(clusterTabs(tabs)).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const shuffled = [recipeTabs[2], recipeTabs[0], recipeTabs[3], recipeTabs[1]];
    expect(clusterTabs(shuffled)).toEqual(clusterTabs(recipeTabs));
  });
});

describe('scoreCandidates', () => {
  it('caps at TOP_K and sorts best-first', () => {
    const groups: ScorerGroupInput[] = Array.from({ length: 7 }, (_, i) => ({
      groupKey: `g${i}`,
      name: `Group ${i}`,
      exemplars: [tab(100 + i, 'Chicken soup recipe', 'https://recipes.example.com/soup')],
    }));
    const cands = scoreCandidates(
      tab(1, 'Chicken soup recipe easy', 'https://recipes.example.com/soup2'),
      groups,
    );
    expect(cands).toHaveLength(TOP_K);
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i - 1].score).toBeGreaterThanOrEqual(cands[i].score);
    }
    expect(cands[0].score).toBeGreaterThanOrEqual(ADD_THRESHOLD);
  });

  it('returns nothing for an unrelated tab', () => {
    const groups: ScorerGroupInput[] = [
      {
        groupKey: 'g0',
        name: 'Recipes',
        exemplars: [tab(9, 'Chicken soup recipe', 'https://recipes.example.com/soup')],
      },
    ];
    expect(
      scoreCandidates(
        tab(1, 'Rust async runtime internals', 'https://rust-lang.org/blog/async'),
        groups,
      ),
    ).toEqual([]);
  });
});

describe('pairScore', () => {
  it('rewards a shared fuzzy key (same document, different view)', () => {
    const a = tab(1, 'Document', 'https://docs.google.com/document/d/abc/edit', 'doc:abc');
    const b = tab(2, 'Document', 'https://docs.google.com/document/d/abc/view', 'doc:abc');
    expect(pairScore(a, b)).toBeGreaterThan(0.8);
  });

  it('never exceeds 1', () => {
    const a = tab(1, 'Same title here', 'https://example.com/x', 'k');
    const b = tab(2, 'Same title here', 'https://example.com/x', 'k');
    expect(pairScore(a, b)).toBeLessThanOrEqual(1);
  });
});
