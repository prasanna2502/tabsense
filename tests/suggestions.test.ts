import { describe, expect, it } from 'vitest';
import { DEFAULT_BLOCKLIST } from '../src/lib/blocklist';
import {
  computeGroupSignature,
  dismissalSignature,
  type TabSenseGroupRecord,
} from '../src/lib/groups';
import { tsScorer } from '../src/lib/scorer';
import {
  applyNanoJudgments,
  buildSuggestions,
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
