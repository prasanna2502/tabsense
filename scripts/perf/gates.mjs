/**
 * Pure budget comparators for the perf harness — kept separate from
 * the scenarios so the gate logic itself is unit-testable without a
 * browser (tests/perf-gates.test.mjs).
 *
 * Everything here is a pure function of budget entries (as loaded
 * from perf-budgets.json) and measured values. Scenarios own browser
 * interaction and gate-entry formatting; this module owns verdicts.
 */

import { median } from './stats.mjs';

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
