/**
 * Grouping adversarial corpus (test-hardening commission,
 * method 4): the suggestion engine fed the inputs that produced
 * the dogfood failures and their neighbors — same-domain/
 * different-topic at scale, platform-suffix titles, decoy chaining
 * (hand-computed through the scorer's mean-affinity greedy),
 * one-token differences, mega-clusters at the split threshold,
 * the hands-off matrix under every rung, and TS↔Wasm partition
 * parity over generated tab sets.
 *
 * Defect D9 (P2, shared by both scorer implementations): titles
 * with no ASCII-alphanumeric tokens — CJK-only titles are the
 * common case — tokenize to the EMPTY set, so title similarity
 * is always 0 and even byte-identical CJK titles on one host
 * cannot cluster (score 0.25 host-only, below the 0.36
 * threshold; on multi-doc hosts the pair rule requires title
 * containment > 0 outright). The D9 tests are it.fails: they
 * assert the behavior users expect and will turn red when the
 * tokenizer learns non-ASCII words.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureCoreReady, getScorer } from '../src/wasm/load';
import {
  buildSuggestions,
  needsSplitEvaluation,
  type EngineTab,
  type SuggestionDraft,
} from '../src/lib/suggestions';
import {
  CLUSTER_THRESHOLD,
  pairScore,
  tsScorer,
  type Scorer,
  type ScorerTabInput,
} from '../src/lib/scorer';
import { dismissalSignature } from '../src/lib/groups';
import { rng } from './helpers/prng';

let wasmScorer: Scorer;

beforeAll(async () => {
  expect(await ensureCoreReady()).toBe(true);
  wasmScorer = getScorer();
});

let nextId = 1;
function etab(
  title: string,
  url: string,
  extra: Partial<EngineTab> = {},
): EngineTab {
  return {
    id: nextId++,
    title,
    url,
    exactKey: url,
    fuzzyKey: url,
    groupId: -1,
    windowId: 1,
    pinned: false,
    excluded: false,
    ...extra,
  };
}

function build(
  tabs: EngineTab[],
  rung: 'heuristics' | 'nano' | 'domain-only' | 'paused' = 'heuristics',
  extra: Partial<Parameters<typeof buildSuggestions>[0]> = {},
): SuggestionDraft[] {
  return buildSuggestions({
    tabs,
    groups: [],
    blocklist: [],
    rung,
    dismissed: [],
    scorer: tsScorer,
    ...extra,
  });
}

describe('same domain, different topics — at scale', () => {
  it('30 disjoint-topic Docs tabs produce no groups; the one real topic still clusters', () => {
    nextId = 1;
    const tabs: EngineTab[] = [];
    for (let i = 0; i < 30; i++) {
      tabs.push(
        etab(
          `zebra${i} quasar${i} vortex${i}`,
          `https://docs.google.com/document/d/DOC${i}/edit`,
        ),
      );
    }
    const topic = ['alpha', 'beta', 'gamma'].map((s) =>
      etab(
        `Quarterly planning ${s}`,
        `https://docs.google.com/document/d/TOPIC-${s}/edit`,
      ),
    );
    const drafts = build([...tabs, ...topic]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('new-group');
    expect(drafts[0].tabIds.sort()).toEqual(topic.map((t) => t.id).sort());
    expect(drafts[0].proposedName).toBe('Planning');
  });

  it('platform-suffixed titles: suffixes never become the topic, and different apps on one host do not merge on the brand', () => {
    nextId = 1;
    const tabs = [
      etab('Camping menu - Google Docs', 'https://docs.google.com/document/d/A1/edit'),
      etab('Camping gear list - Google Docs', 'https://docs.google.com/document/d/A2/edit'),
      etab('Invoice 1042 - Google Sheets', 'https://docs.google.com/spreadsheets/d/B1/edit'),
      etab('Invoice 1043 - Google Sheets', 'https://docs.google.com/spreadsheets/d/B2/edit'),
    ];
    const drafts = build(tabs);
    expect(drafts).toHaveLength(2);
    const names = drafts.map((d) => d.proposedName);
    expect(names).toContain('Camping');
    expect(names).toContain('Invoice');
    for (const d of drafts) {
      expect(d.tabIds).toHaveLength(2);
    }
  });

  it('titles that are ONLY a platform name cluster with nothing', () => {
    nextId = 1;
    const tabs = [
      etab('Google Docs', 'https://docs.google.com/document/d/A1/edit'),
      etab('Google Docs', 'https://docs.google.com/document/d/A2/edit'),
      etab('Untitled document', 'https://docs.google.com/document/d/A3/edit'),
      etab('', 'https://docs.google.com/document/d/A4/edit'),
    ];
    expect(build(tabs)).toEqual([]);
  });
});

describe('decoy chaining — hand-computed through the greedy', () => {
  it('a bridge tab pulls two mutually-dissimilar tabs into one cluster (mean affinity), and the pair scores prove A≁C', () => {
    nextId = 1;
    const a = etab('maple birch cedar', 'https://example.com/t1');
    const b = etab('birch cedar willow poplar', 'https://example.com/t2');
    const c = etab('willow poplar juniper', 'https://example.com/t3');
    const s = (x: EngineTab, y: EngineTab) =>
      pairScore(x as ScorerTabInput, y as ScorerTabInput);
    // A–B and B–C pair strongly; A–C shares no token at all and
    // sits at the bare same-host score, below the threshold.
    expect(s(a, b)).toBeCloseTo(0.65, 6);
    expect(s(b, c)).toBeCloseTo(0.65, 6);
    expect(s(a, c)).toBeCloseTo(0.25, 6);
    expect(s(a, c)).toBeLessThan(CLUSTER_THRESHOLD);
    const clusters = tsScorer.clusterTabs([a, b, c]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].tabIds).toEqual([a.id, b.id, c.id]);
  });

  it('without the bridge, the two dissimilar tabs stay apart', () => {
    nextId = 1;
    const a = etab('maple birch cedar', 'https://example.com/t1');
    const c = etab('willow poplar juniper', 'https://example.com/t3');
    expect(tsScorer.clusterTabs([a, c])).toEqual([]);
  });
});

describe('near-identical and unicode titles', () => {
  it('titles differing by exactly one token cluster together', () => {
    nextId = 1;
    const tabs = [
      etab('release notes january', 'https://example.com/rn-jan'),
      etab('release notes february', 'https://example.com/rn-feb'),
    ];
    const clusters = tsScorer.clusterTabs(tabs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].tabIds).toEqual([tabs[0].id, tabs[1].id]);
  });

  it('emoji in titles are inert: the words still carry the cluster', () => {
    nextId = 1;
    const tabs = [
      etab('🚀 launch plan', 'https://example.com/lp'),
      etab('🚀 launch checklist', 'https://example.com/lc'),
    ];
    expect(tsScorer.clusterTabs(tabs)).toHaveLength(1);
  });

  it.fails(
    'D9: two tabs with byte-identical CJK titles on one host cluster together',
    () => {
      nextId = 1;
      const tabs = [
        etab('四半期ごとの計画メモ', 'https://docs.google.com/document/d/J1/edit'),
        etab('四半期ごとの計画メモ', 'https://docs.google.com/document/d/J2/edit'),
      ];
      const clusters = tsScorer.clusterTabs(tabs);
      expect(clusters).toHaveLength(1);
    },
  );

  it.fails(
    'D9: CJK titles that share most of their text cluster together',
    () => {
      nextId = 1;
      const tabs = [
        etab('旅行の日程と予算', 'https://example.com/trip-a'),
        etab('旅行の日程と予約', 'https://example.com/trip-b'),
      ];
      expect(tsScorer.clusterTabs(tabs)).toHaveLength(1);
    },
  );

  it('localized platform suffixes are NOT stripped (only the known platform names are) — French Docs titles keep their suffix token', () => {
    nextId = 1;
    // 'Google Documents' is not in PLATFORM_NAMES, so the suffix
    // survives cleaning and becomes a shared token — the pair
    // still clusters (here it helps; the characterization is that
    // suffix handling is a fixed list, not a pattern).
    const tabs = [
      etab('Rapport hebdomadaire - Google Documents', 'https://docs.google.com/document/d/F1/edit'),
      etab('Rapport mensuel - Google Documents', 'https://docs.google.com/document/d/F2/edit'),
    ];
    expect(tsScorer.clusterTabs(tabs)).toHaveLength(1);
  });
});

describe('mega-clusters and the split threshold', () => {
  function falconTabs(n: number): EngineTab[] {
    nextId = 1;
    return Array.from({ length: n }, (_, i) =>
      etab(
        `project falcon update ${i}`,
        `https://docs.google.com/document/d/FAL${i}/edit`,
      ),
    );
  }

  it('on the heuristics rung a 12-tab platform cluster is capped at the split size (8)', () => {
    const drafts = build(falconTabs(12), 'heuristics');
    const groups = drafts.filter((d) => d.kind === 'new-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].tabIds).toHaveLength(8);
  });

  it('on the nano rung the full 12 go to the judge as one draft', () => {
    const drafts = build(falconTabs(12), 'nano');
    const groups = drafts.filter((d) => d.kind === 'new-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].tabIds).toHaveLength(12);
  });

  it('the cap is platform-scoped: a 12-tab generic-host cluster is NOT capped', () => {
    nextId = 1;
    const tabs = Array.from({ length: 12 }, (_, i) =>
      etab(`project falcon update ${i}`, `https://example.com/f${i}`),
    );
    const drafts = build(tabs, 'heuristics');
    const groups = drafts.filter((d) => d.kind === 'new-group');
    expect(groups).toHaveLength(1);
    expect(groups[0].tabIds).toHaveLength(12);
  });

  it('needsSplitEvaluation: size boundary is >8, not ≥8', () => {
    const mk = (n: number, name: string | null = 'Falcon'): SuggestionDraft => {
      const tabs = falconTabs(n);
      return {
        kind: 'new-group',
        windowId: 1,
        tabIds: tabs.map((t) => t.id),
        tabs,
        targetGroupKey: null,
        targetGroupName: null,
        proposedName: name,
        confidence: 0.8,
        source: 'heuristics',
        nanoFallback: false,
      };
    };
    expect(needsSplitEvaluation(mk(8))).toBe(false);
    expect(needsSplitEvaluation(mk(9))).toBe(true);
  });

  it('needsSplitEvaluation: name-token coverage of exactly 60% passes; below it forces a split', () => {
    const mkDraft = (titles: string[]): SuggestionDraft => {
      nextId = 1;
      const tabs = titles.map((title, i) =>
        etab(title, `https://example.com/x${i}`),
      );
      return {
        kind: 'new-group',
        windowId: 1,
        tabIds: tabs.map((t) => t.id),
        tabs,
        targetGroupKey: null,
        targetGroupName: null,
        proposedName: 'Report',
        confidence: 0.8,
        source: 'heuristics',
        nanoFallback: false,
      };
    };
    // 'report' in 3 of 5 titles = 0.6 — not below the line.
    expect(
      needsSplitEvaluation(
        mkDraft(['report a', 'report b', 'report c', 'other d', 'other e']),
      ),
    ).toBe(false);
    // 2 of 5 = 0.4 — the name is a minority theme: split.
    expect(
      needsSplitEvaluation(
        mkDraft(['report a', 'report b', 'other c', 'other d', 'other e']),
      ),
    ).toBe(true);
  });

  it('needsSplitEvaluation: low cohesion on a multi-doc host forces a split; the same shape elsewhere does not', () => {
    const mkDraft = (host: string): SuggestionDraft => {
      nextId = 1;
      const tabs = ['aa bb', 'cc dd', 'ee ff'].map((title, i) =>
        etab(title, `https://${host}/d${i}`),
      );
      return {
        kind: 'new-group',
        windowId: 1,
        tabIds: tabs.map((t) => t.id),
        tabs,
        targetGroupKey: null,
        targetGroupName: null,
        proposedName: null,
        confidence: 0.5,
        source: 'heuristics',
        nanoFallback: false,
      };
    };
    expect(needsSplitEvaluation(mkDraft('docs.google.com'))).toBe(true);
    expect(needsSplitEvaluation(mkDraft('example.com'))).toBe(false);
  });

  it('needsSplitEvaluation never fires for add-to-group drafts', () => {
    const tabs = falconTabs(12);
    const draft: SuggestionDraft = {
      kind: 'add-to-group',
      windowId: 1,
      tabIds: tabs.map((t) => t.id),
      tabs,
      targetGroupKey: 'ts:g1',
      targetGroupName: 'G',
      proposedName: null,
      confidence: 0.9,
      source: 'heuristics',
      nanoFallback: false,
    };
    expect(needsSplitEvaluation(draft)).toBe(false);
  });
});

describe('inbox discipline', () => {
  it('the per-window cap holds at 10 even with 12 clusterable topics', () => {
    nextId = 1;
    const tabs: EngineTab[] = [];
    for (let p = 0; p < 12; p++) {
      tabs.push(etab(`topic${p} alpha beta`, `https://host${p}.example/a`));
      tabs.push(etab(`topic${p} alpha gamma`, `https://host${p}.example/b`));
    }
    const drafts = build(tabs);
    expect(drafts).toHaveLength(10);
  });

  it('a dismissed draft does not re-form; a different name for the same tabs is a different dismissal', () => {
    nextId = 1;
    const tabs = [
      etab('camping menu plans', 'https://example.com/c1'),
      etab('camping gear plans', 'https://example.com/c2'),
    ];
    const first = build(tabs);
    expect(first).toHaveLength(1);
    const d = first[0];
    const sig = dismissalSignature(
      d.kind,
      d.tabIds,
      `name:${(d.proposedName ?? '').toLowerCase()}`,
    );
    expect(build(tabs, 'heuristics', { dismissed: [{ signature: sig, at: 1 }] })).toEqual([]);
    const otherSig = dismissalSignature(d.kind, d.tabIds, 'name:something-else');
    expect(
      build(tabs, 'heuristics', { dismissed: [{ signature: otherSig, at: 1 }] }),
    ).toHaveLength(1);
  });

  it('property: across generated inputs, no tab appears in two drafts of the same window', () => {
    const rand = rng(4242);
    const topics = ['falcon', 'harbor', 'meadow', 'summit', 'willow', 'cobalt'];
    for (let trial = 0; trial < 25; trial++) {
      nextId = 1;
      const tabs: EngineTab[] = [];
      const n = rand.range(6, 40);
      for (let i = 0; i < n; i++) {
        const topic = rand.pick(topics);
        const host = rand.pick(['example.com', 'docs.google.com', 'news.example.org']);
        tabs.push(
          etab(
            `${topic} ${rand.pick(['alpha', 'beta', 'gamma', 'delta'])} ${rand.pick(['notes', 'plan', 'list', 'memo'])}`,
            `https://${host}/p${i}`,
            {
              windowId: rand.pick([1, 2]),
              pinned: rand.bool(0.1),
              excluded: rand.bool(0.05),
              groupId: rand.bool(0.1) ? 5 : -1,
            },
          ),
        );
      }
      for (const rung of ['heuristics', 'domain-only'] as const) {
        const drafts = build(tabs, rung);
        const seen = new Map<string, number>();
        for (const d of drafts) {
          for (const id of d.tabIds) {
            const key = `${d.windowId}:${id}`;
            expect(seen.has(key), `tab ${id} in two drafts (trial ${trial}, ${rung})`).toBe(false);
            seen.set(key, 1);
          }
        }
      }
    }
  });
});

describe('hands-off matrix — under every rung', () => {
  function pair(extra: Partial<EngineTab>): EngineTab[] {
    nextId = 1;
    return [
      etab('camping menu plans', 'https://example.com/c1', extra),
      etab('camping gear plans', 'https://example.com/c2', extra),
    ];
  }
  const variants: Array<[string, Partial<EngineTab>]> = [
    ['pinned', { pinned: true }],
    ['already grouped', { groupId: 77 }],
    ['excluded', { excluded: true }],
  ];
  for (const rung of ['heuristics', 'domain-only', 'nano', 'paused'] as const) {
    for (const [name, extra] of variants) {
      it(`${rung}: ${name} tabs are never drafted`, () => {
        expect(build(pair(extra), rung)).toEqual([]);
      });
    }
    it(`${rung}: blocklisted tabs are never drafted`, () => {
      expect(
        build(pair({}), rung, { blocklist: ['example.com'] }),
      ).toEqual([]);
    });
  }

  it('paused produces nothing even for a perfect cluster', () => {
    expect(build(pair({}), 'paused')).toEqual([]);
  });

  it('domain-only: a multi-doc platform bucket gets NO draft (the Darwin failure shape), a generic bucket does', () => {
    nextId = 1;
    const docs = [1, 2, 3].map((i) =>
      etab(`random title ${i}`, `https://docs.google.com/document/d/X${i}/edit`),
    );
    expect(build(docs, 'domain-only')).toEqual([]);
    nextId = 1;
    const generic = [1, 2, 3].map((i) =>
      etab(`random title ${i}`, `https://example.com/p${i}`),
    );
    const drafts = build(generic, 'domain-only');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].proposedName).toBe('Example');
    expect(drafts[0].source).toBe('domain-only');
  });
});

describe('scorer parity — TS vs Wasm partitions over generated tab sets', () => {
  it('identical partitions and name seeds on 40 generated sets', () => {
    const rand = rng(20261011);
    const topics = ['falcon', 'harbor', 'meadow', 'summit'];
    const words = ['alpha', 'beta', 'gamma', 'delta', 'notes', 'plan'];
    const hosts = ['example.com', 'docs.google.com', 'blog.example.net'];
    for (let trial = 0; trial < 40; trial++) {
      const tabs: ScorerTabInput[] = [];
      const n = rand.range(4, 24);
      for (let i = 0; i < n; i++) {
        const host = rand.pick(hosts);
        const topic = rand.pick(topics);
        const title = rand.bool(0.7)
          ? `${topic} ${rand.pick(words)} ${rand.pick(words)}`
          : `${rand.pick(words)} ${rand.pick(words)} ${rand.pick(words)}`;
        tabs.push({
          id: i + 1,
          title,
          url: `https://${host}/doc${i}`,
          exactKey: `k${i}`,
          fuzzyKey: rand.bool(0.3) ? `shared${topic}` : `k${i}`,
        });
      }
      const ts = tsScorer.clusterTabs(tabs);
      const wasm = wasmScorer.clusterTabs(tabs);
      const shape = (cs: typeof ts) =>
        cs
          .map((c) => [...c.tabIds].sort((a, b) => a - b).join(','))
          .sort();
      expect(shape(wasm), `trial ${trial}`).toEqual(shape(ts));
      const seeds = (cs: typeof ts) =>
        cs.map((c) => c.nameSeed).sort();
      expect(seeds(wasm), `trial ${trial} seeds`).toEqual(seeds(ts));
      for (let i = 0; i < ts.length; i++) {
        const match = wasm.find(
          (c) => c.tabIds.join(',') === ts[i].tabIds.join(','),
        );
        expect(match).toBeDefined();
        expect(Math.abs((match?.cohesion ?? 0) - ts[i].cohesion)).toBeLessThan(1e-6);
      }
    }
  });
});
