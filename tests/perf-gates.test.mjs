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
import { churnChecks, compareBudget, medianOfRounds, pooledP95Delta } from '../scripts/perf/gates.mjs';
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
