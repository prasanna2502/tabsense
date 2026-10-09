import { describe, expect, it } from 'vitest';
import {
  countExtraCopies,
  findExactDuplicateSets,
  planBulkClose,
  type KeyedTab,
} from '../src/lib/duplicates';

function tab(
  id: number,
  exactKey: string | null,
  firstSeenAt: number | null = id * 100,
): KeyedTab {
  return { id, exactKey, fuzzyKey: exactKey, firstSeenAt };
}

describe('countExtraCopies', () => {
  it('is 0 when there are no duplicate sets', () => {
    expect(countExtraCopies([])).toBe(0);
    expect(countExtraCopies(findExactDuplicateSets([tab(1, 'a')]))).toBe(0);
  });

  it('sums (size - 1) across sets — the badge/panel agreement number', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'a'),
      tab(2, 'a'),
      tab(3, 'a'),
      tab(4, 'b'),
      tab(5, 'b'),
      tab(6, 'c'),
    ]);
    expect(countExtraCopies(sets)).toBe(3);
  });
});

describe('planBulkClose', () => {
  it('keeps each set’s newest tab and closes the rest, newest-first', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'a', 100),
      tab(2, 'a', 300),
      tab(3, 'a', 200),
    ]);
    const plan = planBulkClose(sets);
    expect(plan).toHaveLength(1);
    expect(plan[0].exactKey).toBe('a');
    // The plan's survivor is exactly the set builder's newest pick.
    expect(plan[0].keepTabId).toBe(sets[0].newestTabId);
    expect(plan[0].keepTabId).toBe(2);
    expect(plan[0].closeTabIds).toEqual([3, 1]);
  });

  it('plans every set independently', () => {
    const sets = findExactDuplicateSets([
      tab(1, 'a'),
      tab(2, 'a'),
      tab(3, 'b'),
      tab(4, 'b'),
    ]);
    const plan = planBulkClose(sets);
    expect(plan.map((p) => p.exactKey).sort()).toEqual(['a', 'b']);
    for (const entry of plan) {
      expect(entry.closeTabIds).toHaveLength(1);
      expect(entry.closeTabIds).not.toContain(entry.keepTabId);
    }
  });

  it('an empty set list plans nothing', () => {
    expect(planBulkClose([])).toEqual([]);
  });
});
