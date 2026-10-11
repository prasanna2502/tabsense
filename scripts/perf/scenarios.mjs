/**
 * Perf scenarios for TabSense M3. Thresholds are ALWAYS loaded from
 * perf-budgets.json by the orchestrator and passed in via ctx.budgets
 * (a Map of budget id -> budget entry); nothing is hardcoded here
 * except scenario shapes (batch sizes, cycle counts, round counts)
 * and the ratified gate operationalizations documented in
 * scenarioChurn and in perf-budgets.json's notes (M3 ratification,
 * 2026-10-11). Verdict logic lives in ./gates.mjs (unit-tested).
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
import {
  abbaQuartetDeltas,
  churnChecks,
  medianOfRounds,
  pairedBlockMedianDelta,
  pooledP95Delta,
} from './gates.mjs';

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

/**
 * Unique-only URL list for the latency batches (M3 gate design
 * change, user-approved 2026-10-11): ordinary tab opens only.
 * Duplicate opens used to make up a quarter of each batch; their
 * lifecycle differs by condition (the extension auto-closes them —
 * a detach outcome — while the baseline loads them fully), which
 * contaminates the added-latency estimand in both directions. The
 * duplicate path keeps its own budget and scenario
 * (duplicate-focus-swap), so nothing loses coverage.
 */
function latencyUrls(fixture, start, count) {
  const urls = [];
  for (let i = 0; i < count; i++) urls.push(fixture.url(`/p/${start + i}`));
  return urls;
}

/** Tab-opens per interleaved block (~5; scenario shape). */
const LATENCY_BLOCK_SIZE = 5;
/**
 * Unmeasured warm-up opens per browser per round in the
 * interleaved profiles. They replace the old per-batch first-tab
 * discard for those profiles: the discard existed because every
 * batch started in a cold browser (first renderer spawn, first
 * fixture connection, JIT), and one warm-up block per browser
 * covers the same ground without taxing the first sample of
 * every block — measured blocks run entirely in warm browsers,
 * so no per-block discard is applied.
 */
const LATENCY_WARMUP_OPENS = 3;

/** One sequential block of tab opens in a running browser.
 * Timeouts are excluded from the durations (the longstanding
 * convention); outcomes are counted in full. */
async function openLatencyBlock(cdp, urls) {
  const batch = await openBatchSequential(cdp, urls, { timeoutMs: 20_000 });
  const outcomes = { load: 0, detached: 0, timeout: 0 };
  for (const r of batch) outcomes[r.outcome]++;
  const durations = batch.filter((r) => r.outcome !== 'timeout').map((r) => r.ms);
  return { durations, stats: summarize(durations), outcomes };
}

function blockStats(blk) {
  return {
    count: blk.stats.count,
    medianMs: round(blk.stats.median),
    p95Ms: round(blk.stats.p95),
    meanMs: round(blk.stats.mean),
    outcomes: blk.outcomes,
    durationsMs: blk.durations.map((d) => round(d, 1)),
  };
}

/**
 * Launch one latency browser (baseline or extension; page CPU
 * throttling when the profile asks for it). Extension browsers
 * are warmed through the diagnostics contract before any measured
 * block, as the sequential runs did. close() always tears the
 * browser and its profile down.
 */
async function launchLatencyBrowser(ctx, result, { extension, throttleRate }) {
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({
      profileDir,
      extensionDir: extension ? ctx.extensionDir : null,
    });
  } catch (err) {
    removeProfileDir(profileDir);
    throw err;
  }
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
  if (extension) {
    await warmUpExtension(cdp, result);
  }
  return {
    cdp,
    openBlock: (urls) => openLatencyBlock(cdp, urls),
    async close() {
      await browser.close({ graceful: false }).catch(() => {});
      removeProfileDir(profileDir);
    },
  };
}

/**
 * One interleaved profile run (M3 gate design change, 2026-10-11):
 * a baseline browser and an extension browser are alive at the
 * same time and open tabs in alternating ABBA blocks of
 * LATENCY_BLOCK_SIZE opens, so both conditions sample the same
 * minutes of runner weather and slow drift is common-mode between
 * paired blocks. Each browser first opens an unmeasured warm-up
 * block (see LATENCY_WARMUP_OPENS). Returns the ordered block
 * records; ABBA quartets pair within the returned order.
 */
async function runInterleavedProfile(ctx, result, { label, throttleRate, urls, warmupUrls }) {
  const off = await launchLatencyBrowser(ctx, result, { extension: false, throttleRate });
  let on = null;
  try {
    on = await launchLatencyBrowser(ctx, result, { extension: true, throttleRate });
    await off.openBlock(warmupUrls);
    await on.openBlock(warmupUrls);
    const chunks = [];
    for (let i = 0; i < urls.length; i += LATENCY_BLOCK_SIZE) {
      chunks.push(urls.slice(i, i + LATENCY_BLOCK_SIZE));
    }
    const blocks = [];
    let offIdx = 0;
    let onIdx = 0;
    const pushBlock = async (condition) => {
      const handle = condition === 'on' ? on : off;
      const chunk = condition === 'on' ? chunks[onIdx++] : chunks[offIdx++];
      const blk = await handle.openBlock(chunk);
      const rec = { index: blocks.length, condition, ...blockStats(blk) };
      blocks.push(rec);
      ctx.log(
        `latency/${label} block ${rec.index} (${condition}): n=${rec.count} median=${rec.medianMs} ms p95=${rec.p95Ms} ms outcomes=${JSON.stringify(rec.outcomes)}`,
      );
    };
    while (offIdx < chunks.length || onIdx < chunks.length) {
      for (const condition of ['off', 'on', 'on', 'off']) {
        if (condition === 'off' && offIdx < chunks.length) await pushBlock('off');
        else if (condition === 'on' && onIdx < chunks.length) await pushBlock('on');
      }
    }
    return { blocks };
  } finally {
    await off.close().catch(() => {});
    if (on) await on.close().catch(() => {});
  }
}

/** Single-browser batch run — now used only by the cold profile,
 * which stays single-shot and informational. */
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
  const warmList = latencyUrls(ctx.fixture, 0, 60); // 60 unique tabs per condition
  const coldList = latencyUrls(ctx.fixture, 100, 24); // 24 unique tabs
  const throttledList = latencyUrls(ctx.fixture, 200, 40); // 40 unique tabs per condition

  // Methodology history (all user decisions, recorded in
  // perf-budgets.json's notes):
  //  - M3 ratification (2026-10-11): single-shot on/off deltas on
  //    shared CI runners are noise-dominated (throttled p95 swung
  //    +97.5 ms to -43 ms on equivalent code), so the warm and
  //    throttled profiles run ROUNDS repetitions and gate on
  //    robust across-round statistics. All rounds run and are
  //    reported; there are no retries-until-pass. Cold stays
  //    single-shot and informational, as before. Round count is
  //    overridable for local diagnosis (PERF_LATENCY_ROUNDS); any
  //    non-default count is disclosed in the report notes.
  //  - Follow-up (2026-10-11): the throttled p95 gate pools all
  //    rounds' raw samples per condition and gates on the
  //    difference of the two pooled p95s (gates.mjs
  //    pooledP95Delta); the superseded median-of-rounds p95 is
  //    still reported informationally.
  //  - Design change (2026-10-11): PR #3's run passed that pooled
  //    p95 (-37.7 ms) but failed the throttled MEDIAN at 21.61 ms
  //    vs <10 ms — a row that read -5.54 ms in PR #2's run on
  //    unchanged extension code. Sequential per-round blocks (a
  //    full baseline browser run, then a full extension browser
  //    run, minutes apart) let runner drift sign the delta, and
  //    the design's run-to-run swing (~±30 ms) exceeds the budget
  //    it enforces. The profiles now measure INTERLEAVED
  //    (runInterleavedProfile): two live browsers alternate ABBA
  //    blocks of LATENCY_BLOCK_SIZE opens, and the added-latency
  //    MEDIAN (warm and throttled) gates on the median of the
  //    paired block differences (gates.mjs
  //    pairedBlockMedianDelta) — within each ABBA quartet the two
  //    conditions' time centroids coincide, so linear drift
  //    cancels in the paired difference. The warm p95 keeps the
  //    ratified median-of-rounds, computed from each round's
  //    block samples aggregated per condition; the throttled p95
  //    keeps the pooled statistic over the interleaved samples.
  //    The batches are unique-only (see latencyUrls). Superseded
  //    statistics stay in the report informationally — the noise
  //    stays visible; only the verdict statistics changed.
  const ROUNDS = Math.max(1, Number(process.env.PERF_LATENCY_ROUNDS) || 5);
  result.measurements.roundsRequested = ROUNDS;

  const deltaOf = (extRun, baseRun, key) =>
    extRun && baseRun && extRun.stats[key] !== null && baseRun.stats[key] !== null
      ? extRun.stats[key] - baseRun.stats[key]
      : null;
  const runStats = (v) => ({
    count: v.stats.count,
    medianMs: round(v.stats.median),
    p95Ms: round(v.stats.p95),
    meanMs: round(v.stats.mean),
    outcomes: v.outcomes,
    durationsMs: v.durations.map((d) => round(d, 1)),
  });
  /** Aggregate one condition of an interleaved profile run from
   * its blocks (the per-round view the superseded statistics and
   * the warm p95 gate are computed from). */
  const conditionStats = (blocks, condition) => {
    const durations = blocks.filter((b) => b.condition === condition).flatMap((b) => b.durationsMs);
    const stats = summarize(durations);
    return {
      count: stats.count,
      medianMs: round(stats.median),
      p95Ms: round(stats.p95),
      meanMs: round(stats.mean),
      durationsMs: durations,
    };
  };
  const statDelta = (on, off, key) =>
    on[key] !== null && off[key] !== null ? on[key] - off[key] : null;
  const profileSummary = (profile) => {
    const on = conditionStats(profile.blocks, 'on');
    const off = conditionStats(profile.blocks, 'off');
    return {
      blocks: profile.blocks,
      on,
      off,
      pairedDiffsMs: abbaQuartetDeltas(profile.blocks).diffsMs.map((d) => round(d)),
      deltasMs: {
        median: round(statDelta(on, off, 'medianMs')),
        p95: round(statDelta(on, off, 'p95Ms')),
      },
    };
  };

  const rounds = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const warmProfile = await runInterleavedProfile(ctx, result, {
      label: `warm-r${r}`,
      throttleRate: 0,
      urls: warmList,
      warmupUrls: latencyUrls(ctx.fixture, 1000 + (r - 1) * 10, LATENCY_WARMUP_OPENS),
    });
    const throttledProfile = await runInterleavedProfile(ctx, result, {
      label: `throttled-r${r}`,
      throttleRate: 4,
      urls: throttledList,
      warmupUrls: latencyUrls(ctx.fixture, 1100 + (r - 1) * 10, LATENCY_WARMUP_OPENS),
    });
    const entry = {
      round: r,
      warm: profileSummary(warmProfile),
      throttled: profileSummary(throttledProfile),
    };
    rounds.push(entry);
    ctx.log(
      `latency round ${r}/${ROUNDS}: warm paired Δmedian (this round)=${round(median(entry.warm.pairedDiffsMs))} ms · throttled paired Δmedian (this round)=${round(median(entry.throttled.pairedDiffsMs))} ms`,
    );
  }

  const coldBaseline = rounds[0]
    ? { stats: { median: rounds[0].warm.off.medianMs, p95: rounds[0].warm.off.p95Ms } }
    : null;
  const coldRun = await runLatencyVariant(ctx, result, {
    label: 'cold',
    extension: true,
    throttleRate: 0,
    urls: coldList,
  });
  const coldDeltaMedian = deltaOf(coldRun, coldBaseline, 'median');
  const coldDeltaP95 = deltaOf(coldRun, coldBaseline, 'p95');

  const warmPaired = pairedBlockMedianDelta(rounds.map((e) => e.warm.blocks));
  const throttledPaired = pairedBlockMedianDelta(rounds.map((e) => e.throttled.blocks));
  const warmMedianOfRounds = medianOfRounds(rounds.map((e) => e.warm.deltasMs.median));
  const throttledMedianOfRounds = medianOfRounds(rounds.map((e) => e.throttled.deltasMs.median));
  const throttledP95MedianOfRounds = medianOfRounds(rounds.map((e) => e.throttled.deltasMs.p95));
  const throttledPooled = pooledP95Delta(
    rounds.map((e) => e.throttled.on.durationsMs),
    rounds.map((e) => e.throttled.off.durationsMs),
  );
  const gated = {
    warm: {
      median: warmPaired.delta,
      p95: medianOfRounds(rounds.map((e) => e.warm.deltasMs.p95)),
    },
    throttled: {
      median: throttledPaired.delta,
      p95: throttledPooled.delta,
    },
  };

  result.measurements.rounds = rounds;
  result.measurements.pairedMedians = {
    warm: {
      pairCount: warmPaired.pairCount,
      droppedBlocks: warmPaired.droppedBlocks,
      diffsMs: warmPaired.diffsMs.map((d) => round(d)),
      deltaMs: round(warmPaired.delta),
    },
    throttled: {
      pairCount: throttledPaired.pairCount,
      droppedBlocks: throttledPaired.droppedBlocks,
      diffsMs: throttledPaired.diffsMs.map((d) => round(d)),
      deltaMs: round(throttledPaired.delta),
    },
  };
  result.measurements.throttledP95Pooled = {
    onCount: throttledPooled.onCount,
    offCount: throttledPooled.offCount,
    onP95Ms: round(throttledPooled.onP95),
    offP95Ms: round(throttledPooled.offP95),
    deltaMs: round(throttledPooled.delta),
  };
  result.measurements.cold = { ...runStats(coldRun), deltasMs: { median: round(coldDeltaMedian), p95: round(coldDeltaP95) } };
  result.measurements.deltasMs = {
    warm: { median: round(gated.warm.median), p95: round(gated.warm.p95), medianMedianOfRounds: round(warmMedianOfRounds) },
    cold: { median: round(coldDeltaMedian), p95: round(coldDeltaP95) },
    throttled: {
      median: round(gated.throttled.median),
      p95: round(gated.throttled.p95),
      medianMedianOfRounds: round(throttledMedianOfRounds),
      p95MedianOfRounds: round(throttledP95MedianOfRounds),
    },
  };
  result.measurements.gatingMethod =
    `Added-latency MEDIAN (warm and throttled): median of paired ABBA block differences — two live browsers per profile alternate blocks of ${LATENCY_BLOCK_SIZE} opens, per-quartet paired deltas pooled across ${ROUNDS} round(s) (M3 gate design change, 2026-10-11; see measurements.pairedMedians). Warm p95: median across rounds of per-round deltas (M3 ratification, 2026-10-11). Throttled p95: pooled percentile across all rounds' samples (follow-up, 2026-10-11; see measurements.throttledP95Pooled). Superseded median-of-rounds statistics are reported informationally. Per-round blocks and samples are in measurements.rounds.`;
  result.notes.push(
    `Interleaved design (M3 gate design change, user decision 2026-10-11): each warm/throttled round runs a baseline and an extension browser side by side, alternating ABBA blocks of ${LATENCY_BLOCK_SIZE} tab-opens; the median gates on the median of the ${warmPaired.pairCount + throttledPaired.pairCount} paired quartet differences (warm ${warmPaired.pairCount}, throttled ${throttledPaired.pairCount}; ${warmPaired.droppedBlocks + throttledPaired.droppedBlocks} blocks dropped as unpairable). Each browser opens ${LATENCY_WARMUP_OPENS} unmeasured warm-up tabs per round (cold-browser cover, replacing the per-batch first-tab discard for these profiles; the cold batch keeps its first-tab discard). Latency batches are unique-only — duplicate opens are covered by the duplicate-focus-swap scenario. No budget number changed.`,
  );
  result.notes.push(
    `Throttled p95 gate statistic (follow-up, user decision 2026-10-11): pooled percentile across all ${ROUNDS} rounds of interleaved samples — ${throttledPooled.onCount} extension-on and ${throttledPooled.offCount} extension-off samples pooled per condition; pooled p95 on = ${round(throttledPooled.onP95)} ms, off = ${round(throttledPooled.offP95)} ms, gated delta = ${round(throttledPooled.delta)} ms against the unchanged <25 ms budget. The superseded median-of-rounds statistic (${round(throttledP95MedianOfRounds)} ms this run) is reported informationally below.`,
  );
  if (ROUNDS !== 5) {
    result.notes.push(`PERF_LATENCY_ROUNDS=${ROUNDS} (non-default): this run used ${ROUNDS} round(s) instead of the ratified 5.`);
  }

  const medianBudget = budgetOf(ctx, 'tab-open-added-latency-median').budget;
  const p95Budget = budgetOf(ctx, 'tab-open-added-latency-p95').budget;
  result.gates.push(
    gate(ctx, 'tab-open-added-latency-median', `Warm added latency, median (paired ABBA blocks, median of ${warmPaired.pairCount} paired differences)`, gated.warm.median, gated.warm.median !== null && gated.warm.median < medianBudget),
    gate(ctx, 'tab-open-added-latency-p95', `Warm added latency, p95 (median of ${ROUNDS} rounds)`, gated.warm.p95, gated.warm.p95 !== null && gated.warm.p95 < p95Budget),
    gate(ctx, 'tab-open-added-latency-median', `Throttled (4x CPU) added latency, median (paired ABBA blocks, median of ${throttledPaired.pairCount} paired differences)`, gated.throttled.median, gated.throttled.median !== null && gated.throttled.median < medianBudget),
    gate(ctx, 'tab-open-added-latency-p95', `Throttled (4x CPU) added latency, p95 (pooled across ${ROUNDS} rounds: ${throttledPooled.onCount} on / ${throttledPooled.offCount} off samples)`, gated.throttled.p95, gated.throttled.p95 !== null && gated.throttled.p95 < p95Budget),
    gate(ctx, 'tab-open-added-latency-median', `Warm added latency, median (median of ${ROUNDS} rounds — superseded statistic, informational)`, warmMedianOfRounds, warmMedianOfRounds !== null && warmMedianOfRounds < medianBudget, false),
    gate(ctx, 'tab-open-added-latency-median', `Throttled (4x CPU) added latency, median (median of ${ROUNDS} rounds — superseded statistic, informational)`, throttledMedianOfRounds, throttledMedianOfRounds !== null && throttledMedianOfRounds < medianBudget, false),
    gate(ctx, 'tab-open-added-latency-p95', `Throttled (4x CPU) added latency, p95 (median of ${ROUNDS} rounds — superseded statistic, informational)`, throttledP95MedianOfRounds, throttledP95MedianOfRounds !== null && throttledP95MedianOfRounds < p95Budget, false),
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

    // M3 ratification (2026-10-11): the completion checks repeat in
    // ROUNDS rounds of 5 iterations, and a round counts only if every
    // counted iteration landed and closed its duplicate. Iteration 0
    // of rounds after the first is that round's warm-up (browser /
    // fixture re-warm after the previous round's tabs): it is run,
    // recorded, and excluded from the checks — the same discard the
    // latency batches apply to their first tab. Round 1 keeps the
    // historical strict behavior (its iteration 0 counted fully).
    // The timing gate uses the slowest counted sample across rounds.
    const ROUNDS = 3;
    const ITERATIONS = 5;
    const iterations = [];
    const roundSummaries = [];
    const samples = [];
    let swapCounter = 0;
    for (let r = 0; r < ROUNDS; r++) {
      const roundIterations = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const n = swapCounter++;
        const counted = !(r > 0 && i === 0);
        const url = ctx.fixture.url(`/swap/${n}`);
        const original = await openTabAndWait(cdp, url, { timeoutMs: 15_000 });
        if (original.outcome === 'timeout') {
          const entry = { round: r + 1, iteration: i, counted, error: 'original tab did not load' };
          iterations.push(entry);
          roundIterations.push(entry);
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
        const entry = {
          round: r + 1,
          iteration: i,
          counted,
          swapMs: landed,
          landed: landed !== null,
          duplicateGone: dupGone,
          pagesBefore,
          pagesAfter,
        };
        iterations.push(entry);
        roundIterations.push(entry);
        if (counted && landed !== null) samples.push(landed);
        ctx.log(`swap r${r + 1}/${i}: lastMs=${landed} duplicateGone=${dupGone}${counted ? '' : ' (round warm-up, not counted)'}`);
      }
      const countedIterations = roundIterations.filter((it) => it.counted);
      roundSummaries.push({
        round: r + 1,
        countedIterations: countedIterations.length,
        allLanded: countedIterations.every((it) => it.landed),
        allGone: countedIterations.every((it) => it.duplicateGone),
      });
    }

    const roundsLanded = roundSummaries.filter((s) => s.allLanded).length;
    const roundsGone = roundSummaries.filter((s) => s.allGone).length;
    const maxSample = samples.length ? Math.max(...samples) : null;
    result.measurements = {
      rounds: roundSummaries,
      iterations,
      samplesMs: samples,
      medianMs: round(median(samples)),
      maxMs: round(maxSample),
    };
    result.notes.push(
      `Completion checks run ${ROUNDS} rounds of ${ITERATIONS} iterations; iteration 0 of rounds 2–${ROUNDS} is a discarded round warm-up (recorded in measurements.iterations with counted=false). Timing gate: slowest counted sample across all rounds.`,
    );
    result.gates.push(
      gate(ctx, 'duplicate-focus-swap', `Swap sample landed in every counted iteration of all ${ROUNDS} rounds`, roundsLanded, roundsLanded === ROUNDS, true, `of ${ROUNDS} rounds`),
      gate(ctx, 'duplicate-focus-swap', `Duplicate target closed in every counted iteration of all ${ROUNDS} rounds`, roundsGone, roundsGone === ROUNDS, true, `of ${ROUNDS} rounds`),
      gate(ctx, 'duplicate-focus-swap', 'Slowest focus-swap (lastMs, counted samples)', maxSample, maxSample !== null && maxSample < budgetMs),
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
    const totalGrowthMB = totalGrowthKB !== null ? totalGrowthKB / KB : null;
    result.measurements = {
      warmupCycles,
      totalCycles,
      anchorOutcome: anchor.outcome,
      samples: points.map((p) => ({ cycles: p.cycles, heapMB: p.heapMB })),
      slopeKBPerCycle: round(slope, 5),
      totalGrowthKB: round(totalGrowthKB),
      totalGrowthMB: round(totalGrowthMB, 3),
    };
    result.notes.push(
      'Ratified churn gate (perf-budgets.json v2, user decision 2026-10-11): leak slope <= 0.03 KB/cycle AND total post-warm-up growth < 2 MB, as two explicit budget entries (memory-growth-5000-cycles-slope / -total). The slope bound is 2x the worst observed value (0.010–0.011 KB/cycle CI, ~0.015 KB/cycle local); observed total growth (~60 KB CI, +93 KB local) sits ~20x inside the total bound. This replaces the former "~zero slope" wording, which no real build could pass. Raw samples are reported above regardless of outcome; the gate is not tuned to the measurement.',
    );
    for (const check of churnChecks({ slopeKBPerCycle: slope, totalGrowthMB }, ctx.budgets)) {
      result.gates.push(
        gate(ctx, check.budgetId, check.label, check.measured, check.pass, specRun, check.unit),
      );
    }
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
