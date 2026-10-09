#!/usr/bin/env node
/**
 * Benchmark-Lite runner (M2 exit criterion).
 *
 * Runs the grouping pipeline end-to-end over the labeled corpus in
 * sessions.json and reports grouping quality (pairwise + BCubed
 * precision/recall/F1) and clicks-to-organized (a simulated user
 * working the suggestion inbox, vs the manual drag-every-tab
 * baseline).
 *
 * Engine notes — read before quoting numbers:
 *  - The pipeline under test is the production suggestion engine
 *    (src/lib/suggestions.ts) with the TypeScript scorer, which is
 *    fixture-locked to the Rust core (1e-6) — the same code the
 *    extension runs, on the heuristics rung.
 *  - Gemini Nano does NOT run here: it is unavailable in CI and in
 *    this sandbox. These are heuristics-only numbers — the honest
 *    floor the Nano judge and M4 learning are expected to raise.
 *  - Canonical keys come from the production TS canonicalizer, so
 *    doc-family signals are the real ones.
 *
 * Run: npm run bench   (compiles the pipeline libs to .build/ first)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 1. Compile the pipeline libraries (plain tsc; the libs are
//    chrome-free by design so they run in Node unchanged).
execFileSync(
  join(root, 'node_modules', '.bin', 'tsc'),
  [
    join(root, 'src/lib/scorer.ts'),
    join(root, 'src/lib/blocklist.ts'),
    join(root, 'src/lib/groups.ts'),
    join(root, 'src/lib/breaker.ts'),
    join(root, 'src/lib/nano.ts'),
    join(root, 'src/lib/suggestions.ts'),
    join(root, 'src/lib/canonicalize.ts'),
    '--module', 'commonjs',
    '--target', 'es2022',
    '--moduleResolution', 'node',
    '--skipLibCheck',
    '--outDir', join(here, '.build'),
  ],
  { stdio: 'inherit' },
);

// The repo is ESM ("type": "module"); the tsc output is CommonJS.
writeFileSync(join(here, '.build', 'package.json'), '{"type":"commonjs"}\n');

const require = createRequire(import.meta.url);
const { buildSuggestions } = require('./.build/suggestions.js');
const { tsScorer } = require('./.build/scorer.js');
const { DEFAULT_BLOCKLIST } = require('./.build/blocklist.js');
const { canonicalKeysFallback } = require('./.build/canonicalize.js');

const corpus = JSON.parse(readFileSync(join(here, 'sessions.json'), 'utf8'));

// -------------------------------------------------------------------
// Metrics
// -------------------------------------------------------------------

function pairwise(predicted, truth, n) {
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sameP = predicted[i] !== null && predicted[i] === predicted[j];
      const sameT = truth[i] !== null && truth[i] === truth[j];
      if (sameP && sameT) tp++;
      else if (sameP) fp++;
      else if (sameT) fn++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn };
}

function bcubed(predicted, truth, n) {
  let sumP = 0, sumR = 0;
  for (let i = 0; i < n; i++) {
    const predCluster = predicted[i] === null
      ? [i]
      : predicted.map((c, j) => (c === predicted[i] ? j : -1)).filter((j) => j >= 0);
    const truthCluster = truth[i] === null
      ? [i]
      : truth.map((c, j) => (c === truth[i] ? j : -1)).filter((j) => j >= 0);
    const both = predCluster.filter((j) => truthCluster.includes(j)).length;
    sumP += both / predCluster.length;
    sumR += both / truthCluster.length;
  }
  const precision = sumP / n;
  const recall = sumR / n;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Simulated user working the inbox:
 *  - suggestion fully inside one expected group → accept (1 click),
 *    plus 1 click per wrong tab toggled off when it is mixed;
 *    if fewer than 2 correct tabs remain after toggles → dismiss (1).
 *  - suggestion whose tabs are all expected-ungrouped → dismiss (1).
 *  - expected-group tabs still ungrouped afterwards → 1 manual
 *    filing action each.
 * Manual baseline: for each expected group, 1 click to create it +
 * 1 drag per member tab.
 */
function simulateClicks(drafts, truth, n) {
  let clicks = 0;
  const grouped = new Array(n).fill(false);
  for (const draft of drafts) {
    const byTruth = new Map();
    for (const id of draft.tabIds) {
      const key = truth[id] === null ? `single:${id}` : truth[id];
      byTruth.set(key, [...(byTruth.get(key) ?? []), id]);
    }
    const [bestKey, bestTabs] = [...byTruth.entries()].sort(
      (a, b) => b[1].length - a[1].length,
    )[0];
    const wrong = draft.tabIds.length - bestTabs.length;
    if (truth[bestTabs[0]] === null || bestTabs.length < 2) {
      clicks += 1; // dismiss
      continue;
    }
    clicks += wrong; // toggle off wrong tabs
    clicks += 1; // accept
    for (const id of bestTabs) grouped[id] = true;
  }
  let remaining = 0;
  for (let i = 0; i < n; i++) {
    if (truth[i] !== null && !grouped[i]) remaining++;
  }
  clicks += remaining; // manual filing for whatever was missed
  let manual = 0;
  const groups = new Set(truth.filter((t) => t !== null));
  for (const g of groups) {
    manual += 1 + truth.filter((t) => t === g).length;
  }
  return { clicks, manual };
}

// -------------------------------------------------------------------
// Run
// -------------------------------------------------------------------

const sessionResults = [];
for (const session of corpus.sessions) {
  const n = session.tabs.length;
  const engineTabs = session.tabs.map((t, i) => {
    const keys = canonicalKeysFallback(t.url);
    return {
      id: i,
      title: t.title,
      url: t.url,
      exactKey: keys.exactKey,
      fuzzyKey: keys.fuzzyKey,
      windowId: 1,
      groupId: -1,
      pinned: false,
      excluded: !/^https?:\/\//i.test(t.url),
    };
  });
  const drafts = buildSuggestions({
    tabs: engineTabs,
    groups: [],
    blocklist: [...DEFAULT_BLOCKLIST],
    rung: 'heuristics',
    dismissed: [],
    scorer: tsScorer,
  });

  // Predicted partition: draft index per grouped tab, else null.
  const predicted = new Array(n).fill(null);
  drafts.forEach((draft, di) => {
    for (const id of draft.tabIds) predicted[id] = di;
  });
  const truth = new Array(n).fill(null);
  session.expectedGroups.forEach((g, gi) => {
    for (const id of g.tabs) truth[id] = gi;
  });

  const pw = pairwise(predicted, truth, n);
  const bc = bcubed(predicted, truth, n);
  const { clicks, manual } = simulateClicks(drafts, truth, n);
  sessionResults.push({
    id: session.id,
    tabs: n,
    suggestions: drafts.length,
    pairwise: pw,
    bcubed: bc,
    clicksToOrganized: clicks,
    manualBaselineClicks: manual,
  });
}

const total = (fn) => sessionResults.reduce((a, r) => a + fn(r), 0);
const micro = pairwise(
  sessionResults.flatMap((r) => []), // placeholder, replaced below
  [],
  0,
);
// Micro-averaged pairwise from summed pair counts.
const sumPw = {
  tp: total((r) => r.pairwise.tp),
  fp: total((r) => r.pairwise.fp),
  fn: total((r) => r.pairwise.fn),
};
const microPrecision = sumPw.tp + sumPw.fp === 0 ? 1 : sumPw.tp / (sumPw.tp + sumPw.fp);
const microRecall = sumPw.tp + sumPw.fn === 0 ? 1 : sumPw.tp / (sumPw.tp + sumPw.fn);
const microF1 = (2 * microPrecision * microRecall) / (microPrecision + microRecall);
const meanBc = {
  precision: total((r) => r.bcubed.precision * r.tabs) / total((r) => r.tabs),
  recall: total((r) => r.bcubed.recall * r.tabs) / total((r) => r.tabs),
  f1: total((r) => r.bcubed.f1 * r.tabs) / total((r) => r.tabs),
};

const report = {
  benchmark: 'Benchmark-Lite',
  milestone: 'M2',
  date: new Date().toISOString().slice(0, 10),
  engine: 'heuristics rung (TypeScript scorer, fixture-locked to the Rust core)',
  nano: 'not run — Gemini Nano is unavailable in CI/sandbox; heuristics-only floor',
  sessions: sessionResults,
  aggregate: {
    pairwise: { precision: microPrecision, recall: microRecall, f1: microF1, ...sumPw },
    bcubedItemWeighted: meanBc,
    clicksToOrganized: total((r) => r.clicksToOrganized),
    manualBaselineClicks: total((r) => r.manualBaselineClicks),
  },
};
writeFileSync(join(here, 'results.json'), JSON.stringify(report, null, 2) + '\n');

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log('\nBenchmark-Lite — heuristics rung, Nano not run\n');
console.log('session                tabs  sugg   pairP   pairR   pairF1  bCubF1  clicks (manual)');
for (const r of sessionResults) {
  console.log(
    `${r.id.padEnd(22)} ${String(r.tabs).padStart(4)} ${String(r.suggestions).padStart(5)}` +
    `  ${pct(r.pairwise.precision).padStart(6)} ${pct(r.pairwise.recall).padStart(6)} ${pct(r.pairwise.f1).padStart(6)}` +
    ` ${pct(r.bcubed.f1).padStart(6)}  ${String(r.clicksToOrganized).padStart(3)} (${r.manualBaselineClicks})`,
  );
}
console.log(
  `\nAggregate: pairwise P ${pct(microPrecision)} · R ${pct(microRecall)} · F1 ${pct(microF1)}` +
  ` | BCubed F1 ${pct(meanBc.f1)} | clicks-to-organized ${report.aggregate.clicksToOrganized}` +
  ` vs manual ${report.aggregate.manualBaselineClicks}`,
);
console.log('Wrote benchmarks/results.json');
