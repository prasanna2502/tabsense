import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKLIST } from '../src/lib/blocklist';
import {
  computeGroupSignature,
  dismissalSignature,
  isPlatformGroupName,
  type TabSenseGroupRecord,
} from '../src/lib/groups';
import { validateVerdictText } from '../src/lib/nano';
import { tsScorer } from '../src/lib/scorer';
import {
  SPLIT_EVAL_SIZE,
  SuggestionEngineGuard,
  applyNanoJudgments,
  buildSuggestions,
  groupingEngineKey,
  needsSplitEvaluation,
  type EngineGroup,
  type EngineTab,
  type SuggestionDraft,
} from '../src/lib/suggestions';

function engineTab(
  id: number,
  title: string,
  url: string,
  over: Partial<EngineTab> = {},
): EngineTab {
  return {
    id,
    title,
    url,
    exactKey: null,
    fuzzyKey: null,
    windowId: 1,
    groupId: -1,
    pinned: false,
    excluded: false,
    ...over,
  };
}

function record(
  localId: string,
  name: string,
  members: EngineTab[],
  windowId = 1,
): TabSenseGroupRecord {
  return {
    localId,
    name,
    signature: computeGroupSignature(name, members),
    exemplarKeys: members.map((m) => m.fuzzyKey ?? m.exactKey ?? ''),
    windowId,
    chromeGroupId: 42,
    memberTabIds: members.map((m) => m.id),
    createdAt: 0,
    updatedAt: 0,
  };
}

const recipeTab = (
  id: number,
  t: string,
  u: string,
  over: Partial<EngineTab> = {},
) => engineTab(id, t, u, over);

function baseInput(over: Partial<Parameters<typeof buildSuggestions>[0]> = {}) {
  return {
    tabs: [] as EngineTab[],
    groups: [] as EngineGroup[],
    blocklist: [...DEFAULT_BLOCKLIST],
    rung: 'heuristics' as const,
    dismissed: [],
    scorer: tsScorer,
    ...over,
  };
}

describe('buildSuggestions — clusters', () => {
  it('turns a topical cluster into a new-group suggestion', () => {
    const tabs = [
      recipeTab(1, 'Best Chicken Tikka Masala Recipe', 'https://www.allrecipes.com/recipe/228293/chicken-tikka-masala'),
      recipeTab(2, 'Chicken Parmesan Recipe', 'https://www.seriouseats.com/chicken-parmesan-recipe'),
      recipeTab(3, 'Easy Chicken Soup Recipe', 'https://www.bbcgoodfood.com/recipes/chicken-soup'),
      recipeTab(4, 'Seattle Weather Forecast', 'https://weather.com/weather/today/seattle'),
    ];
    const drafts = buildSuggestions(baseInput({ tabs }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('new-group');
    expect(drafts[0].tabIds).toEqual([1, 2, 3]);
    expect(drafts[0].proposedName).toBe('Chicken');
    expect(drafts[0].source).toBe('heuristics');
  });

  it('paused rung suggests nothing', () => {
    const tabs = [
      recipeTab(1, 'Chicken soup recipe', 'https://a.example.com/soup'),
      recipeTab(2, 'Chicken stew recipe', 'https://a.example.com/stew'),
    ];
    expect(buildSuggestions(baseInput({ tabs, rung: 'paused' }))).toEqual([]);
  });
});

describe('buildSuggestions — hands-off rules (A2)', () => {
  const clusterTabs = () => [
    recipeTab(1, 'Chicken soup recipe', 'https://a.example.com/soup'),
    recipeTab(2, 'Chicken stew recipe', 'https://a.example.com/stew'),
    recipeTab(3, 'Chicken pie recipe', 'https://a.example.com/pie'),
  ];

  it('never suggests a tab that is in a manual group', () => {
    const tabs = clusterTabs();
    tabs[2] = { ...tabs[2], groupId: 777 }; // user-created group
    const drafts = buildSuggestions(baseInput({ tabs }));
    for (const d of drafts) expect(d.tabIds).not.toContain(3);
  });

  it('never suggests pinned or excluded tabs', () => {
    const tabs = clusterTabs();
    tabs[0] = { ...tabs[0], pinned: true };
    tabs[1] = { ...tabs[1], excluded: true };
    expect(buildSuggestions(baseInput({ tabs }))).toEqual([]);
  });

  it('never suggests blocklisted (sensitive) tabs', () => {
    const tabs = [
      recipeTab(1, 'Chicken soup recipe', 'https://a.example.com/soup'),
      recipeTab(2, 'Chicken stew recipe', 'https://a.example.com/stew'),
      recipeTab(3, 'Account login', 'https://www.chase.com/login'),
      recipeTab(4, 'Account login help', 'https://secure.chase.com/help'),
    ];
    const drafts = buildSuggestions(baseInput({ tabs }));
    for (const d of drafts) {
      expect(d.tabIds).not.toContain(3);
      expect(d.tabIds).not.toContain(4);
    }
  });

  it('keeps windows separate: no cross-window suggestions', () => {
    const tabs = [
      recipeTab(1, 'Chicken soup recipe', 'https://a.example.com/soup'),
      recipeTab(2, 'Chicken stew recipe', 'https://a.example.com/stew', { windowId: 2 }),
    ];
    expect(buildSuggestions(baseInput({ tabs }))).toEqual([]);
  });

  it('honors dismissals', () => {
    const tabs = clusterTabs();
    const sig = dismissalSignature(
      'new-group',
      [1, 2, 3],
      'name:chicken',
    );
    const drafts = buildSuggestions(
      baseInput({ tabs, dismissed: [{ signature: sig, at: 1 }] }),
    );
    expect(drafts).toEqual([]);
  });
});

describe('buildSuggestions — add to existing group', () => {
  it('suggests filing a matching singleton into a TabSense group', () => {
    const member = recipeTab(10, 'Chicken soup recipe', 'https://recipes.example.com/soup', { groupId: 42 });
    const rec = record('g1', 'Recipes', [member]);
    const stray = recipeTab(5, 'Chicken soup recipe easy', 'https://recipes.example.com/soup2');
    const drafts = buildSuggestions(
      baseInput({ tabs: [stray], groups: [{ record: rec, members: [member] }] }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('add-to-group');
    expect(drafts[0].targetGroupKey).toBe('ts:g1');
    expect(drafts[0].targetGroupName).toBe('Recipes');
  });
});

describe('platform-name ban in heuristic naming (Phase 3)', () => {
  it('domain-only rung: a docs.google.com bucket gets no platform-named draft', () => {
    const tabs = [
      recipeTab(1, 'Quarterly earnings call notes', 'https://docs.google.com/document/d/a1/edit'),
      recipeTab(2, 'Totally unrelated opinion piece', 'https://docs.google.com/document/d/b2/edit'),
    ];
    expect(buildSuggestions(baseInput({ tabs, rung: 'domain-only' }))).toEqual([]);
  });

  it('heuristics rung: a same-platform cluster is named by topic, never by platform', () => {
    const tabs = [
      recipeTab(1, 'Costa Rica Itinerary - Google Docs', 'https://docs.google.com/document/d/a1/edit'),
      recipeTab(2, 'Costa Rica Budget - Google Sheets', 'https://docs.google.com/spreadsheets/d/b2/edit'),
      recipeTab(3, 'Costa Rica Packing List - Google Docs', 'https://docs.google.com/document/d/c3/edit'),
    ];
    const drafts = buildSuggestions(baseInput({ tabs }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedName).toBe('Costa');
  });

  it('heuristics rung: when the seed would be a platform word, the next topic token names the group', () => {
    const tabs = [
      recipeTab(1, 'Google Cloud Console — Kestrel Project', 'https://console.cloud.google.com/kestrel'),
      recipeTab(2, 'Google Cloud Billing — Kestrel Project', 'https://console.cloud.google.com/billing/kestrel'),
    ];
    const drafts = buildSuggestions(baseInput({ tabs }));
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0].proposedName).not.toBe('Google');
    expect(['Cloud', 'Kestrel', 'Project']).toContain(drafts[0].proposedName);
  });
});

describe('buildSuggestions — domain-only rung', () => {
  it('buckets by host with flat confidence', () => {
    const tabs = [
      recipeTab(1, 'Quarterly earnings call notes', 'https://example.com/a'),
      recipeTab(2, 'Totally unrelated opinion piece', 'https://example.com/b'),
      recipeTab(3, 'Chicken soup recipe', 'https://recipes.example.com/soup'),
    ];
    const drafts = buildSuggestions(baseInput({ tabs, rung: 'domain-only' }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0].tabIds).toEqual([1, 2]);
    expect(drafts[0].source).toBe('domain-only');
    expect(drafts[0].confidence).toBe(0.5);
    expect(drafts[0].proposedName).toBe('Example');
  });
});

describe('applyNanoJudgments', () => {
  const clusterDraft: SuggestionDraft = {
    kind: 'new-group',
    windowId: 1,
    tabIds: [1, 2],
    tabs: [
      { id: 1, title: 'Chicken soup recipe', url: 'https://a.example.com/soup', exactKey: null, fuzzyKey: null },
      { id: 2, title: 'Chicken stew recipe', url: 'https://a.example.com/stew', exactKey: null, fuzzyKey: null },
    ],
    targetGroupKey: null,
    targetGroupName: null,
    proposedName: 'Chicken',
    confidence: 0.6,
    source: 'heuristics',
    nanoFallback: false,
  };

  it('a judge new-group verdict renames and marks the source as nano', async () => {
    const { drafts, stats } = await applyNanoJudgments([clusterDraft], [], () =>
      Promise.resolve({
        verdict: { action: 'new-group', name: 'Comfort Food' },
        callFailed: false,
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedName).toBe('Comfort Food');
    expect(drafts[0].source).toBe('nano');
    expect(stats).toEqual({ calls: 1, failures: 0 });
  });

  it('a reject verdict drops the suggestion', async () => {
    const { drafts } = await applyNanoJudgments([clusterDraft], [], () =>
      Promise.resolve({ verdict: { action: 'reject' }, callFailed: false }),
    );
    expect(drafts).toEqual([]);
  });

  it('a failed judgment keeps the heuristics draft at reduced confidence', async () => {
    const { drafts, stats } = await applyNanoJudgments([clusterDraft], [], () =>
      Promise.resolve({ verdict: null, callFailed: false }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source).toBe('heuristics');
    expect(drafts[0].nanoFallback).toBe(true);
    expect(drafts[0].confidence).toBeCloseTo(0.42, 6);
    expect(stats.failures).toBe(1);
  });

  it('one throwing judge call does not sink the batch (per-batch isolation)', async () => {
    const judge = (req: { tabs: unknown[] }) =>
      req.tabs.length > 1
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({
            verdict: { action: 'new-group' as const, name: 'Solo' },
            callFailed: false,
          });
    const single: SuggestionDraft = {
      ...clusterDraft,
      tabIds: [9],
      tabs: [clusterDraft.tabs[0]],
    };
    const { drafts, stats } = await applyNanoJudgments(
      [clusterDraft, single],
      [],
      judge as never,
    );
    // First draft survived as fallback; second was judged.
    expect(drafts).toHaveLength(2);
    expect(drafts[0].nanoFallback).toBe(true);
    expect(drafts[1].source).toBe('nano');
    expect(stats).toEqual({ calls: 2, failures: 1 });
  });

  it('an add-to-group draft judged new-topic is dropped (no groups of one)', async () => {
    const assign: SuggestionDraft = {
      ...clusterDraft,
      kind: 'add-to-group',
      tabIds: [1],
      tabs: [clusterDraft.tabs[0]],
      targetGroupKey: 'ts:g1',
      targetGroupName: 'Recipes',
      proposedName: null,
    };
    const { drafts } = await applyNanoJudgments([assign], [], () =>
      Promise.resolve({ verdict: { action: 'new-topic' }, callFailed: false }),
    );
    expect(drafts).toEqual([]);
  });
});

describe('engine honesty — drafts carry the active rung', () => {
  const tabs = () => [
    recipeTab(1, 'Chicken soup recipe', 'https://a.example.com/soup'),
    recipeTab(2, 'Chicken stew recipe', 'https://a.example.com/stew'),
  ];

  it('heuristics rung labels its drafts as heuristics', () => {
    const drafts = buildSuggestions(baseInput({ tabs: tabs() }));
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.source).toBe('heuristics');
      expect(d.nanoFallback).toBe(false);
    }
  });

  it('domain-only rung labels its drafts as domain-only', () => {
    const drafts = buildSuggestions(
      baseInput({ tabs: tabs(), rung: 'domain-only' }),
    );
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) expect(d.source).toBe('domain-only');
  });

  it('nano rung: judged drafts are labeled nano; failed judgments stay flagged heuristics fallbacks', async () => {
    const base = buildSuggestions(baseInput({ tabs: tabs(), rung: 'nano' }));
    expect(base.length).toBeGreaterThan(0);
    const judged = await applyNanoJudgments(base, [], () =>
      Promise.resolve({
        verdict: { action: 'new-topic' },
        callFailed: false,
      }),
    );
    for (const d of judged.drafts) expect(d.source).toBe('nano');
    const failed = await applyNanoJudgments(base, [], () =>
      Promise.resolve({ verdict: null, callFailed: true }),
    );
    for (const d of failed.drafts) {
      expect(d.source).toBe('heuristics');
      expect(d.nanoFallback).toBe(true);
    }
  });
});

describe('SuggestionEngineGuard — engine-change invalidation (Phase 3)', () => {
  const nanoKey = groupingEngineKey('nano', 'nano');
  const heurKey = groupingEngineKey('nano', 'heuristics');

  it('engine identity combines provider and rung', () => {
    expect(groupingEngineKey('nano', 'nano')).toBe('nano:nano');
    expect(groupingEngineKey('heuristics', 'heuristics')).toBe(
      'heuristics:heuristics',
    );
    expect(nanoKey).not.toBe(heurKey);
  });

  it('no discard when the engine has not actually changed', () => {
    const guard = new SuggestionEngineGuard();
    guard.noteProduced(heurKey);
    expect(guard.staleCount(heurKey, 23)).toBe(0);
  });

  it('all pending suggestions are stale after a rung change (heuristics → nano)', () => {
    const guard = new SuggestionEngineGuard();
    guard.noteProduced(heurKey);
    expect(guard.staleCount(nanoKey, 23)).toBe(23);
    guard.noteProduced(nanoKey);
    expect(guard.staleCount(nanoKey, 23)).toBe(0);
  });

  it('a provider switch invalidates even at the same rung', () => {
    const guard = new SuggestionEngineGuard();
    guard.noteProduced(groupingEngineKey('nano', 'heuristics'));
    expect(
      guard.staleCount(groupingEngineKey('heuristics', 'heuristics'), 4),
    ).toBe(4);
  });

  it('an empty inbox discards nothing, and an unknown producer discards nothing', () => {
    const guard = new SuggestionEngineGuard();
    guard.noteProduced(heurKey);
    expect(guard.staleCount(nanoKey, 0)).toBe(0);
    const fresh = new SuggestionEngineGuard();
    expect(fresh.staleCount(nanoKey, 5)).toBe(0);
  });

  it('restored legacy suggestions are attributed to the old engine', () => {
    const guard = new SuggestionEngineGuard();
    guard.restore('legacy-unknown');
    expect(guard.staleCount(nanoKey, 23)).toBe(23);
    expect(guard.staleCount(heurKey, 23)).toBe(23);
  });
});

describe('needsSplitEvaluation — forced split routing (Phase 3)', () => {
  const draft = (
    tabs: EngineTab[],
    proposedName: string | null,
    kind: SuggestionDraft['kind'] = 'new-group',
  ): SuggestionDraft => ({
    kind,
    windowId: 1,
    tabIds: tabs.map((t) => t.id),
    tabs,
    targetGroupKey: null,
    targetGroupName: null,
    proposedName,
    confidence: 0.5,
    source: 'heuristics',
    nanoFallback: false,
  });
  const doc = (id: number, title: string) =>
    engineTab(id, title, `https://docs.google.com/document/d/x${id}/edit`);

  it('size alone triggers: more than 8 tabs', () => {
    const tabs = Array.from({ length: SPLIT_EVAL_SIZE + 1 }, (_, i) =>
      doc(i + 1, `Costa Rica Plan Part ${i + 1}`),
    );
    expect(needsSplitEvaluation(draft(tabs, 'Costa'))).toBe(true);
  });

  it('same multi-doc host with low title cohesion triggers', () => {
    const tabs = [
      doc(1, 'Quarterly Budget Review - Google Sheets'),
      doc(2, 'Marketing Launch Plan - Google Docs'),
      doc(3, 'Family Recipes Collection - Google Docs'),
      doc(4, 'Apartment Lease Agreement - Google Docs'),
      doc(5, 'Wedding Speech Draft - Google Slides'),
    ];
    // Two-token name keeps the name trigger out of the way.
    expect(needsSplitEvaluation(draft(tabs, 'Mixed Topics'))).toBe(true);
  });

  it('a cohesive same-platform cluster does not trigger', () => {
    const tabs = [
      doc(1, 'Costa Rica Itinerary - Google Docs'),
      doc(2, 'Costa Rica Budget - Google Sheets'),
      doc(3, 'Costa Rica Packing List - Google Docs'),
    ];
    expect(needsSplitEvaluation(draft(tabs, 'Costa'))).toBe(false);
  });

  it('majority-theme naming smell triggers (the "Darwin" case)', () => {
    const tabs = [
      engineTab(1, 'Darwin Release Notes', 'https://a.example.com/1'),
      engineTab(2, 'Darwin Rollout Checklist', 'https://b.example.com/2'),
      engineTab(3, 'Github Pod Status Updates', 'https://c.example.com/3'),
      engineTab(4, 'RecSys Learning Series', 'https://d.example.com/4'),
      engineTab(5, 'RecSys Onsite Agenda', 'https://e.example.com/5'),
      engineTab(6, 'Budget Review', 'https://f.example.com/6'),
    ];
    // 'darwin' appears in 2 of 6 titles (< 60%).
    expect(needsSplitEvaluation(draft(tabs, 'Darwin'))).toBe(true);
    const named = tabs.map((t, i) =>
      i < 4
        ? engineTab(t.id, `Darwin Topic ${i}`, t.url)
        : t,
    );
    // 4 of 6 titles carry the name token (≥ 60%): no smell.
    expect(needsSplitEvaluation(draft(named, 'Darwin'))).toBe(false);
  });

  it('assign drafts never route to split evaluation', () => {
    const tabs = Array.from({ length: 12 }, (_, i) =>
      doc(i + 1, `Doc ${i + 1}`),
    );
    expect(needsSplitEvaluation(draft(tabs, 'X', 'add-to-group'))).toBe(false);
  });
});

describe('applyNanoJudgments — split partitions (Phase 3)', () => {
  const fourTabs = [1, 2, 3, 4].map((i) =>
    engineTab(i, `Tab ${i}`, `https://docs.google.com/document/d/t${i}/edit`),
  );
  const blob: SuggestionDraft = {
    kind: 'new-group',
    windowId: 1,
    tabIds: [1, 2, 3, 4],
    tabs: fourTabs,
    targetGroupKey: null,
    targetGroupName: null,
    proposedName: 'Stuff',
    confidence: 0.5,
    source: 'heuristics',
    nanoFallback: false,
  };

  it('expands a partition into per-topic drafts marked fromPartition', async () => {
    const { drafts } = await applyNanoJudgments([blob], [], () =>
      Promise.resolve({
        verdict: {
          action: 'split' as const,
          groups: [
            { name: 'Topic A', tabs: [1, 2] },
            { name: 'Topic B', tabs: [3, 4] },
          ],
          ungrouped: [],
        },
        callFailed: false,
      }),
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0].proposedName).toBe('Topic A');
    expect(drafts[0].tabIds).toEqual([1, 2]);
    expect(drafts[1].tabIds).toEqual([3, 4]);
    for (const d of drafts) {
      expect(d.source).toBe('nano');
      expect(d.fromPartition).toBe(true);
    }
  });

  it('ungrouped tabs in a partition get no suggestion', async () => {
    const { drafts } = await applyNanoJudgments([blob], [], () =>
      Promise.resolve({
        verdict: {
          action: 'split' as const,
          groups: [{ name: 'Topic A', tabs: [1, 2] }],
          ungrouped: [3, 4],
        },
        callFailed: false,
      }),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].tabIds).toEqual([1, 2]);
  });
});

describe('router handoff cap (Phase 3)', () => {
  const megaTabs = () =>
    Array.from({ length: 10 }, (_, i) =>
      engineTab(
        i + 1,
        `Project Kestrel Doc — Part ${['Alpha','Beta','Gamma','Delta','Epsilon','Zeta','Eta','Theta','Iota','Kappa'][i]}`,
        `https://docs.google.com/document/d/mega${i}/edit`,
      ),
    );

  it('heuristics rung caps a same-platform mega-cluster draft at the split threshold', () => {
    const drafts = buildSuggestions(baseInput({ tabs: megaTabs() }));
    const cluster = drafts.find((d) => d.kind === 'new-group');
    expect(cluster).toBeDefined();
    expect(cluster?.tabIds.length).toBe(SPLIT_EVAL_SIZE);
  });

  it('nano rung passes the full pool to the judge (no cap)', () => {
    const drafts = buildSuggestions(
      baseInput({ tabs: megaTabs(), rung: 'nano' }),
    );
    const cluster = drafts.find((d) => d.kind === 'new-group');
    expect(cluster?.tabIds.length).toBe(10);
  });
});

describe('kestrel corpus — judge partition of the mega-cluster (Phase 3)', () => {
  it('the 20-tab same-domain blob partitions into the latent topics, decoys ungrouped', async () => {
    const corpus = JSON.parse(
      readFileSync('benchmarks/sessions.json', 'utf8'),
    ) as {
      sessions: {
        id: string;
        tabs: { title: string; url: string }[];
      }[];
    };
    const session = corpus.sessions.find((s) => s.id === 'kestrel-docs');
    if (!session) throw new Error('kestrel-docs session missing');
    const tabs: EngineTab[] = session.tabs.map((t, i) =>
      engineTab(i + 1, t.title, t.url),
    );
    const blob: SuggestionDraft = {
      kind: 'new-group',
      windowId: 1,
      tabIds: tabs.map((t) => t.id),
      tabs,
      targetGroupKey: null,
      targetGroupName: null,
      proposedName: 'Kestrel',
      confidence: 0.5,
      source: 'heuristics',
      nanoFallback: false,
    };
    const idx = (part: string) =>
      session.tabs.findIndex((t) => t.title.includes(part)) + 1;
    const partition = {
      action: 'split',
      groups: [
        {
          name: 'Kestrel Platform RFCs',
          tabs: [idx('RFC 12'), idx('RFC 13'), idx('Architecture Overview')],
        },
        {
          name: 'Kestrel Team Syncs',
          tabs: [idx('Oct 5'), idx('Oct 12'), idx('Oct 19')],
        },
        {
          name: 'Learning Rust',
          tabs: [idx('Session 1'), idx('Session 2'), idx('Session 3')],
        },
        {
          name: 'Ramp Plan',
          tabs: [idx('First 30 Days'), idx('Mentorship Pairings')],
        },
        {
          name: 'Recommendation Systems Learning',
          tabs: [idx('Part 1'), idx('Part 2')],
        },
      ],
      ungrouped: [
        idx('Falcon Pod'),
        idx('Onsite'),
        idx('Q3 Budget'),
        idx('Lease Renewal'),
        idx('Book Club'),
        idx('Sourdough'),
        idx('Visa Renewal'),
      ],
    };
    const judge = (req: Parameters<typeof validateVerdictText>[1]) =>
      Promise.resolve({
        verdict: validateVerdictText(JSON.stringify(partition), req),
        callFailed: false,
      });
    const { drafts, stats } = await applyNanoJudgments(
      [blob],
      [],
      judge as never,
    );
    expect(stats.failures).toBe(0);
    expect(drafts.map((d) => d.proposedName).sort()).toEqual([
      'Kestrel Platform RFCs',
      'Kestrel Team Syncs',
      'Learning Rust',
      'Ramp Plan',
      'Recommendation Systems Learning',
    ]);
    for (const d of drafts) {
      expect(d.source).toBe('nano');
      expect(d.fromPartition).toBe(true);
      expect(isPlatformGroupName(d.proposedName ?? '')).toBe(false);
    }
    const grouped = new Set(drafts.flatMap((d) => d.tabIds));
    for (const decoy of [
      'Falcon Pod',
      'Onsite',
      'Q3 Budget',
      'Lease Renewal',
      'Book Club',
      'Sourdough',
      'Visa Renewal',
    ]) {
      expect(grouped.has(idx(decoy))).toBe(false);
    }
  });
});
