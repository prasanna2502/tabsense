import { describe, expect, it } from 'vitest';
import {
  findFuzzySets,
  planSimilarClose,
  type KeyedTab,
} from '../src/lib/duplicates';

/** Tabs of one document open in three views (distinct exactKeys,
 * one shared fuzzyKey), newest-first by firstSeenAt. */
function docViews(): KeyedTab[] {
  return [
    { id: 10, exactKey: 'doc:edit', fuzzyKey: 'doc', firstSeenAt: 300 },
    { id: 11, exactKey: 'doc:view', fuzzyKey: 'doc', firstSeenAt: 200 },
    { id: 12, exactKey: 'doc:preview', fuzzyKey: 'doc', firstSeenAt: 100 },
    { id: 20, exactKey: 'other', fuzzyKey: null, firstSeenAt: 50 },
  ];
}

describe('planSimilarClose', () => {
  it('keeps the chosen member and closes every other current member', () => {
    const sets = findFuzzySets(docViews());
    expect(sets).toHaveLength(1);
    const plan = planSimilarClose(sets, 'doc', 11);
    expect(plan).not.toBe(null);
    expect(plan?.keepTabId).toBe(11);
    expect(plan?.closeTabIds).toEqual([10, 12]);
  });

  it('returns null when the keep tab is not a member of the set', () => {
    const sets = findFuzzySets(docViews());
    expect(planSimilarClose(sets, 'doc', 20)).toBe(null);
    expect(planSimilarClose(sets, 'doc', 999)).toBe(null);
  });

  it('returns null for an unknown or vanished fuzzy set', () => {
    const sets = findFuzzySets(docViews());
    expect(planSimilarClose(sets, 'nope', 10)).toBe(null);
    expect(planSimilarClose([], 'doc', 10)).toBe(null);
  });

  it('never plans to close the survivor itself', () => {
    const sets = findFuzzySets(docViews());
    for (const keep of [10, 11, 12]) {
      const plan = planSimilarClose(sets, 'doc', keep);
      expect(plan?.closeTabIds).not.toContain(keep);
      expect(plan?.closeTabIds).toHaveLength(2);
    }
  });
});
