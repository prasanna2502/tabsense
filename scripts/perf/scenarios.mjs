/**
 * Perf scenarios for TabSense M3. Thresholds are ALWAYS loaded from
 * perf-budgets.json by the orchestrator and passed in via ctx.budgets
 * (a Map of budget id -> budget entry); nothing is hardcoded here
 * except scenario shapes (batch sizes, cycle counts) and the churn
 * gate operationalization documented in scenarioChurn.
 *
 * Every scenario returns:
 *   { id, title, status: 'pass'|'fail'|'error', durationMs,
 *     measurements: {...}, gates: [gateEntry], notes: [string] }
 * gateEntry: { budgetId, label, measured, budget, unit, comparison,
 *              pass, gate } — `gate: false` entries are reported
 * against their budget but do not affect the exit code.
 *
 * Diagnostics contract: scenarios that need __tabsensePerf() FAIL
 * loudly when it is absent — they never silently skip.
 */

import { performance } from 'node:perf_hooks';
import { sleep } from './cdp.mjs';
import { launchChrome, makeProfileDir, removeProfileDir } from './chrome.mjs';
import {
  getPerf,
  getWorkerSession,
  measureWorkerCpu,
  pageTaskDuration,
  sampleWorkerHeapMedian,
  waitForPerf,
  waitForPerfField,
} from './worker.mjs';
import {
  closeTargets,
  countFixturePages,
  fixturePageTargets,
  openBatchConcurrent,
  openBatchSequential,
  openTabAndWait,
  openTabsUntilCount,
} from './tabs.mjs';
import { leastSquaresSlope, median, round, summarize } from './stats.mjs';

const MB = 1024 * 1024;
const KB = 1024;

function budgetOf(ctx, id) {
  const entry = ctx.budgets.get(id);
  if (!entry) throw new Error(`Budget ${id} missing from perf-budgets.json`);
  return entry;
}

function gate(ctx, id, label, measured, pass, isGate = true, unitOverride = null) {
  const b = budgetOf(ctx, id);
  return {
    budgetId: id,
    label,
    measured: round(measured, 3),
    budget: b.budget,
    unit: unitOverride ?? b.unit,
    comparison: b.comparison,
    pass: Boolean(pass),
    gate: isGate,
  };
}

function baseResult(id, title) {
  return { id, title, status: 'pass', durationMs: 0, measurements: {}, gates: [], notes: [] };
}

function finish(result, t0) {
  result.durationMs = Math.round(performance.now() - t0);
  if (result.gates.some((g) => g.gate && !g.pass)) result.status = 'fail';
  return result;
}

/**
 * Warm-up used by extension runs: poll the diagnostics contract. When
 * the contract is absent the run can still proceed for measurements
 * that do not depend on it (latency, churn, idle) — fall back to
 * "worker target present + settle" and record the substitution.
 */
async function warmUpExtension(cdp, result, { timeoutMs = 20_000 } = {}) {
  const perf = await waitForPerf(cdp, timeoutMs);
  if (perf) return perf;
  result.notes.push(
    'Diagnostics contract __tabsensePerf() did not respond during warm-up; fell back to worker-target presence + 3 s settle. Measurements that do not depend on the contract remain valid.',
  );
  const worker = await getWorkerSession(cdp);
  if (!worker) {
    result.notes.push('WARNING: no extension service-worker target found at all.');
  }
  await sleep(3_000);
  return null;
}

// ------------------------------------------------------------------
// 1. LATENCY — tab-open added latency, extension on vs off
// ------------------------------------------------------------------

/** Ordered URL list: `unique` fresh paths, then `dupCount` repeats of
 * the earliest paths (duplicates of tabs opened in the same batch). */
function latencyUrls(fixture, start, unique, dupCount) {
  const urls = [];
  for (let i = 0; i < unique; i++) urls.push(fixture.url(`/p/${start + i}`));
  for (let i = 0; i < dupCount; i++) urls.push(fixture.url(`/p/${start + i}`));
  return urls;
}

async function runLatencyVariant(ctx, result, { label, extension, throttleRate, urls }) {
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({
      profileDir,
      extensionDir: extension ? ctx.extensionDir : null,
    });
    const { cdp } = browser;
    if (throttleRate > 0) {
      cdp.addAttachedHook(async ({ sessionId, targetInfo }) => {
        if (targetInfo.type === 'page') {
          await cdp
            .send('Emulation.setCPUThrottlingRate', { rate: throttleRate }, sessionId)
            .catch(() => {});
        }
      });
    }
    if (extension && label !== 'cold') {
      await warmUpExtension(cdp, result);
    }
    const batch = await openBatchSequential(cdp, urls, { timeoutMs: 20_000 });
    const outcomes = { load: 0, detached: 0, timeout: 0 };
    for (const r of batch) outcomes[r.outcome]++;
    // Discard the first tab of the batch: browser warm-up noise
    // (first renderer spawn, first fixture connection, JIT).
    const kept = batch.slice(1).filter((r) => r.outcome !== 'timeout');
    const durations = kept.map((r) => r.ms);
    const stats = summarize(durations);
    ctx.log(
      `latency/${label}: n=${stats.count} median=${round(stats.median)} ms p95=${round(stats.p95)} ms outcomes=${JSON.stringify(outcomes)}`,
    );
    return { label, stats, outcomes, durations };
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

export async function scenarioLatency(ctx) {
  const t0 = performance.now();
  const result = baseResult('latency', 'Tab-open added latency (extension on vs off)');
  const warmList = latencyUrls(ctx.fixture, 0, 45, 15); // 60 tabs
  const coldList = latencyUrls(ctx.fixture, 100, 18, 6); // 24 tabs
  const throttledList = latencyUrls(ctx.fixture, 200, 30, 10); // 40 tabs

  const runs = {};
  runs.baseline = await runLatencyVariant(ctx, result, {
    label: 'baseline',
    extension: false,
    throttleRate: 0,
    urls: warmList,
  });
  runs.cold = await runLatencyVariant(ctx, result, {
    label: 'cold',
    extension: true,
    throttleRate: 0,
    urls: coldList,
  });
  runs.warm = await runLatencyVariant(ctx, result, {
    label: 'warm',
    extension: true,
    throttleRate: 0,
    urls: warmList,
  });
  runs.baselineThrottled = await runLatencyVariant(ctx, result, {
    label: 'baseline-throttled',
    extension: false,
    throttleRate: 4,
    urls: throttledList,
  });
  runs.throttled = await runLatencyVariant(ctx, result, {
    label: 'throttled',
    extension: true,
    throttleRate: 4,
    urls: throttledList,
  });

  const delta = (extRun, baseRun, key) =>
    extRun.stats[key] !== null && baseRun.stats[key] !== null
      ? extRun.stats[key] - baseRun.stats[key]
      : null;

  const warmDeltaMedian = delta(runs.warm, runs.baseline, 'median');
  const warmDeltaP95 = delta(runs.warm, runs.baseline, 'p95');
  const coldDeltaMedian = delta(runs.cold, runs.baseline, 'median');
  const coldDeltaP95 = delta(runs.cold, runs.baseline, 'p95');
  const throttledDeltaMedian = delta(runs.throttled, runs.baselineThrottled, 'median');
  const throttledDeltaP95 = delta(runs.throttled, runs.baselineThrottled, 'p95');

  result.measurements = {
    runs: Object.fromEntries(
      Object.entries(runs).map(([k, v]) => [
        k,
        {
          count: v.stats.count,
          medianMs: round(v.stats.median),
          p95Ms: round(v.stats.p95),
          meanMs: round(v.stats.mean),
          outcomes: v.outcomes,
          durationsMs: v.durations.map((d) => round(d, 1)),
        },
      ]),
    ),
    deltasMs: {
      warm: { median: round(warmDeltaMedian), p95: round(warmDeltaP95) },
      cold: { median: round(coldDeltaMedian), p95: round(coldDeltaP95) },
      throttled: { median: round(throttledDeltaMedian), p95: round(throttledDeltaP95) },
    },
  };
  result.notes.push(
    'First tab of each batch discarded (browser warm-up noise). Cold delta compares the 24-tab cold batch against the 60-tab baseline batch medians; throttled delta compares extension vs baseline both under 4x CPU throttling.',
  );

  const medianBudget = budgetOf(ctx, 'tab-open-added-latency-median').budget;
  const p95Budget = budgetOf(ctx, 'tab-open-added-latency-p95').budget;
  result.gates.push(
    gate(ctx, 'tab-open-added-latency-median', 'Warm added latency, median', warmDeltaMedian, warmDeltaMedian !== null && warmDeltaMedian < medianBudget),
    gate(ctx, 'tab-open-added-latency-p95', 'Warm added latency, p95', warmDeltaP95, warmDeltaP95 !== null && warmDeltaP95 < p95Budget),
    gate(ctx, 'tab-open-added-latency-median', 'Throttled (4x CPU) added latency, median', throttledDeltaMedian, throttledDeltaMedian !== null && throttledDeltaMedian < medianBudget),
    gate(ctx, 'tab-open-added-latency-p95', 'Throttled (4x CPU) added latency, p95', throttledDeltaP95, throttledDeltaP95 !== null && throttledDeltaP95 < p95Budget),
    gate(ctx, 'tab-open-added-latency-median', 'Cold added latency, median (informational)', coldDeltaMedian, coldDeltaMedian !== null && coldDeltaMedian < medianBudget, false),
    gate(ctx, 'tab-open-added-latency-p95', 'Cold added latency, p95 (informational)', coldDeltaP95, coldDeltaP95 !== null && coldDeltaP95 < p95Budget, false),
  );
  return finish(result, t0);
}

// ------------------------------------------------------------------
// 2. SWAP — duplicate focus-swap timing via the diagnostics contract
// ------------------------------------------------------------------

export async function scenarioSwap(ctx) {
  const t0 = performance.now();
  const result = baseResult('swap', 'Duplicate focus-swap');
  const budgetMs = budgetOf(ctx, 'duplicate-focus-swap').budget;
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({ profileDir, extensionDir: ctx.extensionDir });
    const { cdp } = browser;
    const perf = await waitForPerf(cdp, 30_000);
    if (!perf) {
      result.gates.push(
        gate(ctx, 'duplicate-focus-swap', 'Diagnostics contract __tabsensePerf() present', null, false),
      );
      result.notes.push(
        'FAIL: globalThis.__tabsensePerf() did not respond in the extension worker within 30 s. The swap scenario cannot measure focus-swap timing without the diagnostics contract.',
      );
      return finish(result, t0);
    }

    const samples = [];
    const iterations = [];
    for (let i = 0; i < 5; i++) {
      const url = ctx.fixture.url(`/swap/${i}`);
      const original = await openTabAndWait(cdp, url, { timeoutMs: 15_000 });
      if (original.outcome === 'timeout') {
        iterations.push({ iteration: i, error: 'original tab did not load' });
        continue;
      }
      const before = await getPerf(cdp);
      const countBefore = before?.swaps?.count ?? 0;
      const pagesBefore = await countFixturePages(cdp, ctx.fixture.base);
      await cdp.send('Target.createTarget', { url });
      // Poll the contract for the swap sample, up to 2 s.
      let landed = null;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const now = await getPerf(cdp);
        if (now && now.swaps && now.swaps.count > countBefore && now.swaps.lastMs !== null) {
          landed = now.swaps.lastMs;
          break;
        }
        await sleep(100);
      }
      await sleep(300); // let the duplicate target finish detaching
      const pagesAfter = await countFixturePages(cdp, ctx.fixture.base);
      const dupGone = pagesAfter === pagesBefore;
      iterations.push({
        iteration: i,
        swapMs: landed,
        landed: landed !== null,
        duplicateGone: dupGone,
        pagesBefore,
        pagesAfter,
      });
      if (landed !== null) samples.push(landed);
      ctx.log(`swap/${i}: lastMs=${landed} duplicateGone=${dupGone}`);
    }

    const allLanded = iterations.every((it) => it.landed);
    const allGone = iterations.every((it) => it.duplicateGone);
    const maxSample = samples.length ? Math.max(...samples) : null;
    result.measurements = {
      iterations,
      samplesMs: samples,
      medianMs: round(median(samples)),
      maxMs: round(maxSample),
    };
    result.gates.push(
      gate(ctx, 'duplicate-focus-swap', 'Swap sample landed in all 5 iterations', allLanded ? 1 : 0, allLanded, true, 'of 5'),
      gate(ctx, 'duplicate-focus-swap', 'Duplicate target closed in all 5 iterations', allGone ? 1 : 0, allGone, true, 'of 5'),
      gate(ctx, 'duplicate-focus-swap', 'Slowest focus-swap (lastMs)', maxSample, maxSample !== null && maxSample < budgetMs),
    );
    return finish(result, t0);
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

// ------------------------------------------------------------------
// Shared restore flow (memory scenario + restore storm)
// ------------------------------------------------------------------

/**
 * Relaunch a populated profile with --restore-last-session and wait
 * until the restored page targets exist and the diagnostics contract
 * responds. Returns { browser, restoredCount, perf } — caller closes
 * the browser.
 */
async function relaunchAndWaitRestore(ctx, profileDir, want) {
  const browser = await launchChrome({
    profileDir,
    extensionDir: ctx.extensionDir,
    extraArgs: ['--restore-last-session'],
  });
  const { cdp } = browser;
  const deadline = Date.now() + 180_000;
  let restoredCount = 0;
  let perf = null;
  while (Date.now() < deadline) {
    restoredCount = await countFixturePages(cdp, ctx.fixture.base);
    perf = await getPerf(cdp);
    if (restoredCount >= want && perf) break;
    await sleep(500);
  }
  // Small settle so rebuildMs/trackedTabs reflect the completed storm.
  await sleep(1_000);
  perf = (await getPerf(cdp)) ?? perf;
  restoredCount = await countFixturePages(cdp, ctx.fixture.base);
  return { browser, restoredCount, perf };
}

// ------------------------------------------------------------------
// 3. MEMORY + REBUILD-500
// ------------------------------------------------------------------

export async function scenarioMemory(ctx) {
  const t0 = performance.now();
  const result = baseResult('memory', 'Memory at scale + index rebuild (500 tabs)');
  const memBudgetMB = budgetOf(ctx, 'memory-500-tabs').budget;
  const perTabBudgetKB = budgetOf(ctx, 'memory-per-tab-marginal').budget;
  const rebuildBudgetMs = budgetOf(ctx, 'duplicate-index-rebuild-500').budget;
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({ profileDir, extensionDir: ctx.extensionDir });
    const { cdp } = browser;
    const perf0 = await waitForPerf(cdp, 30_000);
    if (!perf0) {
      result.gates.push(
        gate(ctx, 'duplicate-index-rebuild-500', 'Diagnostics contract __tabsensePerf() present', null, false),
      );
      result.notes.push(
        'FAIL: globalThis.__tabsensePerf() did not respond in the extension worker within 30 s. Rebuild timing, trackedTabs and autoCloseCount all come from the contract; the memory scenario cannot run without it.',
      );
      return finish(result, t0);
    }

    const stages = {};
    let nextIndex = 0;
    for (const want of [100, 300, 500]) {
      const opened = await openTabsUntilCount(cdp, ctx.fixture, want, {
        startIndex: nextIndex,
        log: (m) => ctx.log(`memory: ${m}`),
      });
      nextIndex = opened.nextIndex;
      const perf = await waitForPerfField(cdp, (p) => p.trackedTabs >= want, 30_000);
      const heap = await sampleWorkerHeapMedian(cdp, { samples: 5, gapMs: 250 });
      stages[want] = {
        pageTargets: opened.count,
        trackedTabs: perf?.trackedTabs ?? null,
        indexSize: perf?.indexSize ?? null,
        heapBytes: heap.bytes,
        heapMB: round(heap.bytes / MB),
        heapMethod: heap.method,
      };
      ctx.log(
        `memory stage ${want}: pages=${opened.count} tracked=${perf?.trackedTabs} heap=${stages[want].heapMB} MB via ${heap.method}`,
      );
    }
    result.measurements.stages = stages;
    result.notes.push(
      'Heap is the worker JS heap (HeapProfiler snapshot self_size sum; Performance domain and performance.memory are unavailable on service-worker targets in this Chrome). The extension has no offscreen document, so worker heap is the full "worker + offscreen" figure.',
    );

    const marginalKB =
      stages[500] && stages[100]
        ? (stages[500].heapBytes - stages[100].heapBytes) / 400 / KB
        : null;
    result.measurements.marginalKBPerTab = round(marginalKB);
    result.gates.push(
      gate(ctx, 'memory-per-tab-marginal', 'Marginal memory per tab (100 → 500)', marginalKB, marginalKB !== null && marginalKB < perTabBudgetKB),
      gate(ctx, 'memory-500-tabs', 'Worker heap at 500 tabs', stages[500].heapBytes / MB, stages[500].heapBytes / MB < memBudgetMB),
    );

    // Graceful close so the session is flushed, then restore it.
    await browser.close({ graceful: true });
    browser = null;

    const restored = await relaunchAndWaitRestore(ctx, profileDir, 500);
    browser = restored.browser;
    const rperf = restored.perf;
    if (!rperf) {
      result.gates.push(
        gate(ctx, 'duplicate-index-rebuild-500', 'Diagnostics contract responds after restore', null, false),
      );
      result.notes.push('FAIL: __tabsensePerf() did not respond after session restore.');
      return finish(result, t0);
    }
    const heapAfter = await sampleWorkerHeapMedian(browser.cdp, { samples: 5, gapMs: 250 });
    result.measurements.restore = {
      pageTargets: restored.restoredCount,
      rebuildMs: rperf.rebuildMs,
      coreReindexMs: rperf.coreReindexMs,
      trackedTabs: rperf.trackedTabs,
      indexSize: rperf.indexSize,
      autoCloseCount: rperf.autoCloseCount,
      heapMB: round(heapAfter.bytes / MB),
      heapMethod: heapAfter.method,
    };
    ctx.log(
      `memory restore: pages=${restored.restoredCount} rebuildMs=${rperf.rebuildMs} tracked=${rperf.trackedTabs} autoClose=${rperf.autoCloseCount} heap=${result.measurements.restore.heapMB} MB`,
    );
    result.gates.push(
      gate(ctx, 'duplicate-index-rebuild-500', 'Index rebuild on worker start (500-tab restore)', rperf.rebuildMs, typeof rperf.rebuildMs === 'number' && rperf.rebuildMs < rebuildBudgetMs),
      gate(ctx, 'duplicate-index-rebuild-500', 'Restored tabs never auto-closed (autoCloseCount == 0)', rperf.autoCloseCount, rperf.autoCloseCount === 0, true, 'closes'),
      gate(ctx, 'duplicate-index-rebuild-500', 'trackedTabs ≈ 500 after restore (±10)', rperf.trackedTabs, typeof rperf.trackedTabs === 'number' && Math.abs(rperf.trackedTabs - 500) <= 10, true, 'tabs'),
      gate(ctx, 'memory-500-tabs', 'Worker heap at 500 tabs after restore', heapAfter.bytes / MB, heapAfter.bytes / MB < memBudgetMB),
    );
    return finish(result, t0);
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

// ------------------------------------------------------------------
// 4. RESTORE STORM 300
// ------------------------------------------------------------------

export async function scenarioRestoreStorm(ctx) {
  const t0 = performance.now();
  const result = baseResult('restore-storm', 'Restore storm (300 tabs)');
  const rebuildBudgetMs = budgetOf(ctx, 'duplicate-index-rebuild-500').budget;
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({ profileDir, extensionDir: ctx.extensionDir });
    const opened = await openTabsUntilCount(browser.cdp, ctx.fixture, 300, {
      log: (m) => ctx.log(`restore-storm: ${m}`),
    });
    result.measurements.openedPageTargets = opened.count;
    await browser.close({ graceful: true });
    browser = null;

    const restored = await relaunchAndWaitRestore(ctx, profileDir, 300);
    browser = restored.browser;
    const rperf = restored.perf;
    result.measurements.restoredPageTargets = restored.restoredCount;
    if (!rperf) {
      result.gates.push(
        gate(ctx, 'duplicate-index-rebuild-500', 'Diagnostics contract responds after restore', null, false),
      );
      result.notes.push('FAIL: __tabsensePerf() did not respond after the 300-tab restore.');
      return finish(result, t0);
    }
    result.measurements.rebuildMs = rperf.rebuildMs;
    result.measurements.coreReindexMs = rperf.coreReindexMs;
    result.measurements.trackedTabs = rperf.trackedTabs;
    result.measurements.autoCloseCount = rperf.autoCloseCount;
    const heap = await sampleWorkerHeapMedian(browser.cdp, { samples: 3, gapMs: 250 });
    result.measurements.heapMB = round(heap.bytes / MB);
    result.measurements.heapMethod = heap.method;
    ctx.log(
      `restore-storm: restored=${restored.restoredCount} rebuildMs=${rperf.rebuildMs} autoClose=${rperf.autoCloseCount}`,
    );
    result.gates.push(
      gate(ctx, 'duplicate-index-rebuild-500', 'All 300 tabs restored (page targets)', restored.restoredCount, restored.restoredCount >= 300, true, 'tabs'),
      gate(ctx, 'duplicate-index-rebuild-500', 'Restored tabs never auto-closed (autoCloseCount == 0)', rperf.autoCloseCount, rperf.autoCloseCount === 0, true, 'closes'),
      gate(ctx, 'duplicate-index-rebuild-500', 'Index rebuild at 300 tabs (informational; the gate is the 500-tab number)', rperf.rebuildMs, typeof rperf.rebuildMs === 'number' && rperf.rebuildMs < rebuildBudgetMs, false),
    );
    return finish(result, t0);
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

// ------------------------------------------------------------------
// 5. CHURN / LEAK — 5,000 open/close cycles
// ------------------------------------------------------------------

export async function scenarioChurn(ctx) {
  const t0 = performance.now();
  const result = baseResult('churn', 'Churn / leak (5,000 open/close cycles)');
  // Iteration aids for local development; CI uses the spec defaults.
  const totalCycles = Number(process.env.PERF_CHURN_TOTAL) || 5_000;
  const warmupCycles = Number(process.env.PERF_CHURN_WARMUP) || 500;
  const specRun = totalCycles === 5_000 && warmupCycles === 500;
  if (!specRun) {
    result.notes.push(
      `Non-spec churn run (PERF_CHURN_TOTAL=${totalCycles}, PERF_CHURN_WARMUP=${warmupCycles}): gates are reported informationally only.`,
    );
  }
  const BURST = 25;
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({ profileDir, extensionDir: ctx.extensionDir });
    const { cdp } = browser;
    await warmUpExtension(cdp, result);
    const anchor = await openTabAndWait(cdp, ctx.fixture.url('/churn/anchor'), { timeoutMs: 15_000 });
    const anchorUrl = ctx.fixture.url('/churn/anchor');
    let cycle = 0;
    let burstIndex = 0;
    const runCycles = async (n) => {
      let done = 0;
      while (done < n) {
        const size = Math.min(BURST, n - done);
        const urls = [];
        for (let i = 0; i < size; i++) {
          cycle++;
          urls.push(ctx.fixture.url(`/churn/c${cycle}`));
        }
        // Every 10th burst, 5 of the tabs duplicate the persistent
        // anchor (they exercise the swap path mid-churn).
        if (burstIndex % 10 === 9) {
          for (let i = 0; i < Math.min(5, size); i++) urls[i] = anchorUrl;
        }
        burstIndex++;
        const ids = await openBatchConcurrent(cdp, urls, { timeoutMs: 20_000 });
        await closeTargets(cdp, ids);
        done += size;
      }
    };

    await runCycles(warmupCycles);
    ctx.log(`churn: warm-up ${warmupCycles} cycles done`);

    const points = [];
    const samplePoint = async (cyclesDone) => {
      const heap = await sampleWorkerHeapMedian(cdp, { samples: 3, gapMs: 300 });
      const point = { cycles: cyclesDone, heapKB: heap.bytes / KB, heapMB: round(heap.bytes / MB, 3) };
      points.push(point);
      ctx.log(`churn: sample @${cyclesDone} cycles heap=${point.heapMB} MB via ${heap.method}`);
      return point;
    };

    await samplePoint(0);
    let doneCycles = 0;
    while (doneCycles < totalCycles) {
      const step = Math.min(500, totalCycles - doneCycles);
      await runCycles(step);
      doneCycles += step;
      await samplePoint(doneCycles);
    }

    const slope = leastSquaresSlope(points.map((p) => ({ x: p.cycles, y: p.heapKB })));
    const totalGrowthKB = points.length >= 2 ? points[points.length - 1].heapKB - points[0].heapKB : null;
    result.measurements = {
      warmupCycles,
      totalCycles,
      anchorOutcome: anchor.outcome,
      samples: points.map((p) => ({ cycles: p.cycles, heapMB: p.heapMB })),
      slopeKBPerCycle: round(slope, 5),
      totalGrowthKB: round(totalGrowthKB),
      totalGrowthMB: round(totalGrowthKB !== null ? totalGrowthKB / KB : null, 3),
    };
    result.notes.push(
      'Gate operationalization of "≈ 0 slope" (budget memory-growth-5000-cycles): least-squares slope < 0.01 KB/cycle AND total post-warm-up growth < 2 MB. Raw samples are reported above regardless of outcome; the gate is not tuned to the measurement.',
    );
    result.gates.push(
      gate(ctx, 'memory-growth-5000-cycles', 'Leak slope (least squares, post warm-up)', slope, slope < 0.01, specRun, 'KB/cycle'),
      gate(ctx, 'memory-growth-5000-cycles', 'Total heap growth over cycles', totalGrowthKB, totalGrowthKB !== null && totalGrowthKB < 2 * KB, specRun, 'KB'),
    );
    return finish(result, t0);
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

// ------------------------------------------------------------------
// 6. IDLE — no CPU, no network while idle
// ------------------------------------------------------------------

export async function scenarioIdle(ctx) {
  const t0 = performance.now();
  const result = baseResult('idle', 'Idle CPU / network');
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({ profileDir, extensionDir: ctx.extensionDir });
    const { cdp } = browser;
    const urls = [];
    for (let i = 0; i < 20; i++) urls.push(ctx.fixture.url(`/idle/${i}`));
    await openBatchConcurrent(cdp, urls, { timeoutMs: 20_000 });
    await warmUpExtension(cdp, result);
    await sleep(5_000); // settle

    const worker = await getWorkerSession(cdp);
    if (!worker) {
      result.status = 'error';
      result.notes.push('FAIL: no extension service-worker target found for the idle measurement.');
      return finish(result, t0);
    }

    let counting = false;
    let workerRequests = 0;
    const off = cdp.onMethod('Network.requestWillBeSent', (msg) => {
      if (counting && msg.sessionId === worker.sessionId) workerRequests++;
    });
    await cdp.send('Network.enable', {}, worker.sessionId);

    // Secondary signal: TaskDuration on an idle fixture page (the
    // Performance domain exists on pages, not on the worker).
    const pages = await fixturePageTargets(cdp, ctx.fixture.base);
    const pageSession = pages.length ? cdp.sessionForTarget(pages[0].targetId) : null;
    const taskBefore = pageSession ? await pageTaskDuration(cdp, pageSession).catch(() => null) : null;

    counting = true;
    // Worker CPU via the Profiler domain for the 15 s window. The
    // spec's TaskDuration measure comes from Performance.getMetrics,
    // which this Chrome does not expose on service-worker targets
    // (verified: 'Performance.enable' wasn't found) — Profiler
    // sampled active time (total minus "(idle)") is the worker-scoped
    // equivalent and is what the gate uses.
    const cpu = await measureWorkerCpu(cdp, 15_000);
    counting = false;
    off();
    await cdp.send('Network.disable', {}, worker.sessionId).catch(() => {});

    const taskAfter = pageSession ? await pageTaskDuration(cdp, pageSession).catch(() => null) : null;
    const taskDelta =
      taskBefore !== null && taskAfter !== null ? taskAfter - taskBefore : null;

    result.measurements = {
      windowSec: 15,
      workerNetworkRequests: workerRequests,
      workerCpuActiveSec: round(cpu.activeSec, 3),
      workerCpuIdleSec: round(cpu.idleSec, 3),
      workerProfileSamples: cpu.sampleCount,
      pageTaskDurationDeltaSec: round(taskDelta, 3),
    };
    result.notes.push(
      'Worker CPU measured with the CDP Profiler domain (sampled active time, "(idle)" node excluded) because Performance.getMetrics/TaskDuration is unavailable on service-worker targets in this Chrome. Page TaskDuration delta is reported as a secondary signal only.',
    );
    ctx.log(
      `idle: workerRequests=${workerRequests} workerCpuActive=${round(cpu.activeSec, 3)}s pageTaskDelta=${round(taskDelta, 3)}s`,
    );
    result.gates.push(
      gate(ctx, 'idle-cpu-network', 'Network requests from worker during 15 s idle window', workerRequests, workerRequests === 0),
      gate(ctx, 'idle-cpu-network', 'Worker CPU-active time during 15 s idle window (s)', cpu.activeSec, cpu.activeSec < 0.2),
    );
    return finish(result, t0);
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

export const SCENARIOS = {
  latency: scenarioLatency,
  swap: scenarioSwap,
  memory: scenarioMemory,
  'restore-storm': scenarioRestoreStorm,
  churn: scenarioChurn,
  idle: scenarioIdle,
};
