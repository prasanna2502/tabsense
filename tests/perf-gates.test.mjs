/**
 * M3 gate-ratification unit tests (2026-10-11): the pure verdict
 * logic of the perf harness (scripts/perf/gates.mjs) — budget
 * comparison operators, the median-of-rounds latency statistic, and
 * the ratified two-bound churn check. These exercise the exact
 * functions the CDP harness gates with; the browser scenarios
 * themselves are covered by the CI perf gate.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs harness module, no type declarations
import {
  abbaQuartetDeltas,
  churnChecks,
  compareBudget,
  medianOfRounds,
  pairedBlockMedianDelta,
  pooledP95Delta,
} from '../scripts/perf/gates.mjs';
// @ts-expect-error — plain .mjs harness module, no type declarations
import { p95 } from '../scripts/perf/stats.mjs';
// @ts-expect-error — plain .mjs harness module, no type declarations
import budgetsFile from '../perf-budgets.json' with { type: 'json' };

const budgetMap = new Map(budgetsFile.budgets.map((b) => [b.id, b]));
const entry = (id) => {
  const e = budgetMap.get(id);
  if (!e) throw new Error(`budget ${id} missing from perf-budgets.json`);
  return e;
};

describe('compareBudget — comparison operators', () => {
  it('"<" is strict', () => {
    const e = { budget: 10, comparison: '<' };
    expect(compareBudget(e, 9.999)).toBe(true);
    expect(compareBudget(e, 10)).toBe(false);
    expect(compareBudget(e, 10.351)).toBe(false);
  });

  it('"<=" admits the boundary (the ratified slope bound)', () => {
    const e = entry('memory-growth-5000-cycles-slope');
    expect(e.budget).toBe(0.03);
    expect(compareBudget(e, 0.03)).toBe(true);
    expect(compareBudget(e, 0.031)).toBe(false);
  });

  it('"=" requires exact equality', () => {
    const e = { budget: 0, comparison: '=' };
    expect(compareBudget(e, 0)).toBe(true);
    expect(compareBudget(e, 1)).toBe(false);
  });

  it('null / NaN / missing measurements never pass', () => {
    const e = { budget: 10, comparison: '<' };
    expect(compareBudget(e, null)).toBe(false);
    expect(compareBudget(e, Number.NaN)).toBe(false);
    expect(compareBudget(e, undefined)).toBe(false);
    expect(compareBudget(undefined, 1)).toBe(false);
  });

  it('unknown comparison operators never pass', () => {
    expect(compareBudget({ budget: 1, comparison: '~' }, 0)).toBe(false);
  });
});

describe('medianOfRounds — the ratified latency statistic', () => {
  it('takes the middle round, so one noise spike cannot fail the gate', () => {
    // Throttled p95 history: +97.5, +92.3 (fails), -43 (pass) on
    // equivalent code — the median of a 5-round set is the verdict.
    expect(medianOfRounds([97.5, 92.3, -43, 12, 8])).toBe(12);
    expect(medianOfRounds([97.5, 92.3, -43, 88, 91])).toBe(91);
  });

  it('averages the two middle values for an even count', () => {
    expect(medianOfRounds([0, 10, 20, 30])).toBe(15);
  });

  it('ignores null rounds; all-null yields null (gate fails)', () => {
    expect(medianOfRounds([null, 5, null, 9, 7])).toBe(7);
    expect(medianOfRounds([null, null])).toBeNull();
    expect(medianOfRounds([])).toBeNull();
  });
});

describe('pooledP95Delta — throttled p95 statistic (M3 gate follow-up, 2026-10-11)', () => {
  it('pools samples across rounds and takes one p95 per condition', () => {
    // Pooled on = [10,20,30,40,50] (n=5, nearest-rank p95 = max = 50);
    // pooled off = [5,15,25,35,45] (p95 = 45).
    const r = pooledP95Delta(
      [
        [10, 20, 30],
        [40, 50],
      ],
      [
        [5, 15, 25],
        [35, 45],
      ],
    );
    expect(r).toEqual({ onCount: 5, offCount: 5, onP95: 50, offP95: 45, delta: 5 });
  });

  it('uses the harness percentile convention on the pooled set (nearest-rank)', () => {
    const on = [
      [3, 1, 4],
      [1, 5, 9, 2, 6],
    ];
    const off = [[8, 8], [8, 8, 8, 8, 8, 8, 8]];
    const r = pooledP95Delta(on, off);
    expect(r.onP95).toBe(p95(on.flat()));
    expect(r.offP95).toBe(p95(off.flat()));
    expect(r.onCount).toBe(8);
    expect(r.offCount).toBe(9);
  });

  it('is not the median of per-round p95 deltas (the statistic it replaces)', () => {
    // Two rounds whose per-round p95 deltas are +110 and +10 ms
    // (median-of-rounds: 60 ms). Pooling the raw samples weighs the
    // tail by all 8 samples per condition instead: pooled p95s are
    // 200 (on) and 190 (off) — a 10 ms delta.
    const on = [
      [100, 100, 100, 200],
      [100, 100, 100, 200],
    ];
    const off = [
      [90, 90, 90, 90],
      [90, 90, 90, 190],
    ];
    const perRoundDeltas = on.map((round, i) => p95(round) - p95(off[i]));
    expect(perRoundDeltas).toEqual([110, 10]);
    expect(medianOfRounds(perRoundDeltas)).toBe(60);
    const r = pooledP95Delta(on, off);
    expect(r).toMatchObject({ onCount: 8, offCount: 8, onP95: 200, offP95: 190, delta: 10 });
  });

  it('delta is negative when the extension pool is faster', () => {
    const r = pooledP95Delta([[50, 60]], [[100, 110]]);
    expect(r.onP95).toBe(60);
    expect(r.offP95).toBe(110);
    expect(r.delta).toBe(-50);
  });

  it('a single sample per pool still produces a delta', () => {
    expect(pooledP95Delta([[42]], [[40]])).toEqual({
      onCount: 1,
      offCount: 1,
      onP95: 42,
      offP95: 40,
      delta: 2,
    });
  });

  it('empty pools yield nulls (the gate then fails via compareBudget)', () => {
    expect(pooledP95Delta([], [])).toEqual({
      onCount: 0,
      offCount: 0,
      onP95: null,
      offP95: null,
      delta: null,
    });
    expect(pooledP95Delta([[], []], [[1, 2]])).toMatchObject({ onCount: 0, onP95: null, delta: null });
    expect(pooledP95Delta([[1, 2]], [])).toMatchObject({ offCount: 0, offP95: null, delta: null });
  });

  it('ignores non-finite samples instead of poisoning the pool', () => {
    const r = pooledP95Delta([[Number.NaN, 10, Number.POSITIVE_INFINITY, 20]], [[5]]);
    expect(r.onCount).toBe(2);
    expect(r.onP95).toBe(20);
    expect(r.delta).toBe(15);
  });
});

describe('pairedBlockMedianDelta — interleaved ABBA statistic (M3 gate design change, 2026-10-11)', () => {
  const blk = (condition, medianMs) => ({ condition, medianMs });
  // One well-formed ABBA round: off medians 100/110 (mean 105),
  // on medians 130/140 (mean 135) — a +30 ms paired delta.
  const abbaRound = [blk('off', 100), blk('on', 130), blk('on', 140), blk('off', 110)];

  it('pairs the inner on-blocks against the surrounding off-blocks of each quartet', () => {
    const r = abbaQuartetDeltas(abbaRound);
    expect(r.droppedBlocks).toBe(0);
    expect(r.quartets).toEqual([{ on: 135, off: 105, delta: 30 }]);
    expect(r.diffsMs).toEqual([30]);
  });

  it('a mirrored BAAB quartet still reports on minus off', () => {
    const r = abbaQuartetDeltas([blk('on', 200), blk('off', 150), blk('off', 170), blk('on', 220)]);
    // on mean = (200+220)/2 = 210; off mean = (150+170)/2 = 160.
    expect(r.quartets).toEqual([{ on: 210, off: 160, delta: 50 }]);
  });

  it('cancels linear drift that defeats the sequential block design (crafted series)', () => {
    // True effect: extension adds exactly +20 ms (off base 100, on
    // base 120). The runner drifts linearly: +10 ms per block across
    // the whole run (+70 ms end to end).
    const interleaved = [
      blk('off', 100), blk('on', 130), blk('on', 140), blk('off', 130),
      blk('off', 140), blk('on', 170), blk('on', 180), blk('off', 170),
    ];
    // Quartet centroids coincide, so each paired delta is the true
    // +20 despite the drift, and the gated median is exact.
    expect(abbaQuartetDeltas(interleaved).diffsMs).toEqual([20, 20]);
    expect(pairedBlockMedianDelta([interleaved]).delta).toBe(20);
    // The same samples in the OLD sequential arrangement (all off
    // blocks first, then all on blocks, drift +10/sample-position)
    // reads +60: offs 100..130 (median 115), ons 160..190
    // (median 175). The design, not the statistic, was the flaw.
    const sequentialOff = [100, 110, 120, 130];
    const sequentialOn = [160, 170, 180, 190];
    expect(medianOfRounds(sequentialOn) - medianOfRounds(sequentialOff)).toBe(60);
  });

  it('gates on the median of the paired differences pooled across rounds', () => {
    const slow = [blk('off', 100), blk('on', 190), blk('on', 200), blk('off', 110)]; // +90
    const fast = [blk('off', 100), blk('on', 80), blk('on', 90), blk('off', 110)]; // -20
    const r = pairedBlockMedianDelta([abbaRound, slow, fast]);
    expect(r.pairCount).toBe(3);
    expect(r.diffsMs).toEqual([30, 90, -20]);
    expect(r.delta).toBe(30);
  });

  it('averages the two middle differences for an even pair count', () => {
    const neg = [blk('off', 130), blk('on', 100), blk('on', 110), blk('off', 120)]; // -20
    const r = pairedBlockMedianDelta([abbaRound, neg]);
    expect(r.diffsMs).toEqual([30, -20]);
    expect(r.delta).toBe(5);
  });

  it('delta is negative when the extension blocks are faster', () => {
    const r = pairedBlockMedianDelta([[blk('off', 200), blk('on', 150), blk('on', 160), blk('off', 210)]]);
    expect(r.delta).toBe(-50);
  });

  it('drops incomplete trailing blocks instead of pairing across the gap', () => {
    const withTail = [...abbaRound, blk('off', 100), blk('on', 130)];
    const r = abbaQuartetDeltas(withTail);
    expect(r.quartets).toHaveLength(1);
    expect(r.droppedBlocks).toBe(2);
  });

  it('drops quartets with a missing median or a non-ABBA pattern, and counts them', () => {
    const missing = [blk('off', 100), blk('on', null), blk('on', 140), blk('off', 110)];
    const wrongPattern = [blk('off', 100), blk('on', 130), blk('off', 105), blk('on', 135)];
    const unknownCondition = [blk('off', 100), blk('warm', 130), blk('warm', 140), blk('off', 110)];
    for (const bad of [missing, wrongPattern, unknownCondition]) {
      const r = abbaQuartetDeltas(bad);
      expect(r.quartets).toEqual([]);
      expect(r.droppedBlocks).toBe(4);
    }
  });

  it('quartets never span rounds', () => {
    // Two half-quartets in different rounds must not combine.
    const r = pairedBlockMedianDelta([
      [blk('off', 100), blk('on', 130)],
      [blk('on', 140), blk('off', 110)],
    ]);
    expect(r.pairCount).toBe(0);
    expect(r.droppedBlocks).toBe(4);
    expect(r.delta).toBeNull();
  });

  it('empty input yields a null delta (the gate then fails via compareBudget)', () => {
    expect(pairedBlockMedianDelta([])).toEqual({ pairCount: 0, droppedBlocks: 0, diffsMs: [], delta: null });
    expect(pairedBlockMedianDelta([[], []])).toMatchObject({ pairCount: 0, delta: null });
    expect(compareBudget(entry('tab-open-added-latency-median'), pairedBlockMedianDelta([]).delta)).toBe(false);
  });
});

describe('churnChecks — ratified two-bound churn gate (perf-budgets.json v2)', () => {
  it('the budgets file carries the two explicit entries and no "~" entry', () => {
    expect(entry('memory-growth-5000-cycles-total')).toMatchObject({
      budget: 2,
      comparison: '<',
      unit: 'MB',
    });
    expect(entry('memory-growth-5000-cycles-slope')).toMatchObject({
      budget: 0.03,
      comparison: '<=',
      unit: 'KB/cycle',
    });
    expect(budgetMap.has('memory-growth-5000-cycles')).toBe(false);
    expect(budgetsFile.budgets.every((b) => b.comparison !== '~')).toBe(true);
  });

  it('passes the observed CI/local values the ratification was calibrated on', () => {
    // Worst observed: slope 0.011 KB/cycle (CI) / ~0.015 (local);
    // total growth ~60 KB (CI) / +93 KB (local).
    const ci = churnChecks({ slopeKBPerCycle: 0.011, totalGrowthMB: 60 / 1024 }, budgetMap);
    expect(ci.map((c) => c.pass)).toEqual([true, true]);
    const local = churnChecks({ slopeKBPerCycle: 0.015, totalGrowthMB: 93 / 1024 }, budgetMap);
    expect(local.map((c) => c.pass)).toEqual([true, true]);
  });

  it('fails a real leak on either bound independently', () => {
    const slopeLeak = churnChecks({ slopeKBPerCycle: 0.5, totalGrowthMB: 0.1 }, budgetMap);
    expect(slopeLeak[0].pass).toBe(false);
    expect(slopeLeak[1].pass).toBe(true);
    const totalLeak = churnChecks({ slopeKBPerCycle: 0.01, totalGrowthMB: 2.5 }, budgetMap);
    expect(totalLeak[0].pass).toBe(true);
    expect(totalLeak[1].pass).toBe(false);
  });

  it('reports measured values in each entry\u2019s own unit', () => {
    const checks = churnChecks({ slopeKBPerCycle: 0.011, totalGrowthMB: 0.059 }, budgetMap);
    expect(checks[0]).toMatchObject({ budgetId: 'memory-growth-5000-cycles-slope', unit: 'KB/cycle', measured: 0.011 });
    expect(checks[1]).toMatchObject({ budgetId: 'memory-growth-5000-cycles-total', unit: 'MB', measured: 0.059 });
  });

  it('a missing measurement fails rather than passes', () => {
    const checks = churnChecks({ slopeKBPerCycle: null, totalGrowthMB: null }, budgetMap);
    expect(checks.map((c) => c.pass)).toEqual([false, false]);
  });

  it('throws if the ratified entries are absent from the budgets map', () => {
    expect(() => churnChecks({ slopeKBPerCycle: 0.01, totalGrowthMB: 0.1 }, new Map())).toThrow(
      /ratified churn entries/,
    );
  });
});
