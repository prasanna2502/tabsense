import { summarizeDuplicates, type DuplicateSummary } from './duplicates';

/** One open tab, as shown in the side panel. */
export interface TabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  /** M1 canonicalizer keys for this tab's URL; null for tabs the
   * dedupe engine excludes (pinned, browser pages, extension pages,
   * tabs without a committed http(s) URL). */
  exactKey: string | null;
  fuzzyKey: string | null;
  /** When the engine first saw this tab (worker start for
   * pre-existing tabs, event time for observed ones); null if the
   * engine has no record. Drives "keep newest" ordering. */
  firstSeenAt: number | null;
  /** The tab's favicon URL from chrome.tabs ("" when the tab has
   * none). Display only — the panel falls back to a letter tile. */
  favIconUrl: string;
}

/** One activity-log entry: a duplicate tab that was closed, kept so
 * a wanted copy is always recoverable from the panel. */
export interface ActivityEntry {
  id: string;
  url: string;
  title: string;
  closedTabId: number;
  keptTabId: number;
  closedAt: number;
  reason: 'auto-close' | 'bulk-close';
}

/** One focus-swap timing sample, measured in the worker from the
 * tab-created/updated event to activation completion. */
export interface SwapSample {
  ms: number;
  /** True when the event arrived while the Wasm core was still
   * instantiating (cold worker) and the decision was re-evaluated
   * once the core was ready. */
  cold: boolean;
  at: number;
}

export interface SwapStats {
  count: number;
  coldCount: number;
  warmCount: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export function summarizeSwaps(samples: readonly SwapSample[]): SwapStats {
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const p95 =
    sorted.length === 0
      ? null
      : sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return {
    count: samples.length,
    coldCount: samples.filter((s) => s.cold).length,
    warmCount: samples.filter((s) => !s.cold).length,
    medianMs: median,
    p95Ms: p95,
  };
}

/**
 * The full tab snapshot the background worker maintains and the side panel
 * renders. Stored in chrome.storage.local under SNAPSHOT_KEY so the panel
 * updates live via storage.onChanged even if it opened before the worker.
 */
export interface TabSnapshot {
  /** Epoch ms of the last refresh. */
  updatedAt: number;
  tabs: TabInfo[];
  duplicates: DuplicateSummary;
  /** True once the Rust/Wasm core has instantiated in the worker. */
  wasmReady: boolean;
  /** Wasm core lifecycle (M1): auto-close decisions happen only in
   * `ready`; `failed` means permanent no-auto-close mode. */
  coreState: 'pending' | 'ready' | 'failed';
  /** Whether exact-duplicate auto-close is enabled (settings). */
  autoCloseEnabled: boolean;
  /**
   * Normalization of the first tab's URL produced by whichever engine
   * answered (Wasm core preferred, TS fallback otherwise). Diagnostic
   * proof that the core is actually being invoked from the worker.
   */
  normalizedSample: { url: string; normalized: string; engine: 'wasm' | 'fallback' } | null;
  /** Most recent activity-log entries, newest first (display cap). */
  activity: ActivityEntry[];
  /** Focus-swap timing stats over the persisted sample ring. */
  swaps: SwapStats;
}

export const SNAPSHOT_KEY = 'tabSnapshot';
export const ACTIVITY_KEY = 'activityLog';
export const SWAP_SAMPLES_KEY = 'swapSamples';
export const SETTINGS_KEY = 'autoCloseEnabled';

/** Persisted-ring bounds (perf constitution: storage writes are
 * capped, and never happen on the tab-open hot path — activity and
 * swap writes trail a close that already happened). */
export const ACTIVITY_CAP = 100;
export const SWAP_SAMPLES_CAP = 100;

export const GET_SNAPSHOT_MESSAGE = 'tabs:get-snapshot';
export const CLOSE_DUPLICATE_SET_MESSAGE = 'tabs:close-duplicate-set';
export const CLOSE_ALL_DUPLICATES_MESSAGE = 'tabs:close-all-duplicates';
export const SET_AUTO_CLOSE_MESSAGE = 'settings:set-auto-close';

/**
 * Whether a tab is outside the dedupe engine's scope: pinned tabs are
 * excluded entirely (plan default A3 — never closed, never counted as
 * duplicates, never the "existing" target), as are browser pages
 * (chrome:// …), the new-tab page (chrome://newtab / about:*), the
 * extension's own pages, and tabs without a committed URL.
 */
export function isExcludedTab(tab: {
  pinned?: boolean;
  url?: string;
  pendingUrl?: string;
}): boolean {
  if (tab.pinned) return true;
  const url = tab.url || tab.pendingUrl || '';
  if (url === '') return true;
  if (!/^https?:\/\//i.test(url)) return true;
  const ownId =
    typeof chrome !== 'undefined' ? chrome.runtime?.id : undefined;
  if (ownId && url.startsWith(`chrome-extension://${ownId}/`)) return true;
  return false;
}
