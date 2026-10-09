import { summarizeDuplicates, type DuplicateSummary } from './duplicates';

/** One open tab, as shown in the side panel. */
export interface TabInfo {
  id: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
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
  /**
   * Normalization of the first tab's URL produced by whichever engine
   * answered (Wasm core preferred, TS fallback otherwise). Diagnostic
   * proof that the core is actually being invoked from the worker.
   */
  normalizedSample: { url: string; normalized: string; engine: 'wasm' | 'fallback' } | null;
}

export const SNAPSHOT_KEY = 'tabSnapshot';

export const GET_SNAPSHOT_MESSAGE = 'tabs:get-snapshot';
