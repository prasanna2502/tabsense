#!/usr/bin/env node
/**
 * Perf harness — M0 STUB.
 *
 * Today it only loads perf-budgets.json and prints the budgets, proving
 * the plumbing (budgets-as-code) exists. The real harness — Chrome for
 * Testing driven via CDP, extension-on vs extension-off baselines,
 * memory/leak/storm suites per proposal §10.3 — lands in stages through
 * M1–M3, and this file is where it will live.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const budgetsPath = join(root, 'perf-budgets.json');
const parsed = JSON.parse(readFileSync(budgetsPath, 'utf8'));

if (!Array.isArray(parsed.budgets) || parsed.budgets.length === 0) {
  console.error(`No budgets found in ${budgetsPath}`);
  process.exit(1);
}

console.log(`Perf budgets (v${parsed.version}) from perf-budgets.json:`);
for (const b of parsed.budgets) {
  console.log(`  - [${b.id}] ${b.metric}: ${b.comparison} ${b.budget} ${b.unit}`);
}
console.log(
  `\n${parsed.budgets.length} budgets loaded. Harness is a stub at M0 — no measurements taken yet.`,
);
