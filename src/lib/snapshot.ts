import type { LadderRung } from './breaker';
import type { DiagnosticsView } from './diagnostics';
import { summarizeDuplicates, type DuplicateSummary } from './duplicates';
import type { NanoAvailability } from './nano';
import type { ProviderChoice, SettingSource } from './settings';
import type { SuggestionKind, SuggestionSource } from './suggestions';

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
  /** When the tab was last accessed (epoch ms, from chrome.tabs),
   * or null when Chrome reports none. Display only — it drives the
   * "Last used …" line on compact member rows (M1.2). */
  lastAccessed: number | null;
  /** Chrome group ID this tab belongs to, or -1 when ungrouped
   * (M2). A tab in ANY group is hands-off for grouping. */
  groupId: number;
}

/** One activity-log entry. Close entries (M1) record a duplicate
 * tab that was closed, kept so a wanted copy is always recoverable.
 * Grouping entries (M2) record a suggestion decision — accept,
 * dismiss, undo — with the group name in `title`; they never appear
 * in Recently closed (the panel filters on the close reasons). */
export interface ActivityEntry {
  id: string;
  url: string;
  title: string;
  closedTabId: number;
  keptTabId: number;
  closedAt: number;
  reason:
    | 'auto-close'
    | 'bulk-close'
    | 'group-accept'
    | 'group-dismiss'
    | 'group-undo';
}

/** One grouping activity entry in the dedicated grouping log (M2):
 * the full record of a suggestion decision. */
export interface GroupActivityEntry {
  id: string;
  at: number;
  action: 'accept' | 'dismiss' | 'undo';
  kind: SuggestionKind;
  /** Group name (target group or the new group's name). */
  groupName: string;
  tabIds: number[];
  tabTitles: string[];
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
  /** M2: the current suggestion inbox (Suggest mode — nothing is
   * applied until the user accepts from the panel). */
  suggestions: Suggestion[];
  /** M2: grouping ladder state for the passive status line. */
  grouping: GroupingStatus;
  /** M2: the user's TabSense groups in this snapshot's windows, for
   * the reassign picker. Manual groups are never listed. */
  groupOptions: GroupOption[];
  /** M2: effective settings + provenance, so the panel can render
   * values and "Managed by your organization" labels. */
  settingsView: SettingsView;
  /** M2: the most recent accepted grouping action, while undo is
   * offered for it in the panel. */
  lastGroupAction: { description: string; at: number } | null;
  /** M3: locally measured overhead (self-diagnostics, §10.3) —
   * rendered in Settings & details; never transmitted. Optional
   * because snapshots persisted before M3 do not carry it. */
  diagnostics?: DiagnosticsView;
}

/** One suggestion in the panel inbox (M2). Mirrors the worker's
 * persisted SuggestionDraft plus its stable ID and tab display refs. */
export interface Suggestion {
  id: string;
  kind: SuggestionKind;
  windowId: number;
  tabIds: number[];
  tabs: { tabId: number; title: string; url: string }[];
  targetGroupKey: string | null;
  targetGroupName: string | null;
  proposedName: string | null;
  confidence: number;
  source: SuggestionSource;
  nanoFallback: boolean;
  createdAt: number;
}

/** Grouping ladder state for the passive status line (§11:
 * transparency without nagging — panel only, never a pop-up). */
export interface GroupingStatus {
  rung: LadderRung;
  nanoAvailability: NanoAvailability | 'unknown';
  pausedByUser: boolean;
  /** Epoch ms of the last completed grouping pass, or null. */
  lastRunAt: number | null;
}

export interface GroupOption {
  groupKey: string;
  name: string;
  memberCount: number;
  windowId: number;
}

export interface SettingsView {
  autoCloseEnabled: boolean;
  groupingPaused: boolean;
  provider: ProviderChoice;
  /** The blocklist in force (defaults resolved). */
  blocklist: string[];
  sources: {
    autoCloseEnabled: SettingSource;
    groupingPaused: SettingSource;
    provider: SettingSource;
    blocklist: SettingSource;
  };
  managedKeys: string[];
}

export const SNAPSHOT_KEY = 'tabSnapshot';
export const ACTIVITY_KEY = 'activityLog';
export const SWAP_SAMPLES_KEY = 'swapSamples';
export const SETTINGS_KEY = 'autoCloseEnabled';

/** M2 grouping state keys (chrome.storage.local). */
export const SUGGESTIONS_KEY = 'suggestions';
export const GROUPS_KEY = 'tabSenseGroups';
export const DISMISSED_KEY = 'dismissedSuggestions';
export const GROUP_ACTIVITY_KEY = 'groupActivity';
export const LAST_ACTION_KEY = 'lastGroupAction';

/** Capped ring for the grouping activity log (same discipline as
 * the close log: bounded storage, writes trail user actions). */
export const GROUP_ACTIVITY_CAP = 100;

/** Persisted-ring bounds (perf constitution: storage writes are
 * capped, and never happen on the tab-open hot path — activity and
 * swap writes trail a close that already happened). */
export const ACTIVITY_CAP = 100;
export const SWAP_SAMPLES_CAP = 100;

/** Prepend-and-cap: the ring discipline of the activity logs
 * (newest first, oldest evicted past the cap). Extracted as a pure
 * helper in M3 so the cap behavior is unit-testable rather than
 * only inspected in the worker. */
export function appendCapped<T>(
  list: readonly T[],
  entry: T,
  cap: number,
): T[] {
  return [entry, ...list].slice(0, cap);
}

/** Append-and-cap: the ring discipline of the swap samples
 * (chronological order, oldest evicted past the cap). */
export function pushCapped<T>(
  list: readonly T[],
  entry: T,
  cap: number,
): T[] {
  return [...list, entry].slice(-cap);
}

export const GET_SNAPSHOT_MESSAGE = 'tabs:get-snapshot';
export const CLOSE_DUPLICATE_SET_MESSAGE = 'tabs:close-duplicate-set';
export const CLOSE_ALL_DUPLICATES_MESSAGE = 'tabs:close-all-duplicates';
export const CLOSE_SIMILAR_SET_MESSAGE = 'tabs:close-similar-set';
export const SET_AUTO_CLOSE_MESSAGE = 'settings:set-auto-close';

/** M2 suggestion-inbox messages (panel → worker). Accept carries
 * the user's final tab selection and target override (reassign /
 * new-group); the worker re-validates everything against live state
 * before applying, exactly like the M1 close actions. */
export const ACCEPT_SUGGESTION_MESSAGE = 'suggestions:accept';
export const DISMISS_SUGGESTION_MESSAGE = 'suggestions:dismiss';
export const UNDO_GROUP_ACTION_MESSAGE = 'suggestions:undo';
export const SET_GROUPING_PAUSED_MESSAGE = 'settings:set-grouping-paused';
export const SET_PROVIDER_MESSAGE = 'settings:set-provider';
export const SET_BLOCKLIST_MESSAGE = 'settings:set-blocklist';

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
