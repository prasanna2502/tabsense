/**
 * Self-diagnostics (M3, proposal §10.3): the extension's locally
 * measured overhead, shown in Settings & details so a user can
 * verify the "never slow down tab opening" promise on their own
 * machine. Everything here is measured in the worker, kept in
 * memory (plus the already-persisted swap-sample ring), and never
 * transmitted anywhere — the project has no telemetry, by design.
 *
 * The same view is exposed to the perf harness as
 * `globalThis.__tabsensePerf()` in the worker (see
 * entrypoints/background.ts) — one measurement source for the
 * settings UI and the CI gate, so the two can never disagree.
 */

export interface DurationStats {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  lastMs: number | null;
}

/** Median + p95 over a sample list (insertion order preserved for
 * `lastMs`). Pure; shared by the ring below and the view builder. */
export function summarizeDurations(
  samples: readonly number[],
): DurationStats {
  if (samples.length === 0) {
    return { count: 0, medianMs: null, p95Ms: null, lastMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const p95 =
    sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return {
    count: samples.length,
    medianMs: median,
    p95Ms: p95,
    lastMs: samples[samples.length - 1],
  };
}

/** Bounded ring of duration samples (ms). The cap is the perf
 * constitution applied to the instrumentation itself: measuring
 * must never become a growth structure. */
export class DurationRing {
  readonly values: number[] = [];

  constructor(readonly cap = 200) {}

  push(ms: number): void {
    this.values.push(ms);
    if (this.values.length > this.cap) {
      this.values.splice(0, this.values.length - this.cap);
    }
  }

  stats(): DurationStats {
    return summarizeDurations(this.values);
  }
}

/** The diagnostics view carried in the tab snapshot and returned by
 * `__tabsensePerf()`. All durations are milliseconds measured with
 * performance.now() in the worker, except swap samples, which the
 * M1 engine already records end-to-end (event → activation done). */
export interface DiagnosticsView {
  /** Worker script start (this worker instance). */
  workerStartedAt: number;
  /** Time to index the pre-existing tab set at worker start — the
   * "duplicate index rebuild" budget measures exactly this. */
  rebuildMs: number | null;
  /** Time to re-index with the Wasm core once it lands (parity
   * rebuild; reported for transparency, not a budget line). */
  coreReindexMs: number | null;
  /** Live duplicate-index size (distinct exact keys). */
  indexSize: number;
  /** Tabs currently tracked by the worker. */
  trackedTabs: number;
  /** Canonical-key compute + index update per tab event. */
  dedupeCheck: DurationStats;
  /** Focus-swap durations (same samples as the persisted ring). */
  swaps: {
    count: number;
    coldCount: number;
    warmCount: number;
    medianMs: number | null;
    p95Ms: number | null;
    lastMs: number | null;
  };
  /** Duplicates auto-closed by this worker instance. The restore
   * storm gate asserts this stays 0 across a session restore. */
  autoCloseCount: number;
  /** chrome.storage.local bytes in use (all TabSense keys), or
   * null until the first throttled read lands. */
  storageBytes: number | null;
  /** Worker JS heap in MB (performance.memory), where available. */
  heapUsedMb: number | null;
}

/** Round for display: sub-0.1 ms values are the common case on the
 * dedupe path, so keep two significant decimals under 10 ms. */
export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 10) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
