import { defineBackground } from 'wxt/utils/define-background';
import { BRANDING } from '../src/config/branding';
import {
  countExtraCopies,
  findExactDuplicateSets,
  planBulkClose,
  summarizeDuplicates,
  type KeyedTab,
} from '../src/lib/duplicates';
import {
  ACTIVITY_CAP,
  ACTIVITY_KEY,
  CLOSE_ALL_DUPLICATES_MESSAGE,
  CLOSE_DUPLICATE_SET_MESSAGE,
  GET_SNAPSHOT_MESSAGE,
  SETTINGS_KEY,
  SET_AUTO_CLOSE_MESSAGE,
  SNAPSHOT_KEY,
  SWAP_SAMPLES_CAP,
  SWAP_SAMPLES_KEY,
  isExcludedTab,
  summarizeSwaps,
  type ActivityEntry,
  type SwapSample,
  type TabInfo,
  type TabSnapshot,
} from '../src/lib/snapshot';
import {
  canonicalKeys,
  ensureCoreReady,
  getCoreState,
  isCoreReady,
  normalizeUrl,
} from '../src/wasm/load';

/**
 * Background service worker.
 *
 * M0: warms the Rust/Wasm core, keeps a live tab snapshot in
 * chrome.storage.local for the side panel, opens the panel on
 * toolbar-action click.
 *
 * M1: the duplicate engine. It maintains an in-memory index
 * exactKey → tabs and, when a tab this worker instance observed being
 * created or navigated lands on an exactKey that is already open,
 * focuses the existing tab and closes the duplicate (silently, per
 * the product decision), appending a recoverable entry to the
 * activity log.
 *
 * Trust rules (execution plan §M1):
 *  - Only exactKey collisions auto-close. Fuzzy matches never close.
 *  - Tabs that already existed when this worker started are indexed
 *    (so they can be the "existing" tab) but never auto-closed —
 *    auto-close applies only to creations/navigations this worker
 *    observed. Pre-existing duplicate sets are surfaced in the panel
 *    for manual bulk-close instead.
 *  - Pinned tabs are excluded entirely (plan default A3): never
 *    closed, never counted, never the focus target. Browser pages,
 *    the new-tab page, and the extension's own pages are excluded too.
 *  - Cold-worker rule: while the Wasm core is still instantiating no
 *    auto-close decision is taken — the event queues and is
 *    re-evaluated once the core is ready. If the core fails to load,
 *    the engine stays in no-auto-close mode and the panel shows it.
 *  - Hot path: canonical key computation + Map lookups only. No
 *    storage writes until after a close has happened (activity-log
 *    append and swap-sample persist trail the close, chained).
 *
 * M1.1: the toolbar badge. Chrome cannot open the side panel on a
 * background detection event, so the badge is the ambient prompt:
 * it shows the number of extra exact-duplicate copies waiting for
 * review, derived from the same live index and set builder the
 * panel uses (the two numbers always agree). Action APIs are only
 * called when the computed badge state actually changes.
 */

interface TrackedTab {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  exactKey: string | null;
  fuzzyKey: string | null;
  firstSeenAt: number;
  /** True once this worker run has observed the tab's creation or a
   * navigation — the gate for auto-close eligibility. */
  observed: boolean;
  excluded: boolean;
}

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[tabsense] setPanelBehavior failed:', err));

  const liveTabs = new Map<number, TrackedTab>();
  const exactIndex = new Map<string, Set<number>>();
  /** Events that arrived while the Wasm core was instantiating. */
  const pendingQueue: Array<{ tabId: number; eventAt: number }> = [];

  let initialized = false;
  let autoCloseEnabled = true;
  let activity: ActivityEntry[] = [];
  let swapSamples: SwapSample[] = [];

  // ------------------------------------------------------------------
  // Index bookkeeping
  // ------------------------------------------------------------------

  function indexAdd(t: TrackedTab): void {
    if (t.exactKey === null) return;
    let set = exactIndex.get(t.exactKey);
    if (!set) {
      set = new Set();
      exactIndex.set(t.exactKey, set);
    }
    set.add(t.tabId);
  }

  function indexRemove(t: TrackedTab): void {
    if (t.exactKey === null) return;
    const set = exactIndex.get(t.exactKey);
    if (!set) return;
    set.delete(t.tabId);
    if (set.size === 0) exactIndex.delete(t.exactKey);
  }

  /**
   * Track (or re-track) a tab. `observed` marks creations/navigations
   * seen by this worker run; events arriving before init completes
   * are treated as the startup set (session restore storms are not
   * "observed" — those tabs are indexed but never auto-closed).
   */
  function trackTab(tab: chrome.tabs.Tab, observed: boolean): TrackedTab | null {
    if (tab.id === undefined) return null;
    const url = tab.url ?? tab.pendingUrl ?? '';
    const excluded = isExcludedTab(tab);
    const observedNow = initialized && observed;
    const previous = liveTabs.get(tab.id);
    if (previous && previous.url === url && previous.excluded === excluded) {
      previous.title = tab.title ?? previous.title;
      previous.windowId = tab.windowId;
      previous.observed = previous.observed || observedNow;
      return previous;
    }
    if (previous) indexRemove(previous);
    const keys =
      !excluded && url !== '' ? canonicalKeys(url).keys : null;
    const tracked: TrackedTab = {
      tabId: tab.id,
      windowId: tab.windowId,
      url,
      title: tab.title ?? previous?.title ?? '',
      exactKey: keys?.exactKey ?? null,
      fuzzyKey: keys?.fuzzyKey ?? null,
      firstSeenAt: previous?.firstSeenAt ?? Date.now(),
      observed: (previous?.observed ?? false) || observedNow,
      excluded,
    };
    liveTabs.set(tab.id, tracked);
    indexAdd(tracked);
    return tracked;
  }

  function untrackTab(tabId: number): void {
    const previous = liveTabs.get(tabId);
    if (previous) indexRemove(previous);
    liveTabs.delete(tabId);
  }

  // ------------------------------------------------------------------
  // Persisted rings (activity log + swap samples). Writes are chained
  // and always trail a close — never on the tab-open path.
  // ------------------------------------------------------------------

  let activityWrite: Promise<void> = Promise.resolve();
  function appendActivity(entry: ActivityEntry): void {
    activity = [entry, ...activity].slice(0, ACTIVITY_CAP);
    const toStore = activity;
    activityWrite = activityWrite
      .then(() => chrome.storage.local.set({ [ACTIVITY_KEY]: toStore }))
      .catch((err) => console.warn('[tabsense] activity persist failed:', err));
  }

  let swapWrite: Promise<void> = Promise.resolve();
  function recordSwap(sample: SwapSample): void {
    swapSamples = [...swapSamples, sample].slice(-SWAP_SAMPLES_CAP);
    const toStore = swapSamples;
    swapWrite = swapWrite
      .then(() => chrome.storage.local.set({ [SWAP_SAMPLES_KEY]: toStore }))
      .catch((err) => console.warn('[tabsense] swap persist failed:', err));
  }

  // ------------------------------------------------------------------
  // The dedupe decision
  // ------------------------------------------------------------------

  async function evaluateDuplicate(
    tabId: number,
    eventAt: number,
    cold: boolean,
  ): Promise<void> {
    const state = getCoreState();
    if (state === 'pending') {
      pendingQueue.push({ tabId, eventAt });
      return;
    }
    if (state === 'failed' || !autoCloseEnabled) return;
    const dup = liveTabs.get(tabId);
    if (!dup || dup.excluded || dup.exactKey === null || !dup.observed) return;
    const set = exactIndex.get(dup.exactKey);
    if (!set || set.size < 2) return;
    // The existing tab is the earliest-seen other member of the set.
    let existing: TrackedTab | null = null;
    for (const id of set) {
      if (id === tabId) continue;
      const candidate = liveTabs.get(id);
      if (!candidate || candidate.excluded) continue;
      if (!existing || candidate.firstSeenAt < existing.firstSeenAt) {
        existing = candidate;
      }
    }
    if (!existing) return;
    await focusExistingAndCloseDuplicate(existing, dup, eventAt, cold);
  }

  async function focusExistingAndCloseDuplicate(
    existing: TrackedTab,
    dup: TrackedTab,
    eventAt: number,
    cold: boolean,
  ): Promise<void> {
    try {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId !== dup.windowId) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
    } catch {
      // The existing tab vanished mid-swap — close nothing.
      return;
    }
    const doneAt = Date.now();
    recordSwap({ ms: doneAt - eventAt, cold, at: doneAt });
    try {
      await chrome.tabs.remove(dup.tabId);
    } catch {
      // Already gone (user closed it first) — nothing to log.
      return;
    }
    appendActivity({
      id: `${doneAt}-${dup.tabId}`,
      url: dup.url,
      title: dup.title,
      closedTabId: dup.tabId,
      keptTabId: existing.tabId,
      closedAt: doneAt,
      reason: 'auto-close',
    });
    void refreshSnapshot();
  }

  /**
   * Panel-initiated bulk close of one exact duplicate set. The worker
   * re-validates against its live index: the keep tab must currently
   * be a member of the set, and only current members are closed.
   * User-initiated, so it is not gated on the Wasm core state (keys
   * are parity-identical either way) — but excluded tabs are never in
   * the index, so they can never be closed here.
   */
  async function closeDuplicateSet(
    exactKey: string,
    keepTabId: number,
  ): Promise<{ closed: number }> {
    const set = exactIndex.get(exactKey);
    if (!set || !set.has(keepTabId)) return { closed: 0 };
    let closed = 0;
    for (const id of [...set]) {
      if (id === keepTabId) continue;
      const t = liveTabs.get(id);
      if (!t || t.excluded) continue;
      try {
        await chrome.tabs.remove(id);
        closed++;
        appendActivity({
          id: `${Date.now()}-${id}`,
          url: t.url,
          title: t.title,
          closedTabId: id,
          keptTabId: keepTabId,
          closedAt: Date.now(),
          reason: 'bulk-close',
        });
      } catch {
        // Tab disappeared between validation and close — skip it.
      }
    }
    void refreshSnapshot();
    return { closed };
  }

  /** The live tabs in the key-bearing shape the set builders use —
   * the single derivation shared by the global close, the badge, and
   * (via the snapshot) the panel, so all three always agree. */
  function liveKeyedTabs(): KeyedTab[] {
    return [...liveTabs.values()]
      .filter((t) => !t.excluded)
      .map((t) => ({
        id: t.tabId,
        exactKey: t.exactKey,
        fuzzyKey: t.fuzzyKey,
        firstSeenAt: t.firstSeenAt,
      }));
  }

  /**
   * Panel-initiated "close all extra copies" (M1.1). Plans from the
   * live index at click time (never from the panel's possibly stale
   * snapshot), keeps each set's newest tab, and re-validates every
   * tab — still tracked, not excluded, still under the planned key —
   * immediately before closing it. Exact tier only; fuzzy sets are
   * never touched here.
   */
  async function closeAllDuplicateExtras(): Promise<{ closed: number }> {
    const plans = planBulkClose(findExactDuplicateSets(liveKeyedTabs()));
    let closed = 0;
    for (const plan of plans) {
      for (const id of plan.closeTabIds) {
        const t = liveTabs.get(id);
        if (!t || t.excluded || t.exactKey !== plan.exactKey) continue;
        try {
          await chrome.tabs.remove(id);
          closed++;
          appendActivity({
            id: `${Date.now()}-${id}`,
            url: t.url,
            title: t.title,
            closedTabId: id,
            keptTabId: plan.keepTabId,
            closedAt: Date.now(),
            reason: 'bulk-close',
          });
        } catch {
          // Tab disappeared between planning and close — skip it.
        }
      }
    }
    void refreshSnapshot();
    return { closed };
  }

  // ------------------------------------------------------------------
  // Toolbar badge (M1.1) — the ambient prompt Chrome allows
  // ------------------------------------------------------------------

  const BADGE_COLOR = '#b3261e';
  let lastBadgeState: string | null = null;

  /** Recompute the badge from the live exact index and push it to
   * the toolbar — but only when it changed, so tab-event snapshot
   * refreshes don't churn the action APIs. */
  function updateBadge(): void {
    const extraCount = countExtraCopies(
      findExactDuplicateSets(liveKeyedTabs()),
    );
    const text = extraCount === 0 ? '' : extraCount > 99 ? '99+' : String(extraCount);
    const title =
      extraCount === 0
        ? BRANDING.productName
        : `${BRANDING.productName} — ${extraCount} duplicate ${extraCount === 1 ? 'tab' : 'tabs'} can be closed. Click to review.`;
    const state = `${text}|${title}`;
    if (state === lastBadgeState) return;
    lastBadgeState = state;
    try {
      void chrome.action.setBadgeText({ text });
      if (text !== '') {
        void chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
      }
      void chrome.action.setTitle({ title });
    } catch (err) {
      console.warn('[tabsense] badge update failed:', err);
    }
  }

  // ------------------------------------------------------------------
  // Snapshot (the panel contract)
  // ------------------------------------------------------------------

  let current: TabSnapshot = {
    updatedAt: 0,
    tabs: [],
    duplicates: { totalTabs: 0, uniqueUrls: 0, duplicateTabs: 0, groups: [] },
    wasmReady: false,
    coreState: 'pending',
    autoCloseEnabled: true,
    normalizedSample: null,
    activity: [],
    swaps: { count: 0, coldCount: 0, warmCount: 0, medianMs: null, p95Ms: null },
  };

  async function refreshSnapshot(): Promise<void> {
    try {
      const rawTabs = await chrome.tabs.query({});
      const tabs: TabInfo[] = rawTabs
        .filter((t) => t.id !== undefined)
        .map((t) => {
          const url = t.url ?? t.pendingUrl ?? '';
          const tracked = liveTabs.get(t.id as number);
          let exactKey: string | null = null;
          let fuzzyKey: string | null = null;
          if (!isExcludedTab(t) && url !== '') {
            if (tracked && tracked.url === url) {
              exactKey = tracked.exactKey;
              fuzzyKey = tracked.fuzzyKey;
            } else {
              const { keys } = canonicalKeys(url);
              exactKey = keys.exactKey;
              fuzzyKey = keys.fuzzyKey;
            }
          }
          return {
            id: t.id as number,
            windowId: t.windowId,
            title: t.title ?? '',
            url,
            active: t.active,
            pinned: t.pinned,
            exactKey,
            fuzzyKey,
            firstSeenAt: tracked?.firstSeenAt ?? null,
            favIconUrl: t.favIconUrl ?? '',
          };
        });
      const firstUrl = tabs.find((t) => t.url)?.url;
      current = {
        updatedAt: Date.now(),
        tabs,
        duplicates: summarizeDuplicates(tabs.map((t) => t.url)),
        wasmReady: isCoreReady(),
        coreState: getCoreState(),
        autoCloseEnabled,
        normalizedSample: firstUrl
          ? { url: firstUrl, ...normalizeUrl(firstUrl) }
          : null,
        activity: activity.slice(0, 15),
        swaps: summarizeSwaps(swapSamples),
      };
      await chrome.storage.local.set({ [SNAPSHOT_KEY]: current });
    } catch (err) {
      console.warn('[tabsense] snapshot refresh failed:', err);
    }
    // The badge derives from the live index, not the snapshot, so it
    // stays correct even if this refresh failed partway.
    updateBadge();
  }

  // ------------------------------------------------------------------
  // Startup: load persisted state, index pre-existing tabs (never
  // auto-close them), warm the Wasm core.
  // ------------------------------------------------------------------

  async function init(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get([
        ACTIVITY_KEY,
        SWAP_SAMPLES_KEY,
        SETTINGS_KEY,
      ]);
      if (Array.isArray(stored[ACTIVITY_KEY])) {
        activity = stored[ACTIVITY_KEY] as ActivityEntry[];
      }
      if (Array.isArray(stored[SWAP_SAMPLES_KEY])) {
        swapSamples = stored[SWAP_SAMPLES_KEY] as SwapSample[];
      }
      autoCloseEnabled = stored[SETTINGS_KEY] !== false;
    } catch (err) {
      console.warn('[tabsense] state load failed:', err);
    }
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) trackTab(tab, false);
    } catch (err) {
      console.warn('[tabsense] initial tab index failed:', err);
    }
    initialized = true;
    void refreshSnapshot();
  }

  void init();

  // When the core lands: recompute every key with the Wasm engine
  // (parity-identical, but the index should be core-built), then
  // re-evaluate the events that queued while it was instantiating.
  // If it failed, the queue is dropped — no-auto-close mode.
  void ensureCoreReady().then((ok) => {
    if (ok) {
      exactIndex.clear();
      for (const t of liveTabs.values()) {
        if (!t.excluded && t.url !== '') {
          const { keys } = canonicalKeys(t.url);
          t.exactKey = keys.exactKey;
          t.fuzzyKey = keys.fuzzyKey;
        }
        indexAdd(t);
      }
      const queued = pendingQueue.splice(0);
      for (const { tabId, eventAt } of queued) {
        void evaluateDuplicate(tabId, eventAt, true);
      }
    } else {
      pendingQueue.length = 0;
    }
    void refreshSnapshot();
  });

  // ------------------------------------------------------------------
  // Tab events (event-driven only — perf constitution: no polling).
  // ------------------------------------------------------------------

  chrome.tabs.onCreated.addListener((tab) => {
    const tracked = trackTab(tab, true);
    if (tracked && tracked.exactKey !== null && tab.id !== undefined) {
      void evaluateDuplicate(tab.id, Date.now(), false);
    }
    void refreshSnapshot();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Evaluate only when a navigation settles (status complete, with
    // the tab's final URL): evaluating on every intermediate
    // changeInfo.url could catch a tab mid-redirect — e.g. passing
    // through an SSO URL that happens to be open elsewhere — and
    // close it wrongly. The settled URL is the document the user
    // actually landed on.
    const settled = changeInfo.status === 'complete';
    const tracked = trackTab(tab, settled);
    if (settled && tracked && tracked.exactKey !== null) {
      void evaluateDuplicate(tabId, Date.now(), false);
    }
    void refreshSnapshot();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    untrackTab(tabId);
    void refreshSnapshot();
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    const tracked = liveTabs.get(tabId);
    if (tracked) tracked.windowId = attachInfo.newWindowId;
    void refreshSnapshot();
  });

  chrome.tabs.onDetached.addListener(() => void refreshSnapshot());

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    untrackTab(removedTabId);
    void chrome.tabs
      .get(addedTabId)
      .then((tab) => trackTab(tab, true))
      .catch(() => undefined);
    void refreshSnapshot();
  });

  // ------------------------------------------------------------------
  // Messages from the panel
  // ------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === GET_SNAPSHOT_MESSAGE) {
      // Refresh first so a just-woken worker answers with fresh state.
      void refreshSnapshot().then(() => sendResponse(current));
      return true; // async response
    }
    if (message?.type === CLOSE_DUPLICATE_SET_MESSAGE) {
      const exactKey = message.exactKey;
      const keepTabId = message.keepTabId;
      if (typeof exactKey === 'string' && typeof keepTabId === 'number') {
        void closeDuplicateSet(exactKey, keepTabId).then(sendResponse);
      } else {
        sendResponse({ closed: 0 });
      }
      return true;
    }
    if (message?.type === CLOSE_ALL_DUPLICATES_MESSAGE) {
      void closeAllDuplicateExtras().then(sendResponse);
      return true;
    }
    if (message?.type === SET_AUTO_CLOSE_MESSAGE) {
      autoCloseEnabled = message.enabled !== false;
      void chrome.storage.local
        .set({ [SETTINGS_KEY]: autoCloseEnabled })
        .catch(() => undefined);
      void refreshSnapshot();
      sendResponse({ autoCloseEnabled });
      return undefined;
    }
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) {
      autoCloseEnabled = changes[SETTINGS_KEY].newValue !== false;
      void refreshSnapshot();
    }
  });
});
