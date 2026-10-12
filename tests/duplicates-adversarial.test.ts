/**
 * Dedupe data-structure adversarial tests (test-hardening
 * commission, methods 3 + 8): the pure planners and set builders
 * the worker and panel share. The worker-level races live in
 * worker-dedupe.test.ts; here the targets are boundary arithmetic
 * — the intentional-duplicate fingerprint's four conditions each
 * toggled at their exact edge, exemption lifecycle, set builders
 * at scale, tie-breaking, and stale-plan safety.
 */

import { describe, expect, it } from 'vitest';
import {
  DuplicateExemptions,
  countExtraCopies,
  findExactDuplicateSets,
  findFuzzySets,
  isIntentionalDuplicate,
  planBulkClose,
  planSimilarClose,
  shouldKeepIntentionalDuplicate,
  summarizeDuplicates,
  type IntentionalDuplicateEvidence,
  type KeyedTab,
} from '../src/lib/duplicates';

const tab = (
  id: number,
  exactKey: string | null,
  fuzzyKey: string | null = exactKey,
  firstSeenAt: number | null = id,
): KeyedTab => ({ id, exactKey, fuzzyKey, firstSeenAt });

describe('isIntentionalDuplicate — the four-condition fingerprint, toggled at its boundaries', () => {
  const base: IntentionalDuplicateEvidence = {
    newExactKey: 'https://example.com/doc',
    sourceExactKey: 'https://example.com/doc',
    openerTabId: 7,
    sourceTabId: 7,
    newIndex: 4,
    sourceIndex: 3,
    sameWindow: true,
    sourceWasActive: true,
  };

  it('accepts the perfect fingerprint', () => {
    expect(isIntentionalDuplicate(base)).toBe(true);
  });

  it.each([
    ['new key null', { newExactKey: null }],
    ['source key null', { sourceExactKey: null }],
    ['keys differ', { sourceExactKey: 'https://example.com/other' }],
    ['opener undefined (programmatic open)', { openerTabId: undefined }],
    ['opener null', { openerTabId: null }],
    ['opener is another tab', { openerTabId: 8 }],
    ['source unknown', { sourceTabId: null }],
    ['different window', { sameWindow: false }],
    ['source not active', { sourceWasActive: false }],
  ] as Array<[string, Partial<IntentionalDuplicateEvidence>]>)(
    'rejects when %s',
    (_name, patch) => {
      expect(isIntentionalDuplicate({ ...base, ...patch })).toBe(false);
    },
  );

  it('adjacency is exact: same slot, one short, and two past all fail', () => {
    expect(isIntentionalDuplicate({ ...base, newIndex: 3 })).toBe(false);
    expect(isIntentionalDuplicate({ ...base, newIndex: 5 })).toBe(false);
    expect(isIntentionalDuplicate({ ...base, newIndex: 2 })).toBe(false);
  });

  it('adjacency boundary at the strip start: source 0 → new 1 passes', () => {
    expect(
      isIntentionalDuplicate({ ...base, sourceIndex: 0, newIndex: 1 }),
    ).toBe(true);
  });

  it('characterization: a -1 (unindexed) source index satisfies adjacency with newIndex 0 — the worker only ever passes tracked sources (index ≥ 0), so the sentinel cannot occur in production', () => {
    expect(
      isIntentionalDuplicate({ ...base, sourceIndex: -1, newIndex: 0 }),
    ).toBe(true);
  });

  it('the setting gates the whole rule (shouldKeepIntentionalDuplicate)', () => {
    expect(shouldKeepIntentionalDuplicate(base, true)).toBe(true);
    expect(shouldKeepIntentionalDuplicate(base, false)).toBe(false);
  });
});

describe('DuplicateExemptions lifecycle', () => {
  it('mark → retain at the same key holds; a different key ends it and drops the mark', () => {
    const ex = new DuplicateExemptions();
    ex.mark(5, 'key-a');
    expect(ex.retain(5, 'key-a')).toBe(true);
    expect(ex.has(5)).toBe(true);
    expect(ex.retain(5, 'key-b')).toBe(false);
    expect(ex.has(5)).toBe(false);
    // Once dropped, the old key no longer exempts either.
    expect(ex.retain(5, 'key-a')).toBe(false);
  });

  it('retain at a null key ends the exemption (tab lost its key)', () => {
    const ex = new DuplicateExemptions();
    ex.mark(5, 'key-a');
    expect(ex.retain(5, null)).toBe(false);
    expect(ex.has(5)).toBe(false);
  });

  it('is per-tab, never per-URL: another tab at the same key is not exempt', () => {
    const ex = new DuplicateExemptions();
    ex.mark(5, 'key-a');
    expect(ex.retain(6, 'key-a')).toBe(false);
    expect(ex.has(6)).toBe(false);
  });

  it('re-marking overwrites the key; forget clears', () => {
    const ex = new DuplicateExemptions();
    ex.mark(5, 'key-a');
    ex.mark(5, 'key-b');
    expect(ex.retain(5, 'key-a')).toBe(false);
    ex.mark(5, 'key-a');
    ex.forget(5);
    expect(ex.retain(5, 'key-a')).toBe(false);
  });

  it('retain on a never-marked tab is false and creates nothing', () => {
    const ex = new DuplicateExemptions();
    expect(ex.retain(9, 'key-a')).toBe(false);
    expect(ex.has(9)).toBe(false);
  });
});

describe('findExactDuplicateSets at scale and on ties', () => {
  it('10,000 tabs on one key form a single set; newest is the max firstSeenAt', () => {
    const tabs: KeyedTab[] = [];
    for (let i = 0; i < 10_000; i++) tabs.push(tab(i, 'k', 'k', i));
    const sets = findExactDuplicateSets(tabs);
    expect(sets).toHaveLength(1);
    expect(sets[0].tabIds).toHaveLength(10_000);
    expect(sets[0].newestTabId).toBe(9999);
    expect(countExtraCopies(sets)).toBe(9999);
  });

  it('firstSeenAt ties break by id descending; null firstSeenAt sorts as oldest', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'k', 'k', 100),
      tab(2, 'k', 'k', 100),
      tab(3, 'k', 'k', null),
      tab(4, 'k', 'k', 50),
    ]);
    expect(sets[0].tabIds).toEqual([2, 1, 4, 3]);
    expect(sets[0].newestTabId).toBe(2);
  });

  it('null exactKey tabs never join; singletons never form sets', () => {
    const sets = findExactDuplicateSets([
      tab(1, null),
      tab(2, null),
      tab(3, 'solo'),
      tab(4, 'pair'),
      tab(5, 'pair'),
    ]);
    expect(sets.map((s) => s.exactKey)).toEqual(['pair']);
  });

  it('sets are ordered by size descending, then key ascending', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'zz'),
      tab(2, 'zz'),
      tab(3, 'aa'),
      tab(4, 'aa'),
      tab(5, 'mm'),
      tab(6, 'mm'),
      tab(7, 'mm'),
    ]);
    expect(sets.map((s) => s.exactKey)).toEqual(['mm', 'aa', 'zz']);
  });
});

describe('findFuzzySets — the two-distinct-views requirement', () => {
  it('two tabs with the SAME exact key do not form a fuzzy set', () => {
    const sets = findFuzzySets([tab(1, 'doc/edit', 'doc'), tab(2, 'doc/edit', 'doc')]);
    expect(sets).toEqual([]);
  });

  it('two views form a set; a third tab reusing one view joins it', () => {
    const sets = findFuzzySets([
      tab(1, 'doc/edit', 'doc'),
      tab(2, 'doc/view', 'doc'),
      tab(3, 'doc/edit', 'doc'),
    ]);
    expect(sets).toHaveLength(1);
    expect(sets[0].tabIds.sort()).toEqual([1, 2, 3]);
    expect(sets[0].exactKeys.sort()).toEqual(['doc/edit', 'doc/view']);
  });

  it('tabs missing either key are skipped', () => {
    const sets = findFuzzySets([
      tab(1, 'doc/edit', 'doc'),
      tab(2, 'doc/view', null),
      tab(3, null, 'doc'),
    ]);
    expect(sets).toEqual([]);
  });
});

describe('close planners — stale-plan safety at the function boundary', () => {
  it('planBulkClose keeps each set’s newest and closes the rest in set order', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'a', 'a', 10),
      tab(2, 'a', 'a', 30),
      tab(3, 'a', 'a', 20),
    ]);
    expect(planBulkClose(sets)).toEqual([
      { exactKey: 'a', keepTabId: 2, closeTabIds: [3, 1] },
    ]);
    expect(planBulkClose([])).toEqual([]);
  });

  it('planSimilarClose: unknown set or a keep tab outside the set → null (never guess)', () => {
    const sets = findFuzzySets([tab(1, 'd/e', 'd'), tab(2, 'd/v', 'd')]);
    expect(planSimilarClose(sets, 'nope', 1)).toBeNull();
    expect(planSimilarClose(sets, 'd', 99)).toBeNull();
    expect(planSimilarClose(sets, 'd', 1)).toEqual({
      fuzzyKey: 'd',
      keepTabId: 1,
      closeTabIds: [2],
    });
  });

  it('countExtraCopies floors degenerate hand-built sets at zero', () => {
    expect(countExtraCopies([])).toBe(0);
    expect(
      countExtraCopies([
        { exactKey: 'x', tabIds: [1], newestTabId: 1 },
        { exactKey: 'y', tabIds: [], newestTabId: 0 },
      ]),
    ).toBe(0);
  });
});

describe('summarizeDuplicates edges', () => {
  it('empty and blank-only inputs produce zeros', () => {
    expect(summarizeDuplicates([])).toEqual({
      totalTabs: 0,
      uniqueUrls: 0,
      duplicateTabs: 0,
      groups: [],
    });
    expect(summarizeDuplicates(['', ''])).toEqual({
      totalTabs: 0,
      uniqueUrls: 0,
      duplicateTabs: 0,
      groups: [],
    });
  });

  it('groups sort by count descending, then URL ascending', () => {
    const s = summarizeDuplicates([
      'https://b.example/',
      'https://b.example/',
      'https://a.example/',
      'https://a.example/',
      'https://a.example/',
      'https://c.example/',
      'https://c.example/',
    ]);
    expect(s.groups).toEqual([
      { url: 'https://a.example/', count: 3 },
      { url: 'https://b.example/', count: 2 },
      { url: 'https://c.example/', count: 2 },
    ]);
    expect(s.duplicateTabs).toBe(4);
    expect(s.uniqueUrls).toBe(3);
    expect(s.totalTabs).toBe(7);
  });
});
