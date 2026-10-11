/**
 * Pure budget comparators for the perf harness — kept separate from
 * the scenarios so the gate logic itself is unit-testable without a
 * browser (tests/perf-gates.test.mjs).
 *
 * Everything here is a pure function of budget entries (as loaded
 * from perf-budgets.json) and measured values. Scenarios own browser
 * interaction and gate-entry formatting; this module owns verdicts.
 */

import { median, p95 } from './stats.mjs';

/**
 * Compare one measured value against a budget entry, honouring the
 * entry's comparison operator. Null/non-finite measurements never
 * pass (a missing measurement is a failure, not a pass).
 */
export function compareBudget(budgetEntry, measured) {
  if (!budgetEntry) return false;
  if (typeof measured !== 'number' || !Number.isFinite(measured)) return false;
  switch (budgetEntry.comparison) {
    case '<':
      return measured < budgetEntry.budget;
    case '<=':
      return measured <= budgetEntry.budget;
    case '=':
      return measured === budgetEntry.budget;
    case '>':
      return measured > budgetEntry.budget;
    case '>=':
      return measured >= budgetEntry.budget;
    default:
      return false;
  }
}

/**
 * Median across harness rounds (M3 ratification, 2026-10-11): the
 * gated statistic for the added-latency budgets. Null rounds (a
 * profile that produced no statistic) are ignored; if every round
 * is null the result is null and the gate fails via compareBudget.
 */
export function medianOfRounds(values) {
  return median(values.filter((v) => typeof v === 'number' && Number.isFinite(v)));
}

/**
 * Pooled-percentile delta for the THROTTLED p95 gate (M3 gate
 * follow-up, user decision 2026-10-11 — the one red row of PR #2's
 * ratification run). Median-of-rounds could not rescue that
 * statistic: each round's p95 delta is a difference of two tail
 * order statistics over ~39 samples under 4x CPU throttling, and
 * three of PR #2's five rounds drew > +100 ms, so the median
 * inherited the noise (per-round deltas -116.21, +203.64, +107.91,
 * +5.11, +101.07 ms; median-of-rounds 101.07 ms vs the <25 ms
 * budget, while the throttled median delta gated at -5.54 ms).
 *
 * Instead, the raw per-sample durations of every round are pooled
 * per condition (extension-on samples together, extension-off
 * samples together), one p95 is computed per pool (~195 samples
 * at 5 rounds instead of ~39), and the gate is the difference of
 * the two pooled p95s against the unchanged <25 ms budget. No
 * extra rounds are collected — this reuses the samples the
 * harness already records.
 *
 * `onRoundSamples` / `offRoundSamples` are arrays of per-round
 * sample arrays. Non-finite samples are ignored. An empty pool
 * yields a null p95 (and a null delta), which fails the gate via
 * compareBudget — a missing measurement is a failure, not a pass.
 */
export function pooledP95Delta(onRoundSamples, offRoundSamples) {
  const pool = (rounds) =>
    (rounds ?? []).flat().filter((v) => typeof v === 'number' && Number.isFinite(v));
  const on = pool(onRoundSamples);
  const off = pool(offRoundSamples);
  const onP95 = p95(on);
  const offP95 = p95(off);
  return {
    onCount: on.length,
    offCount: off.length,
    onP95,
    offP95,
    delta: onP95 !== null && offP95 !== null ? onP95 - offP95 : null,
  };
}

/**
 * The ratified churn checks (perf-budgets.json v2, 2026-10-11):
 * two explicit bounds replace the former "~zero slope" wording —
 * total growth over the cycles < memory-growth-5000-cycles-total
 * (MB) and least-squares leak slope <=
 * memory-growth-5000-cycles-slope (KB/cycle). `budgets` is the Map
 * of budget id -> entry built by the harness orchestrator. Returns
 * one check object per ratified bound, with measured values already
 * expressed in each entry's unit.
 */
export function churnChecks({ slopeKBPerCycle, totalGrowthMB }, budgets) {
  const slopeEntry = budgets.get('memory-growth-5000-cycles-slope');
  const totalEntry = budgets.get('memory-growth-5000-cycles-total');
  if (!slopeEntry || !totalEntry) {
    throw new Error(
      'perf-budgets.json is missing the ratified churn entries ' +
        '(memory-growth-5000-cycles-slope / -total)',
    );
  }
  return [
    {
      budgetId: slopeEntry.id,
      label: 'Leak slope (least squares, post warm-up)',
      measured: slopeKBPerCycle,
      unit: slopeEntry.unit,
      pass: compareBudget(slopeEntry, slopeKBPerCycle),
    },
    {
      budgetId: totalEntry.id,
      label: 'Total heap growth over cycles',
      measured: totalGrowthMB,
      unit: totalEntry.unit,
      pass: compareBudget(totalEntry, totalGrowthMB),
    },
  ];
}
