import { defineBackground } from 'wxt/utils/define-background';
import { summarizeDuplicates } from '../src/lib/duplicates';
import {
  GET_SNAPSHOT_MESSAGE,
  SNAPSHOT_KEY,
  type TabInfo,
  type TabSnapshot,
} from '../src/lib/snapshot';
import { ensureCoreReady, isCoreReady, normalizeUrl } from '../src/wasm/load';

/**
 * Background service worker (M0 walking skeleton).
 *
 * Responsibilities today — deliberately minimal:
 *  - Warm up the Rust/Wasm core (async, non-blocking).
 *  - Track open tabs and keep a live snapshot in chrome.storage.local
 *    for the side panel: the tab list plus the exact-URL duplicate count.
 *  - Open the side panel when the toolbar action is clicked.
 *
 * No duplicate closing, no grouping, no AI yet — those are M1/M2.
 */
export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[tabsense] setPanelBehavior failed:', err));

  // Kick off Wasm instantiation during warm-up; refresh the snapshot once
  // the core lands so the panel can show the engine flip to "wasm".
  void ensureCoreReady().then(() => void refreshSnapshot());

  let current: TabSnapshot = {
    updatedAt: 0,
    tabs: [],
    duplicates: { totalTabs: 0, uniqueUrls: 0, duplicateTabs: 0, groups: [] },
    wasmReady: false,
    normalizedSample: null,
  };

  async function refreshSnapshot(): Promise<void> {
    try {
      const rawTabs = await chrome.tabs.query({});
      const tabs: TabInfo[] = rawTabs
        .filter((t) => t.id !== undefined)
        .map((t) => ({
          id: t.id as number,
          windowId: t.windowId,
          title: t.title ?? '',
          url: t.url ?? t.pendingUrl ?? '',
          active: t.active,
          pinned: t.pinned,
        }));
      const firstUrl = tabs.find((t) => t.url)?.url;
      current = {
        updatedAt: Date.now(),
        tabs,
        duplicates: summarizeDuplicates(tabs.map((t) => t.url)),
        wasmReady: isCoreReady(),
        normalizedSample: firstUrl
          ? { url: firstUrl, ...normalizeUrl(firstUrl) }
          : null,
      };
      await chrome.storage.local.set({ [SNAPSHOT_KEY]: current });
    } catch (err) {
      console.warn('[tabsense] snapshot refresh failed:', err);
    }
  }

  // Event-driven only (perf constitution §10.1 rule 5): no polling.
  chrome.tabs.onCreated.addListener(() => void refreshSnapshot());
  chrome.tabs.onRemoved.addListener(() => void refreshSnapshot());
  chrome.tabs.onUpdated.addListener(() => void refreshSnapshot());
  chrome.tabs.onAttached.addListener(() => void refreshSnapshot());
  chrome.tabs.onDetached.addListener(() => void refreshSnapshot());

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === GET_SNAPSHOT_MESSAGE) {
      // Refresh first so a just-woken worker answers with fresh state.
      void refreshSnapshot().then(() => sendResponse(current));
      return true; // async response
    }
    return undefined;
  });

  void refreshSnapshot();
});
