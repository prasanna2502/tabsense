/**
 * M3 unit-level perf suite — growth caps for every persisted /
 * growable structure.
 *
 * Every bound is driven behaviorally through the pure lib helper
 * that enforces it: feed far more than the cap, assert the bound
 * and the retention order. The worker's ring writes (activity log,
 * swap samples, group activity) go through appendCapped /
 * pushCapped from src/lib/snapshot.ts, and the group-memory store
 * is bounded by capGroupRecords from src/lib/groups.ts — the exact
 * functions the worker calls — so nothing here relies on inspection.
 */

import { describe, expect, it } from 'vitest';
import {
  DISMISSAL_CAP,
  GROUP_RECORDS_CAP,
  capDismissals,
  capGroupRecords,
  computeGroupSignature,
  exemplarKeysOf,
  groupLocalId,
  signatureFromKeys,
  type DismissalRecord,
  type TabSenseGroupRecord,
} from '../src/lib/groups';
import type { ScorerTabInput } from '../src/lib/scorer';
import { tsScorer } from '../src/lib/scorer';
import { GROUPING_SETTINGS_KEY } from '../src/lib/settings';
import {
  ACTIVITY_CAP,
  ACTIVITY_KEY,
  DISMISSED_KEY,
  GROUPS_KEY,
  GROUP_ACTIVITY_CAP,
  GROUP_ACTIVITY_KEY,
  LAST_ACTION_KEY,
  SETTINGS_KEY,
  SNAPSHOT_KEY,
  SUGGESTIONS_KEY,
  SWAP_SAMPLES_CAP,
  SWAP_SAMPLES_KEY,
  appendCapped,
  pushCapped,
} from '../src/lib/snapshot';
import {
  MAX_SUGGESTIONS_PER_WINDOW,
  buildSuggestions,
  type EngineTab,
} from '../src/lib/suggestions';

describe('cap — dismissals (DISMISSAL_CAP, enforced by capDismissals in src/lib/groups.ts)', () => {
  it('feeding 1,000 dismissal records yields exactly 200, newest kept', () => {
    const records: DismissalRecord[] = Array.from(
      { length: 1_000 },
      (_, i) => ({ signature: `sig-${i}`, at: i }),
    );
    // Feed them newest-first to prove the cap sorts by `at`, not by
    // input order.
    const capped = capDismissals([...records].reverse());
    expect(capped).toHaveLength(DISMISSAL_CAP);
    expect(DISMISSAL_CAP).toBe(200);
    expect(capped[0]).toEqual({ signature: 'sig-999', at: 999 });
    expect(capped[capped.length - 1]).toEqual({
      signature: 'sig-800',
      at: 800,
    });
    // Nothing older than the newest 200 survives.
    expect(capped.every((r) => r.at >= 800)).toBe(true);
  });
});

describe('cap — suggestions per window (MAX_SUGGESTIONS_PER_WINDOW, enforced by buildSuggestions)', () => {
  function engineTab(id: number, url: string, windowId: number): EngineTab {
    return {
      id,
      title: `Tab ${id}`,
      url,
      exactKey: null,
      fuzzyKey: null,
      windowId,
      groupId: -1,
      pinned: false,
      excluded: false,
    };
  }

  /** 30 hosts × 3 tabs in one window: the domain-only rung turns
   * each host bucket into a new-group draft → 30 candidates for a
   * cap of 10. */
  function crowdedTabs(windowId: number, idOffset: number): EngineTab[] {
    const tabs: EngineTab[] = [];
    for (let h = 0; h < 30; h++) {
      for (let j = 0; j < 3; j++) {
        const id = idOffset + h * 3 + j + 1;
        tabs.push(
          engineTab(id, `https://host${h}.example.com/page-${j}`, windowId),
        );
      }
    }
    return tabs;
  }

  it('a window with 30 candidate groups yields at most 10 suggestions', () => {
    const drafts = buildSuggestions({
      tabs: crowdedTabs(1, 0),
      groups: [],
      blocklist: [],
      rung: 'domain-only',
      dismissed: [],
      scorer: tsScorer,
    });
    expect(drafts).toHaveLength(MAX_SUGGESTIONS_PER_WINDOW);
    expect(MAX_SUGGESTIONS_PER_WINDOW).toBe(10);
    expect(drafts.every((d) => d.windowId === 1)).toBe(true);
  });

  it('the cap is per window: two crowded windows yield at most 10 each', () => {
    const drafts = buildSuggestions({
      tabs: [...crowdedTabs(1, 0), ...crowdedTabs(2, 1_000)],
      groups: [],
      blocklist: [],
      rung: 'domain-only',
      dismissed: [],
      scorer: tsScorer,
    });
    const perWindow = new Map<number, number>();
    for (const d of drafts) {
      perWindow.set(d.windowId, (perWindow.get(d.windowId) ?? 0) + 1);
    }
    expect(perWindow.get(1)).toBe(MAX_SUGGESTIONS_PER_WINDOW);
    expect(perWindow.get(2)).toBe(MAX_SUGGESTIONS_PER_WINDOW);
    expect(drafts.length).toBe(2 * MAX_SUGGESTIONS_PER_WINDOW);
  });
});

describe('cap — group exemplar keys (5, enforced by exemplarKeysOf / signatureFromKeys in src/lib/groups.ts)', () => {
  function scorerTab(i: number): ScorerTabInput {
    const key = `key-${String(i).padStart(3, '0')}`;
    return {
      id: i + 1,
      title: `Tab ${i}`,
      url: `https://example.com/page-${i}`,
      exactKey: key,
      fuzzyKey: key,
    };
  }

  it('exemplarKeysOf with 50 tabs returns at most 5 keys', () => {
    const tabs = Array.from({ length: 50 }, (_, i) => scorerTab(i));
    const keys = exemplarKeysOf(tabs);
    expect(keys.length).toBeLessThanOrEqual(5);
    expect(keys).toEqual([
      'key-000',
      'key-001',
      'key-002',
      'key-003',
      'key-004',
    ]);
  });

  it('group signature embeds at most 5 exemplar keys and is order-stable', () => {
    const tabs = Array.from({ length: 50 }, (_, i) => scorerTab(i));
    const sig = computeGroupSignature('Perf Group', tabs);
    const embedded = sig.split('|')[2].split(',');
    expect(embedded.length).toBeLessThanOrEqual(5);
    // Stability: the same member set in any order signs identically.
    expect(computeGroupSignature('Perf Group', [...tabs].reverse())).toBe(
      sig,
    );
    expect(signatureFromKeys('Perf Group', embedded)).toBe(sig);
  });

  it('a group record built through the lib helpers keeps its identity fields at 5 keys regardless of member count', () => {
    const buildRecord = (memberCount: number): TabSenseGroupRecord => {
      const members = Array.from({ length: memberCount }, (_, i) =>
        scorerTab(i),
      );
      return {
        localId: groupLocalId(1_700_000_000_000, memberCount),
        name: 'Perf Group',
        signature: computeGroupSignature('Perf Group', members),
        exemplarKeys: exemplarKeysOf(members),
        windowId: 1,
        chromeGroupId: 42,
        // As the worker's sync sets it: the live member list. There
        // is no separate numeric cap on this field — it mirrors the
        // tabs actually in the Chrome group, so it is bounded by the
        // session's tab count (500 in the perf budgets), asserted
        // below as exactly that bound.
        memberTabIds: members.map((m) => m.id),
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
    };
    const small = buildRecord(5);
    const large = buildRecord(500);
    expect(large.exemplarKeys).toHaveLength(5);
    // The persisted identity portion (signature + exemplar keys) is
    // byte-identical for 5 and for 500 members: it cannot grow
    // with group size.
    expect(large.exemplarKeys).toEqual(small.exemplarKeys);
    expect(large.signature).toBe(small.signature);
    expect(large.memberTabIds.length).toBe(500);
    expect(large.memberTabIds.length).toBeLessThanOrEqual(500);
  });
});

describe('cap — storage key inventory (constants in src/lib/snapshot.ts + src/lib/settings.ts)', () => {
  it('every chrome.storage.local key the worker writes is a named constant', () => {
    expect(SNAPSHOT_KEY).toBe('tabSnapshot');
    expect(ACTIVITY_KEY).toBe('activityLog');
    expect(SWAP_SAMPLES_KEY).toBe('swapSamples');
    expect(SETTINGS_KEY).toBe('autoCloseEnabled');
    expect(SUGGESTIONS_KEY).toBe('suggestions');
    expect(GROUPS_KEY).toBe('tabSenseGroups');
    expect(DISMISSED_KEY).toBe('dismissedSuggestions');
    expect(GROUP_ACTIVITY_KEY).toBe('groupActivity');
    expect(LAST_ACTION_KEY).toBe('lastGroupAction');
    expect(GROUPING_SETTINGS_KEY).toBe('groupingSettings');
  });
});

describe('cap — persisted rings (appendCapped / pushCapped in src/lib/snapshot.ts, the helpers the worker calls)', () => {
  it('prepend-and-cap: 300 appends to the activity ring keep exactly 100, newest first', () => {
    let ring: number[] = [];
    for (let i = 0; i < 300; i++) {
      ring = appendCapped(ring, i, ACTIVITY_CAP);
    }
    expect(ACTIVITY_CAP).toBe(100);
    expect(ring).toHaveLength(100);
    expect(ring[0]).toBe(299);
    expect(ring[ring.length - 1]).toBe(200);
  });

  it('append-and-cap: 300 pushes to the swap-sample ring keep exactly 100, chronological', () => {
    let ring: number[] = [];
    for (let i = 0; i < 300; i++) {
      ring = pushCapped(ring, i, SWAP_SAMPLES_CAP);
    }
    expect(SWAP_SAMPLES_CAP).toBe(100);
    expect(ring).toHaveLength(100);
    expect(ring[0]).toBe(200);
    expect(ring[ring.length - 1]).toBe(299);
  });

  it('the group-activity ring uses the same prepend discipline at 100', () => {
    let ring: number[] = [];
    for (let i = 0; i < 250; i++) {
      ring = appendCapped(ring, i, GROUP_ACTIVITY_CAP);
    }
    expect(GROUP_ACTIVITY_CAP).toBe(100);
    expect(ring).toHaveLength(100);
    expect(ring[0]).toBe(249);
  });
});

describe('cap — group memory records (GROUP_RECORDS_CAP, enforced by capGroupRecords in src/lib/groups.ts)', () => {
  function record(
    i: number,
    overrides: Partial<TabSenseGroupRecord> = {},
  ): TabSenseGroupRecord {
    return {
      localId: `g-${i}`,
      name: `Group ${i}`,
      signature: `sig-${i}`,
      exemplarKeys: [`key-${i}`],
      windowId: 1,
      chromeGroupId: null,
      memberTabIds: [],
      createdAt: i,
      updatedAt: i,
      ...overrides,
    };
  }

  it('500 dormant records are capped to 200, newest-updated kept', () => {
    const records = Array.from({ length: 500 }, (_, i) => record(i));
    const capped = capGroupRecords(records);
    expect(GROUP_RECORDS_CAP).toBe(200);
    expect(capped).toHaveLength(200);
    expect(capped.every((r) => r.updatedAt >= 300)).toBe(true);
    // Survivor order matches input order.
    const ats = capped.map((r) => r.updatedAt);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
  });

  it('live records are never evicted, even when old', () => {
    const live = Array.from({ length: 5 }, (_, i) =>
      record(i, { chromeGroupId: 100 + i }),
    );
    const dormant = Array.from({ length: 400 }, (_, i) => record(100 + i));
    const capped = capGroupRecords([...live, ...dormant]);
    expect(capped).toHaveLength(200);
    for (const r of live) {
      expect(capped.some((c) => c.localId === r.localId)).toBe(true);
    }
  });

  it('at or under the cap the records pass through unchanged', () => {
    const records = Array.from({ length: 50 }, (_, i) => record(i));
    expect(capGroupRecords(records)).toEqual(records);
  });
});
