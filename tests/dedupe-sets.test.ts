import { describe, expect, it } from 'vitest';
import {
  findExactDuplicateSets,
  findFuzzySets,
  type KeyedTab,
} from '../src/lib/duplicates';
import {
  isExcludedTab,
  summarizeSwaps,
  type SwapSample,
} from '../src/lib/snapshot';

function tab(
  id: number,
  exactKey: string | null,
  fuzzyKey: string | null,
  firstSeenAt: number | null = id * 100,
): KeyedTab {
  return { id, exactKey, fuzzyKey, firstSeenAt };
}

describe('findExactDuplicateSets', () => {
  it('groups tabs sharing an exactKey and picks the newest survivor', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'k1', 'f1', 100),
      tab(2, 'k1', 'f1', 300),
      tab(3, 'k1', 'f1', 200),
      tab(4, 'k2', 'f2', 400),
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0].exactKey).toBe('k1');
    expect(sets[0].tabIds).toEqual([2, 3, 1]);
    expect(sets[0].newestTabId).toBe(2);
  });

  it('ignores tabs with null keys (engine exclusions)', () => {
    const sets = findExactDuplicateSets([
      tab(1, null, null),
      tab(2, null, null),
      tab(3, 'k', 'k'),
    ]);
    expect(sets).toEqual([]);
  });
});

describe('findFuzzySets', () => {
  it('requires two distinct exactKeys under one fuzzyKey', () => {
    const sets = findFuzzySets([
      tab(1, 'doc#gid=0', 'doc'),
      tab(2, 'doc#gid=7', 'doc'),
      tab(3, 'doc#gid=7', 'doc'),
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0].fuzzyKey).toBe('doc');
    expect(sets[0].exactKeys.sort()).toEqual(['doc#gid=0', 'doc#gid=7']);
    expect(sets[0].tabIds).toEqual([3, 2, 1]);
  });

  it('a pure exact pair is not a fuzzy set', () => {
    const sets = findFuzzySets([tab(1, 'doc', 'doc'), tab(2, 'doc', 'doc')]);
    expect(sets).toEqual([]);
  });
});

describe('summarizeSwaps', () => {
  const sample = (ms: number, cold = false): SwapSample => ({
    ms,
    cold,
    at: 0,
  });

  it('computes count, cold/warm split, median and p95', () => {
    const stats = summarizeSwaps([
      sample(10),
      sample(20, true),
      sample(30),
      sample(40),
      sample(100),
    ]);
    expect(stats.count).toBe(5);
    expect(stats.coldCount).toBe(1);
    expect(stats.warmCount).toBe(4);
    expect(stats.medianMs).toBe(30);
    expect(stats.p95Ms).toBe(100);
  });

  it('handles no samples', () => {
    expect(summarizeSwaps([])).toEqual({
      count: 0,
      coldCount: 0,
      warmCount: 0,
      medianMs: null,
      p95Ms: null,
    });
  });
});

describe('isExcludedTab', () => {
  it('excludes pinned tabs entirely (plan default A3)', () => {
    expect(isExcludedTab({ pinned: true, url: 'https://example.com/' })).toBe(
      true,
    );
  });

  it('excludes browser pages and the new-tab page', () => {
    expect(isExcludedTab({ url: 'chrome://extensions/' })).toBe(true);
    expect(isExcludedTab({ url: 'chrome://newtab/' })).toBe(true);
    expect(isExcludedTab({ url: 'about:blank' })).toBe(true);
  });

  it('excludes tabs without a committed URL', () => {
    expect(isExcludedTab({ url: '' })).toBe(true);
    expect(isExcludedTab({})).toBe(true);
  });

  it('includes ordinary http(s) tabs', () => {
    expect(isExcludedTab({ url: 'https://example.com/page' })).toBe(false);
    expect(isExcludedTab({ url: 'http://example.com/page' })).toBe(false);
  });
});
