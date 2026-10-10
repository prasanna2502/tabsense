/**
 * Extension service-worker access for the perf harness.
 *
 * Diagnostics contract (implemented by the extension worker; this
 * harness codes against it exactly):
 *
 *   globalThis.__tabsensePerf() returns {
 *     version: 1, workerStartedAt: number,
 *     rebuildMs: number|null, coreReindexMs: number|null,
 *     indexSize: number, trackedTabs: number,
 *     dedupeCheck: { count, medianMs, p95Ms },
 *     swaps: { count, coldCount, medianMs, p95Ms, lastMs },
 *     autoCloseCount: number
 *   }
 *
 * The worker target is found via Target.getTargets: type ===
 * 'service_worker' and url starts with 'chrome-extension://'. This
 * Chromium ships a built-in component extension ("Contextual Tasks")
 * that matches the same rule, so candidates are disambiguated by
 * evaluating the manifest name in each candidate worker and picking
 * the one named "TabSense". Only a positively identified worker is
 * ever cached: during the first moments after launch the wrong
 * candidate can be the only visible one and early evaluations can
 * still return null, so a fallback is resolved fresh on every call
 * and getPerf tries every candidate until one answers.
 *
 * Heap sampling: the Performance domain and performance.memory are
 * NOT available on service-worker targets in this Chrome (verified:
 * 'Performance.enable' wasn't found; performance.memory ===
 * undefined; performance.measureMemory is not a function). The
 * worker's JS heap is therefore measured with a HeapProfiler heap
 * snapshot — the sum of node self_size values — which is the only
 * worker-scoped heap source CDP exposes here. Performance.getMetrics
 * (JSHeapUsedSize) and performance.memory are kept as fallbacks for
 * Chrome builds that do expose them on workers.
 */

import { sleep } from './cdp.mjs';
import { median } from './stats.mjs';

const PERF_EXPR = 'globalThis.__tabsensePerf ? globalThis.__tabsensePerf() : null';

/** cdp -> { targetId, sessionId, identifiedBy } — only ever holds a
 * positively identified TabSense worker (manifest name match, or a
 * session that actually answered __tabsensePerf()). A startup-race
 * fallback is NEVER cached: in the first moments after launch the
 * built-in "Contextual Tasks" worker can be the only visible
 * candidate and early evaluations can still return null, so caching
 * a fallback would pin every later call to the wrong worker. */
const workerCache = new WeakMap();

export async function findWorkerCandidates(cdp) {
  const targets = await cdp.getTargets();
  return targets.filter(
    (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
  );
}

async function evaluateOnSession(cdp, sessionId, expression) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (res.exceptionDetails) {
    throw new Error(
      `Runtime.evaluate exception: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`,
    );
  }
  return res.result?.value;
}

const MANIFEST_NAME_EXPR =
  'globalThis.chrome && chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().name : null';

/**
 * All current worker candidates with live sessions, ordered with a
 * manifest-identified TabSense worker first (when identification
 * succeeds — during the first moments after launch it can still
 * return null, in which case the raw target order is kept and
 * callers that poll will re-resolve on the next pass).
 */
async function listWorkerSessions(cdp) {
  const candidates = await findWorkerCandidates(cdp);
  const entries = [];
  for (const target of candidates) {
    const sessionId = await cdp.waitForSession(target.targetId, 5_000);
    if (!sessionId) continue;
    let name = null;
    try {
      name = await evaluateOnSession(cdp, sessionId, MANIFEST_NAME_EXPR);
    } catch {
      // Identification is best-effort; the entry stays usable.
    }
    entries.push({
      targetId: target.targetId,
      sessionId,
      url: target.url,
      name,
      identifiedBy: name === 'TabSense' ? 'manifest-name' : 'candidate',
    });
  }
  entries.sort((a, b) => (b.name === 'TabSense') - (a.name === 'TabSense'));
  return entries;
}

/**
 * Locate the TabSense service-worker session. A manifest-identified
 * result is cached per CDP connection; anything else is resolved
 * fresh on every call so a startup race cannot pin the wrong worker.
 * Pass { fresh: true } to bypass the cache (worker restarts produce
 * a new target/session).
 */
export async function getWorkerSession(cdp, { fresh = false } = {}) {
  if (!fresh && workerCache.has(cdp)) return workerCache.get(cdp);
  const entries = await listWorkerSessions(cdp);
  if (entries.length === 0) return null;
  const [first] = entries;
  if (first.name === 'TabSense') {
    workerCache.set(cdp, first);
    return first;
  }
  return { ...first, identifiedBy: 'first-candidate' };
}

/**
 * Call __tabsensePerf() in the worker. Returns the diagnostics object,
 * or null when the contract is absent. Tries every candidate worker
 * (TabSense-identified first) rather than trusting a single session,
 * and caches the session that actually answered.
 */
export async function getPerf(cdp) {
  const cached = workerCache.get(cdp);
  const entries = cached ? [cached] : await listWorkerSessions(cdp);
  for (const entry of entries) {
    try {
      const value = await evaluateOnSession(cdp, entry.sessionId, PERF_EXPR);
      if (value) {
        if (!workerCache.has(cdp)) {
          workerCache.set(cdp, { ...entry, identifiedBy: 'perf-response' });
        }
        return value;
      }
    } catch {
      // Dead session (worker restarted) — drop the cache and move on.
      if (cached && entry.sessionId === cached.sessionId) workerCache.delete(cdp);
    }
  }
  // No candidate answered. If we only tried the cached session,
  // re-resolve once in case the worker restarted under a new target.
  if (cached) {
    const freshEntries = await listWorkerSessions(cdp);
    for (const entry of freshEntries) {
      if (entry.sessionId === cached.sessionId) continue;
      try {
        const value = await evaluateOnSession(cdp, entry.sessionId, PERF_EXPR);
        if (value) {
          workerCache.set(cdp, { ...entry, identifiedBy: 'perf-response' });
          return value;
        }
      } catch {
        // Keep trying the remaining candidates.
      }
    }
  }
  return null;
}

/** Poll getPerf until it responds or the deadline passes. */
export async function waitForPerf(cdp, timeoutMs = 30_000, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const perf = await getPerf(cdp);
    if (perf) return perf;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** Poll a predicate over perf snapshots until it holds or times out. */
export async function waitForPerfField(cdp, predicate, timeoutMs = 60_000, pollMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await getPerf(cdp);
    if (last && predicate(last)) return last;
    if (Date.now() >= deadline) return last;
    await sleep(pollMs);
  }
}

// ------------------------------------------------------------------
// Worker JS-heap sampling
// ------------------------------------------------------------------

async function heapViaSnapshot(cdp, sessionId) {
  await cdp.send('HeapProfiler.enable', {}, sessionId);
  const chunks = [];
  let sawProgress = false;
  let progressDone = false;
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
      chunks.push(msg.params.chunk);
    } else if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress') {
      sawProgress = true;
      if (msg.params.done >= msg.params.total) progressDone = true;
    }
  });
  try {
    await cdp.send(
      'HeapProfiler.takeHeapSnapshot',
      { reportProgress: true, captureNumericValue: false },
      sessionId,
      60_000,
    );
    // Chunks stream in after the command resolves; wait for the
    // final progress event, then a short drain.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(sawProgress && progressDone)) {
      await sleep(50);
    }
    await sleep(150);
    const raw = chunks.join('');
    if (!raw) throw new Error('Heap snapshot produced no chunks');
    const snap = JSON.parse(raw);
    const meta = snap.snapshot.meta;
    const selfIdx = meta.node_fields.indexOf('self_size');
    const stride = meta.node_fields.length;
    const nodes = snap.nodes;
    let total = 0;
    for (let i = 0; i < nodes.length; i += stride) {
      total += nodes[i + selfIdx];
    }
    return total;
  } finally {
    off();
    await cdp.send('HeapProfiler.disable', {}, sessionId).catch(() => {});
  }
}

async function heapViaMetrics(cdp, sessionId) {
  await cdp.send('Performance.enable', {}, sessionId);
  const { metrics } = await cdp.send('Performance.getMetrics', {}, sessionId);
  const entry = (metrics ?? []).find((m) => m.name === 'JSHeapUsedSize');
  if (!entry) throw new Error('JSHeapUsedSize not in Performance.getMetrics');
  return entry.value;
}

async function heapViaPerformanceMemory(cdp, sessionId) {
  const value = await evaluateOnSession(
    cdp,
    sessionId,
    'globalThis.performance && performance.memory ? performance.memory.usedJSHeapSize : null',
  );
  if (typeof value !== 'number') throw new Error('performance.memory unavailable in worker');
  return value;
}

/**
 * One heap sample of the worker's JS heap, in bytes.
 * Method order: Performance.getMetrics (cheap, where available) →
 * performance.memory → HeapProfiler snapshot (works on this Chrome).
 * In practice the snapshot path is the one that runs here; it is
 * tried last only because it is the most expensive (~0.3–3 s).
 */
export async function sampleWorkerHeapBytes(cdp) {
  const worker = await getWorkerSession(cdp);
  if (!worker) throw new Error('TabSense service worker target not found');
  const errors = [];
  for (const [method, fn] of [
    ['Performance.getMetrics', heapViaMetrics],
    ['performance.memory', heapViaPerformanceMemory],
    ['HeapProfiler snapshot', heapViaSnapshot],
  ]) {
    try {
      const bytes = await fn(cdp, worker.sessionId);
      return { bytes, method };
    } catch (err) {
      errors.push(`${method}: ${err.message}`);
    }
  }
  throw new Error(`All worker heap sampling methods failed — ${errors.join('; ')}`);
}

/** Median of n heap samples (bytes), with the method that produced them. */
export async function sampleWorkerHeapMedian(cdp, { samples = 5, gapMs = 250 } = {}) {
  const values = [];
  let method = null;
  for (let i = 0; i < samples; i++) {
    const sample = await sampleWorkerHeapBytes(cdp);
    values.push(sample.bytes);
    method = sample.method;
    if (i < samples - 1) await sleep(gapMs);
  }
  return { bytes: median(values), values, method };
}

// ------------------------------------------------------------------
// Worker CPU profiling (idle scenario)
// ------------------------------------------------------------------

/**
 * Profile the worker for `windowMs` with the CDP Profiler domain and
 * report CPU-active time: total sampled time minus time attributed to
 * the "(idle)" node. The Performance domain (TaskDuration) is not
 * available on service-worker targets in this Chrome, so this is the
 * worker-scoped CPU measure; see the idle scenario notes.
 */
export async function measureWorkerCpu(cdp, windowMs) {
  const worker = await getWorkerSession(cdp);
  if (!worker) throw new Error('TabSense service worker target not found');
  const { sessionId } = worker;
  await cdp.send('Profiler.enable', {}, sessionId);
  try {
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 }, sessionId).catch(() => {});
    await cdp.send('Profiler.start', {}, sessionId);
    await sleep(windowMs);
    const { profile } = await cdp.send('Profiler.stop', {}, sessionId, 30_000);
    const nodeById = new Map((profile.nodes ?? []).map((n) => [n.id, n]));
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    let activeUs = 0;
    let idleUs = 0;
    for (let i = 0; i < samples.length; i++) {
      const node = nodeById.get(samples[i]);
      const fnName = node?.callFrame?.functionName ?? '';
      const delta = deltas[i] ?? 0;
      if (fnName === '(idle)') idleUs += delta;
      else activeUs += delta;
    }
    return {
      activeSec: activeUs / 1e6,
      idleSec: idleUs / 1e6,
      totalSec: (activeUs + idleUs) / 1e6,
      sampleCount: samples.length,
    };
  } finally {
    await cdp.send('Profiler.disable', {}, sessionId).catch(() => {});
  }
}

/** TaskDuration (seconds) from a page session's Performance metrics. */
export async function pageTaskDuration(cdp, sessionId) {
  await cdp.send('Performance.enable', {}, sessionId).catch(() => {});
  const { metrics } = await cdp.send('Performance.getMetrics', {}, sessionId);
  const entry = (metrics ?? []).find((m) => m.name === 'TaskDuration');
  return entry ? entry.value : null;
}
