/**
 * M3 unit-level perf suite — storage footprint after a simulated
 * 30 days (budget: storage-footprint-30-days < 5 MB).
 *
 * One heavy day of persisted-state churn, replayed 30 times against
 * accumulated state:
 *   400 tab events → 400 activity-log entries (ring-capped),
 *   100 focus-swap samples (ring-capped),
 *   60 group actions → group-activity entries (ring-capped) and
 *     2 newly created TabSense groups per day,
 *   40 suggestion dismissals (capped with the REAL capDismissals),
 *   the suggestion inbox rebuilt (REAL buildSuggestions, so the
 *     per-window cap is the one doing the bounding),
 *   the tab snapshot rebuilt for a 500-tab session (real TabInfo
 *     entries with corpus URLs/titles/keys, real summarizeDuplicates
 *     and summarizeSwaps).
 *
 * The ring disciplines for activity / swap samples / group activity
 * are one-line slices in entrypoints/background.ts (not exported),
 * applied here with the REAL constants from src/lib/snapshot.ts —
 * the same "enforced in worker, verified by inspection" caveat as
 * in perf-caps.test.ts. Dismissals and suggestions go through the
 * real lib functions.
 *
 * The serialized object uses the worker's exact storage keys (the
 * constants, so this file fails if a key is renamed) and the
 * worker's value shapes for all ten keys.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKLIST } from '../src/lib/blocklist';
import { canonicalKeysFallback } from '../src/lib/canonicalize';
import { summarizeDuplicates } from '../src/lib/duplicates';
import {
  capDismissals,
  computeGroupSignature,
  dismissalSignature,
  exemplarKeysOf,
  groupKeyOf,
  groupLocalId,
  DISMISSAL_CAP,
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
  summarizeSwaps,
  type ActivityEntry,
  type GroupActivityEntry,
  type Suggestion,
  type SwapSample,
  type TabInfo,
  type TabSnapshot,
} from '../src/lib/snapshot';
import {
  MAX_SUGGESTIONS_PER_WINDOW,
  buildSuggestions,
  type EngineTab,
} from '../src/lib/suggestions';
import { generateCorpus } from './corpus-urls';

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 8, 10); // 2026-09-10
const BUDGET_BYTES = 5 * 1024 * 1024;

const TITLES = [
  'Quarterly planning doc — Q4 roadmap and staffing notes',
  'Best chicken tikka masala recipe | Serious Eats',
  'Inbox (3) — prasannakumar.jpk@gmail.com — Gmail',
  'Pull request #4821: fix canonicalizer edge cases',
  'Seattle weather forecast — National Weather Service',
  'TabSense M3 milestone plan — Notion',
  'Figma — TabSense side panel v2 explorations',
  'How the canonicalizer works — engineering blog',
  'Costa Rica itinerary, April 2027 — Google Sheets',
  'TypeScript generics deep dive — Stack Overflow',
  'Receipt for your payment — order confirmation',
  'Design review notes, sync with Alyssa and Nick',
  'Understanding focus-swap latency budgets',
  'Weekend train trip — tickets and timetable',
  'Mortgage rate tracker — October update',
  'Adhya math practice — arrays and area model',
];

function titleFor(i: number): string {
  return TITLES[i % TITLES.length];
}

function faviconFor(url: string): string {
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return '';
  }
}

interface SimState {
  activity: ActivityEntry[];
  swapSamples: SwapSample[];
  groupActivity: GroupActivityEntry[];
  dismissals: DismissalRecord[];
  suggestions: Suggestion[];
  groupRecords: TabSenseGroupRecord[];
  lastAction: {
    tabIds: number[];
    chromeGroupId: number;
    recordLocalId: string | null;
    createdNewGroup: boolean;
    groupName: string;
    description: string;
    at: number;
  } | null;
}

/** The 500-tab session snapshot content: real TabInfo-shaped
 * entries (corpus URLs, real canonical keys, real titles). */
function buildSessionTabs(corpus: readonly string[]): TabInfo[] {
  return corpus.slice(0, 500).map((url, i) => {
    const keys = canonicalKeysFallback(url);
    return {
      id: i + 1,
      windowId: 1 + (i % 3),
      title: titleFor(i),
      url,
      active: i === 0,
      pinned: false,
      exactKey: keys.exactKey,
      fuzzyKey: keys.fuzzyKey,
      firstSeenAt: START - i * 60_000,
      favIconUrl: faviconFor(url),
      lastAccessed: START - i * 30_000,
      groupId: -1,
    };
  });
}

/** Rebuild the suggestion inbox the worker's way: real
 * buildSuggestions over a crowded window (30 hosts × 3 tabs on the
 * domain-only rung → the per-window cap binds), then the draft →
 * persisted-Suggestion mapping from background.ts. */
function rebuildSuggestions(state: SimState, now: number): Suggestion[] {
  const tabs: EngineTab[] = [];
  for (let h = 0; h < 30; h++) {
    for (let j = 0; j < 3; j++) {
      const id = 500_000 + h * 3 + j;
      tabs.push({
        id,
        title: titleFor(h + j),
        url: `https://host${h}.example.com/page-${j}`,
        exactKey: null,
        fuzzyKey: null,
        windowId: 1,
        groupId: -1,
        pinned: false,
        excluded: false,
      });
    }
  }
  const drafts = buildSuggestions({
    tabs,
    groups: [],
    blocklist: [...DEFAULT_BLOCKLIST],
    rung: 'domain-only',
    dismissed: state.dismissals,
    scorer: tsScorer,
  });
  return drafts.map((d, i) => ({
    id: `s${now.toString(36)}-${i}`,
    kind: d.kind,
    windowId: d.windowId,
    tabIds: d.tabIds,
    tabs: d.tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url })),
    targetGroupKey: d.targetGroupKey,
    targetGroupName: d.targetGroupName,
    proposedName: d.proposedName,
    confidence: d.confidence,
    source: d.source,
    nanoFallback: d.nanoFallback,
    createdAt: now,
  }));
}

function simulateOneDay(
  state: SimState,
  corpus: readonly string[],
  day: number,
  seq: { n: number },
): void {
  const now = START + day * DAY_MS;
  const nextSeq = () => ++seq.n;

  // 400 tab events → activity entries (worker's slice discipline).
  for (let i = 0; i < 400; i++) {
    const s = nextSeq();
    const entry: ActivityEntry = {
      id: `${now + i}-${s}`,
      url: corpus[s % corpus.length],
      title: titleFor(s),
      closedTabId: 10_000 + (s % 5_000),
      keptTabId: 10_000 + ((s + 1) % 5_000),
      closedAt: now + i * 1_000,
      reason: s % 3 === 0 ? 'bulk-close' : 'auto-close',
    };
    state.activity = [entry, ...state.activity].slice(0, ACTIVITY_CAP);
  }

  // 100 focus-swap samples (worker's slice discipline).
  for (let i = 0; i < 100; i++) {
    const s = nextSeq();
    const sample: SwapSample = {
      ms: 15 + (s % 90),
      cold: i % 10 === 0,
      at: now + i * 1_000,
    };
    state.swapSamples = [...state.swapSamples, sample].slice(
      -SWAP_SAMPLES_CAP,
    );
  }

  // 60 group actions → group-activity entries (worker's slice).
  for (let i = 0; i < 60; i++) {
    const s = nextSeq();
    const tabIds = [s % 500, (s + 1) % 500, (s + 2) % 500];
    const entry: GroupActivityEntry = {
      id: `g${now}-${i}`,
      at: now + i * 1_000,
      action: i % 3 === 0 ? 'dismiss' : i % 3 === 1 ? 'accept' : 'undo',
      kind: i % 2 === 0 ? 'new-group' : 'add-to-group',
      groupName: `Project ${i % 12}`,
      tabIds,
      tabTitles: tabIds.map((_, j) => titleFor(s + j)),
    };
    state.groupActivity = [entry, ...state.groupActivity].slice(
      0,
      GROUP_ACTIVITY_CAP,
    );
  }

  // 40 dismissals, accumulated through the REAL capDismissals.
  const fresh: DismissalRecord[] = Array.from({ length: 40 }, (_, i) => ({
    signature: dismissalSignature(
      'new-group',
      [900_000 + day * 1_000 + i * 3, 900_001 + day * 1_000 + i * 3],
      `name:sim-group-${day}-${i}`,
    ),
    at: now + i,
  }));
  state.dismissals = capDismissals([...state.dismissals, ...fresh]);

  // Suggestion inbox rebuilt from live state (real engine + cap).
  state.suggestions = rebuildSuggestions(state, now);

  // 2 of the day's group actions created brand-new groups. NOTE:
  // group records have no cap anywhere in the worker — records are
  // appended on accept and only removed by undoing that exact
  // action — so this collection grows linearly in the simulation
  // too, at 2 records/day. It is the one non-ring collection here;
  // its per-record identity fields are exemplar-capped (5 keys),
  // which is what keeps the growth to ~0.5 KB/day.
  for (let g = 0; g < 2; g++) {
    const s = nextSeq();
    const members: ScorerTabInput[] = Array.from({ length: 4 }, (_, j) => {
      const url = corpus[(s + j * 977) % corpus.length];
      const keys = canonicalKeysFallback(url);
      return {
        id: 20_000 + ((s + j) % 500),
        title: titleFor(s + j),
        url,
        exactKey: keys.exactKey,
        fuzzyKey: keys.fuzzyKey,
      };
    });
    const name = `Project ${s}`;
    const record: TabSenseGroupRecord = {
      localId: groupLocalId(now, s),
      name,
      signature: computeGroupSignature(name, members),
      exemplarKeys: exemplarKeysOf(members),
      windowId: 1,
      chromeGroupId: 700 + s,
      memberTabIds: members.map((m) => m.id),
      createdAt: now,
      updatedAt: now,
    };
    state.groupRecords.push(record);
    state.lastAction = {
      tabIds: record.memberTabIds,
      chromeGroupId: record.chromeGroupId ?? -1,
      recordLocalId: record.localId,
      createdNewGroup: true,
      groupName: name,
      description: `Grouped ${record.memberTabIds.length} tabs into “${name}”`,
      at: now,
    };
  }
}

/** Assemble the full chrome.storage.local object exactly as the
 * worker persists it (all ten keys, worker value shapes). */
function buildStorageObject(
  state: SimState,
  sessionTabs: TabInfo[],
  now: number,
): Record<string, unknown> {
  const snapshot: TabSnapshot = {
    updatedAt: now,
    tabs: sessionTabs,
    duplicates: summarizeDuplicates(sessionTabs.map((t) => t.url)),
    wasmReady: true,
    coreState: 'ready',
    autoCloseEnabled: true,
    normalizedSample: {
      url: sessionTabs[0].url,
      normalized: sessionTabs[0].exactKey ?? sessionTabs[0].url,
      engine: 'fallback',
    },
    activity: state.activity.slice(0, 15),
    swaps: summarizeSwaps(state.swapSamples),
    suggestions: state.suggestions,
    grouping: {
      rung: 'heuristics',
      nanoAvailability: 'available',
      pausedByUser: false,
      lastRunAt: now,
    },
    groupOptions: state.groupRecords
      .filter((r) => r.chromeGroupId !== null)
      .map((r) => ({
        groupKey: groupKeyOf(r),
        name: r.name,
        memberCount: r.memberTabIds.length,
        windowId: r.windowId,
      })),
    settingsView: {
      autoCloseEnabled: true,
      groupingPaused: false,
      provider: 'nano',
      blocklist: [...DEFAULT_BLOCKLIST],
      sources: {
        autoCloseEnabled: 'local',
        groupingPaused: 'local',
        provider: 'local',
        blocklist: 'local',
      },
      managedKeys: [],
    },
    lastGroupAction: state.lastAction
      ? { description: state.lastAction.description, at: state.lastAction.at }
      : null,
  };
  return {
    [SNAPSHOT_KEY]: snapshot,
    [ACTIVITY_KEY]: state.activity,
    [SWAP_SAMPLES_KEY]: state.swapSamples,
    [SETTINGS_KEY]: true,
    [SUGGESTIONS_KEY]: state.suggestions,
    [GROUPS_KEY]: state.groupRecords,
    [DISMISSED_KEY]: state.dismissals,
    [GROUP_ACTIVITY_KEY]: state.groupActivity,
    [LAST_ACTION_KEY]: state.lastAction,
    [GROUPING_SETTINGS_KEY]: {
      groupingPaused: false,
      provider: 'nano',
      blocklist: null,
    },
  };
}

describe('perf — storage footprint after simulated 30 days (budget: < 5 MB)', () => {
  it('stays under 5 MB and growth flattens once the rings saturate', () => {
    const corpus = generateCorpus();
    const sessionTabs = buildSessionTabs(corpus);
    const state: SimState = {
      activity: [],
      swapSamples: [],
      groupActivity: [],
      dismissals: [],
      suggestions: [],
      groupRecords: [],
      lastAction: null,
    };
    const seq = { n: 0 };
    const encoder = new TextEncoder();

    let day7: { bytes: number; lengths: Record<string, number> } | null =
      null;
    let day30: { bytes: number; lengths: Record<string, number> } | null =
      null;

    for (let day = 0; day < 30; day++) {
      simulateOneDay(state, corpus, day, seq);
      if (day === 6 || day === 29) {
        const now = START + day * DAY_MS;
        const storage = buildStorageObject(state, sessionTabs, now);
        const bytes = encoder.encode(JSON.stringify(storage)).length;
        const lengths = {
          activity: state.activity.length,
          swapSamples: state.swapSamples.length,
          groupActivity: state.groupActivity.length,
          dismissals: state.dismissals.length,
          suggestions: state.suggestions.length,
          groupRecords: state.groupRecords.length,
          storageKeys: Object.keys(storage).length,
        };
        if (day === 6) day7 = { bytes, lengths };
        else day30 = { bytes, lengths };
      }
    }

    expect(day7).not.toBeNull();
    expect(day30).not.toBeNull();
    const d7 = day7 as NonNullable<typeof day7>;
    const d30 = day30 as NonNullable<typeof day30>;
    console.log(
      `[perf] storage day7=${d7.bytes} bytes day30=${d30.bytes} bytes ` +
        `(budget ${BUDGET_BYTES}) lengths=${JSON.stringify(d30.lengths)}`,
    );

    // All ten storage keys are present in the serialized object.
    expect(d30.lengths.storageKeys).toBe(10);

    // Budget.
    expect(d30.bytes).toBeLessThan(BUDGET_BYTES);

    // Every ring is saturated at its cap by day 7 and holds exactly
    // the same length at day 30 — rotation engages, nothing keeps
    // accumulating.
    expect(d7.lengths.activity).toBe(ACTIVITY_CAP);
    expect(d30.lengths.activity).toBe(ACTIVITY_CAP);
    expect(d7.lengths.swapSamples).toBe(SWAP_SAMPLES_CAP);
    expect(d30.lengths.swapSamples).toBe(SWAP_SAMPLES_CAP);
    expect(d7.lengths.groupActivity).toBe(GROUP_ACTIVITY_CAP);
    expect(d30.lengths.groupActivity).toBe(GROUP_ACTIVITY_CAP);
    expect(d7.lengths.dismissals).toBe(DISMISSAL_CAP);
    expect(d30.lengths.dismissals).toBe(DISMISSAL_CAP);
    expect(d30.lengths.suggestions).toBeLessThanOrEqual(
      MAX_SUGGESTIONS_PER_WINDOW,
    );

    // Growth flattens: the only residual growth between day 7 and
    // day 30 is the uncapped group-records collection (2 small
    // records/day in this simulation), so the total grows by a few
    // percent — not by the 23 extra days of churn.
    expect(d30.bytes).toBeLessThan(d7.bytes * 1.25);
    expect(d30.bytes - d7.bytes).toBeLessThan(64 * 1024);
    expect(d30.lengths.groupRecords).toBe(60);
  }, 60_000);
});
