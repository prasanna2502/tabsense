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
import { churnChecks, compareBudget, medianOfRounds } from '../scripts/perf/gates.mjs';
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
