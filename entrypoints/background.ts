import { defineBackground } from 'wxt/utils/define-background';
import { BRANDING } from '../src/config/branding';
import { CircuitBreaker, type LadderRung } from '../src/lib/breaker';
import { isBlocklisted } from '../src/lib/blocklist';
import {
  countExtraCopies,
  findExactDuplicateSets,
  findFuzzySets,
  planBulkClose,
  planSimilarClose,
  summarizeDuplicates,
  type KeyedTab,
} from '../src/lib/duplicates';
import {
  capDismissals,
  capGroupRecords,
  computeGroupSignature,
  dismissalSignature,
  groupKeyOf,
  groupLocalId,
  localIdFromGroupKey,
  signatureFromKeys,
  type DismissalRecord,
  type TabSenseGroupRecord,
} from '../src/lib/groups';
import {
  detectLanguageModel,
  judgeWithRetry,
  normalizeAvailability,
  type JudgeRequest,
  type NanoAvailability,
} from '../src/lib/nano';
import {
  DurationRing,
  type DiagnosticsView,
} from '../src/lib/diagnostics';
import { hostOf, type ScorerTabInput } from '../src/lib/scorer';
import {
  GROUPING_SETTINGS_KEY,
  loadEffectiveSettings,
  type EffectiveSettings,
} from '../src/lib/settings';
import {
  ACCEPT_SUGGESTION_MESSAGE,
  ACTIVITY_CAP,
  ACTIVITY_KEY,
  CLOSE_ALL_DUPLICATES_MESSAGE,
  CLOSE_DUPLICATE_SET_MESSAGE,
  CLOSE_SIMILAR_SET_MESSAGE,
  DISMISS_SUGGESTION_MESSAGE,
  DISMISSED_KEY,
  GET_SNAPSHOT_MESSAGE,
  GROUPS_KEY,
  GROUP_ACTIVITY_CAP,
  GROUP_ACTIVITY_KEY,
  LAST_ACTION_KEY,
  SETTINGS_KEY,
  SET_AUTO_CLOSE_MESSAGE,
  SET_BLOCKLIST_MESSAGE,
  SET_GROUPING_PAUSED_MESSAGE,
  SET_PROVIDER_MESSAGE,
  SNAPSHOT_KEY,
  SUGGESTIONS_KEY,
  SWAP_SAMPLES_CAP,
  SWAP_SAMPLES_KEY,
  UNDO_GROUP_ACTION_MESSAGE,
  appendCapped,
  isExcludedTab,
  pushCapped,
  summarizeSwaps,
  type ActivityEntry,
  type GroupActivityEntry,
  type Suggestion,
  type SwapSample,
  type TabInfo,
  type TabSnapshot,
} from '../src/lib/snapshot';
import {
  applyNanoJudgments,
  buildSuggestions,
  type EngineGroup,
  type EngineTab,
  type SuggestionDraft,
} from '../src/lib/suggestions';
import {
  canonicalKeys,
  ensureCoreReady,
  getCoreState,
  getScorer,
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
  /** Chrome group ID or -1 (M2 grouping bookkeeping). */
  groupId: number;
  pinned: boolean;
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
  // M3 self-diagnostics (§10.3). The instrumentation measures work
  // the worker already does — two performance.now() reads around the
  // canonical compute + index update in trackTab, and around the
  // startup indexing loop. It adds no storage writes, no network,
  // and no async work to the tab-open path; samples live in a
  // capped in-memory ring.
  // ------------------------------------------------------------------

  const perfWorkerStartedAt = Date.now();
  const dedupeRing = new DurationRing(200);
  let perfRebuildMs: number | null = null;
  let perfCoreReindexMs: number | null = null;
  let perfAutoCloseCount = 0;
  let perfStorageBytes: number | null = null;
  let perfStorageBytesAt = 0;

  function heapUsedMb(): number | null {
    const mem = (performance as { memory?: { usedJSHeapSize?: number } })
      .memory;
    return typeof mem?.usedJSHeapSize === 'number'
      ? mem.usedJSHeapSize / (1024 * 1024)
      : null;
  }

  function currentDiagnostics(): DiagnosticsView {
    const swapStats = summarizeSwaps(swapSamples);
    return {
      workerStartedAt: perfWorkerStartedAt,
      rebuildMs: perfRebuildMs,
      coreReindexMs: perfCoreReindexMs,
      indexSize: exactIndex.size,
      trackedTabs: liveTabs.size,
      dedupeCheck: dedupeRing.stats(),
      swaps: {
        ...swapStats,
        lastMs: swapSamples.length
          ? swapSamples[swapSamples.length - 1].ms
          : null,
      },
      autoCloseCount: perfAutoCloseCount,
      storageBytes: perfStorageBytes,
      heapUsedMb: heapUsedMb(),
    };
  }

  // The CI perf harness reads the same numbers the settings UI
  // shows — one measurement source, so the gate and the user-facing
  // diagnostics can never disagree.
  (globalThis as { __tabsensePerf?: unknown }).__tabsensePerf = () => ({
    version: 1,
    ...currentDiagnostics(),
  });

  // ------------------------------------------------------------------
  // M2 grouping state. Suggest mode only: the engine below builds a
  // suggestion inbox; tabs are grouped exclusively by the accept
  // handler, on an explicit panel click, after re-validation.
  // ------------------------------------------------------------------

  let groupRecords: TabSenseGroupRecord[] = [];
  let dismissals: DismissalRecord[] = [];
  let groupActivity: GroupActivityEntry[] = [];
  let suggestions: Suggestion[] = [];
  let lastGroupAction: {
    tabIds: number[];
    chromeGroupId: number;
    recordLocalId: string | null;
    createdNewGroup: boolean;
    groupName: string;
    description: string;
    at: number;
  } | null = null;
  let effective: EffectiveSettings | null = null;
  const breaker = new CircuitBreaker();
  let lastEffectiveRung: LadderRung = 'heuristics';
  let nanoAvailability: NanoAvailability | 'unknown' = 'unknown';
  let nanoAvailabilityAt = 0;
  let lastGroupingRunAt: number | null = null;
  let heuristicDryStreak = 0;
  let groupIdCounter = 0;
  let groupingTimer: ReturnType<typeof setTimeout> | null = null;
  let groupingPassRunning = false;
  let groupingPassDirty = false;

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
      previous.groupId = tab.groupId ?? -1;
      previous.pinned = tab.pinned ?? false;
      previous.observed = previous.observed || observedNow;
      return previous;
    }
    // M3 diagnostics: time exactly the synchronous work the perf
    // constitution allows on this path — canonical-key compute plus
    // the index update. Samples are taken only for live events
    // (initialized), so the startup rebuild (timed separately as
    // rebuildMs) does not pollute the per-event distribution.
    const dedupeT0 = performance.now();
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
      groupId: tab.groupId ?? -1,
      pinned: tab.pinned ?? false,
    };
    liveTabs.set(tab.id, tracked);
    indexAdd(tracked);
    if (keys && initialized) {
      dedupeRing.push(performance.now() - dedupeT0);
    }
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
    activity = appendCapped(activity, entry, ACTIVITY_CAP);
    const toStore = activity;
    activityWrite = activityWrite
      .then(() => chrome.storage.local.set({ [ACTIVITY_KEY]: toStore }))
      .catch((err) => console.warn('[tabsense] activity persist failed:', err));
  }

  let swapWrite: Promise<void> = Promise.resolve();
  function recordSwap(sample: SwapSample): void {
    swapSamples = pushCapped(swapSamples, sample, SWAP_SAMPLES_CAP);
    const toStore = swapSamples;
    swapWrite = swapWrite
      .then(() => chrome.storage.local.set({ [SWAP_SAMPLES_KEY]: toStore }))
      .catch((err) => console.warn('[tabsense] swap persist failed:', err));
  }

  // ------------------------------------------------------------------
  // M2 persisted state (group memory, dismissals, grouping logs).
  // Writes are chained and trail user actions or debounced passes —
  // never the tab-open path.
  // ------------------------------------------------------------------

  let groupStateWrite: Promise<void> = Promise.resolve();
  function persistGroupState(): void {
    // M3 cap: group memory is bounded before every persist (and
    // once at load, below) — live groups are never evicted.
    groupRecords = capGroupRecords(groupRecords);
    const snapshotState = {
      [GROUPS_KEY]: groupRecords,
      [DISMISSED_KEY]: dismissals,
      [GROUP_ACTIVITY_KEY]: groupActivity,
      [SUGGESTIONS_KEY]: suggestions,
      [LAST_ACTION_KEY]: lastGroupAction,
    };
    groupStateWrite = groupStateWrite
      .then(() => chrome.storage.local.set(snapshotState))
      .catch((err) => console.warn('[tabsense] group state persist failed:', err));
  }

  function appendGroupActivity(entry: GroupActivityEntry): void {
    groupActivity = appendCapped(groupActivity, entry, GROUP_ACTIVITY_CAP);
    // Mirror into the main activity log (the panel's Recently
    // closed filters on the close reasons, so grouping entries
    // never masquerade as closed tabs there).
    appendActivity({
      id: entry.id,
      url: '',
      title: entry.groupName,
      closedTabId: entry.tabIds[0] ?? -1,
      keptTabId: -1,
      closedAt: entry.at,
      reason:
        entry.action === 'accept'
          ? 'group-accept'
          : entry.action === 'dismiss'
            ? 'group-dismiss'
            : 'group-undo',
    });
  }

  async function reloadEffectiveSettings(): Promise<void> {
    const area = (storageArea: chrome.storage.StorageArea) => ({
      get: (keys: string[]) => storageArea.get(keys) as Promise<Record<string, unknown>>,
    });
    effective = await loadEffectiveSettings(
      area(chrome.storage.local),
      typeof chrome.storage.managed !== 'undefined'
        ? area(chrome.storage.managed)
        : null,
    );
    autoCloseEnabled = effective.autoCloseEnabled;
    breaker.setStartRung(
      effective.provider === 'heuristics' ? 'heuristics' : 'nano',
    );
  }

  // ------------------------------------------------------------------
  // M2 group resolution: match TabSense records to live Chrome
  // groups. Identity is name + exemplar signature — the Chrome group
  // ID is only a same-session hint. A group whose title changed in
  // Chrome was renamed by the user: adopt the new name (user names
  // are sticky and locked once edited; we never fight them).
  // ------------------------------------------------------------------

  interface LiveChromeGroup {
    chromeGroupId: number;
    windowId: number;
    title: string;
    memberTabIds: number[];
  }

  async function syncGroupRecords(
    tabs: readonly chrome.tabs.Tab[],
  ): Promise<{ engineGroups: EngineGroup[]; liveGroups: LiveChromeGroup[] }> {
    const chromeGroups = await chrome.tabGroups.query({}).catch(() => []);
    const liveGroups: LiveChromeGroup[] = chromeGroups.map((g) => ({
      chromeGroupId: g.id,
      windowId: g.windowId,
      title: g.title ?? '',
      memberTabIds: tabs
        .filter((t) => (t.groupId ?? -1) === g.id)
        .map((t) => t.id as number),
    }));
    const byId = new Map(tabs.map((t) => [t.id as number, t]));
    const scorerTab = (t: chrome.tabs.Tab): ScorerTabInput => {
      const url = t.url ?? t.pendingUrl ?? '';
      const tracked = liveTabs.get(t.id as number);
      const keys =
        !isExcludedTab(t) && url !== ''
          ? tracked && tracked.url === url
            ? { exactKey: tracked.exactKey, fuzzyKey: tracked.fuzzyKey }
            : canonicalKeys(url).keys
          : { exactKey: null, fuzzyKey: null };
      return {
        id: t.id as number,
        title: t.title ?? '',
        url,
        exactKey: keys.exactKey,
        fuzzyKey: keys.fuzzyKey,
      };
    };

    let recordsChanged = false;
    const engineGroups: EngineGroup[] = [];
    for (const record of groupRecords) {
      let live =
        record.chromeGroupId !== null
          ? liveGroups.find((g) => g.chromeGroupId === record.chromeGroupId)
          : undefined;
      if (!live) {
        // Cross-session recognition: same window, same name, and at
        // least one shared exemplar key among live members.
        live = liveGroups.find((g) => {
          if (g.windowId !== record.windowId || g.title !== record.name) {
            return false;
          }
          const liveKeys = new Set(
            g.memberTabIds.map((id) => {
              const t = byId.get(id);
              if (!t) return '';
              const s = scorerTab(t);
              return s.fuzzyKey ?? s.exactKey ?? hostOf(s.url);
            }),
          );
          return record.exemplarKeys.some((k) => liveKeys.has(k));
        });
      }
      if (!live) {
        if (record.chromeGroupId !== null) {
          record.chromeGroupId = null;
          recordsChanged = true;
        }
        continue;
      }
      const members = live.memberTabIds
        .map((id) => byId.get(id))
        .filter((t): t is chrome.tabs.Tab => t !== undefined)
        .map(scorerTab);
      if (live.title !== '' && live.title !== record.name) {
        record.name = live.title;
        record.signature = computeGroupSignature(record.name, members);
        record.exemplarKeys = members
          .map((m) => m.fuzzyKey ?? m.exactKey ?? hostOf(m.url))
          .filter((k) => k !== '')
          .slice(0, 5);
        recordsChanged = true;
      }
      if (
        record.chromeGroupId !== live.chromeGroupId ||
        record.windowId !== live.windowId ||
        record.memberTabIds.join(',') !== live.memberTabIds.join(',')
      ) {
        record.chromeGroupId = live.chromeGroupId;
        record.windowId = live.windowId;
        record.memberTabIds = live.memberTabIds;
        record.updatedAt = Date.now();
        recordsChanged = true;
      }
      engineGroups.push({ record, members });
    }
    if (recordsChanged) persistGroupState();
    return { engineGroups, liveGroups };
  }

  // ------------------------------------------------------------------
  // M2 grouping pass — debounced ~1.5 s after tab activity settles,
  // entirely off the tab-open path (perf constitution). Dedupe
  // never calls into this section.
  // ------------------------------------------------------------------

  function scheduleGroupingPass(): void {
    if (groupingTimer !== null) clearTimeout(groupingTimer);
    groupingTimer = setTimeout(() => {
      groupingTimer = null;
      void runGroupingPass();
    }, 1500);
  }

  async function currentNanoAvailability(now: number): Promise<NanoAvailability> {
    if (nanoAvailability !== 'unknown' && now - nanoAvailabilityAt < 60_000) {
      return nanoAvailability;
    }
    const lm = detectLanguageModel();
    if (!lm) {
      nanoAvailability = 'unavailable';
      nanoAvailabilityAt = now;
      return nanoAvailability;
    }
    try {
      nanoAvailability = normalizeAvailability(await lm.availability());
    } catch {
      nanoAvailability = 'unavailable';
    }
    nanoAvailabilityAt = now;
    return nanoAvailability;
  }

  function suggestionFromDraft(draft: SuggestionDraft): Suggestion {
    const sig = dismissalSignature(
      draft.kind,
      draft.tabIds,
      draft.kind === 'new-group'
        ? `name:${(draft.proposedName ?? '').toLowerCase()}`
        : (draft.targetGroupKey ?? ''),
    );
    let hash = 0;
    for (let i = 0; i < sig.length; i++) {
      hash = (hash * 31 + sig.charCodeAt(i)) | 0;
    }
    return {
      ...draft,
      id: `s${(hash >>> 0).toString(36)}`,
      tabs: draft.tabs.map((t) => ({
        tabId: t.id,
        title: t.title,
        url: t.url,
      })),
      createdAt: Date.now(),
    };
  }

  async function runGroupingPass(): Promise<void> {
    if (!initialized) return;
    if (groupingPassRunning) {
      groupingPassDirty = true;
      return;
    }
    groupingPassRunning = true;
    try {
      if (!effective) await reloadEffectiveSettings();
      const settings = effective as EffectiveSettings;
      if (settings.groupingPaused) {
        lastEffectiveRung = 'paused';
        if (suggestions.length > 0) {
          suggestions = [];
          persistGroupState();
        }
        lastGroupingRunAt = Date.now();
        return;
      }

      const rawTabs = (await chrome.tabs.query({})).filter(
        (t) => t.id !== undefined,
      );
      const { engineGroups } = await syncGroupRecords(rawTabs);
      const engineTabs: EngineTab[] = rawTabs.map((t) => {
        const url = t.url ?? t.pendingUrl ?? '';
        const tracked = liveTabs.get(t.id as number);
        const excluded = isExcludedTab(t);
        const keys =
          !excluded && url !== ''
            ? tracked && tracked.url === url
              ? { exactKey: tracked.exactKey, fuzzyKey: tracked.fuzzyKey }
              : canonicalKeys(url).keys
            : { exactKey: null, fuzzyKey: null };
        return {
          id: t.id as number,
          title: t.title ?? '',
          url,
          exactKey: keys.exactKey,
          fuzzyKey: keys.fuzzyKey,
          windowId: t.windowId,
          groupId: t.groupId ?? -1,
          pinned: t.pinned ?? false,
          excluded,
        };
      });

      const now = Date.now();
      let rung: LadderRung = breaker.currentRung(now);
      if (rung === 'nano') {
        const availability = await currentNanoAvailability(now);
        if (availability !== 'available') {
          // Missing / still downloading / policy-blocked: detection,
          // not a failure — heuristics take this pass (§11 ladder).
          rung = 'heuristics';
        }
      }
      lastEffectiveRung = rung;

      let drafts = buildSuggestions({
        tabs: engineTabs,
        groups: engineGroups,
        blocklist: settings.blocklist,
        rung,
        dismissed: dismissals,
        scorer: getScorer(),
      });

      if (rung === 'nano') {
        const lm = detectLanguageModel();
        if (lm) {
          const judged = await applyNanoJudgments(
            drafts,
            engineGroups,
            async (req: JudgeRequest) => {
              const outcome = await judgeWithRetry(lm, req);
              return {
                verdict: outcome.verdict,
                callFailed: outcome.callFailed,
              };
            },
          );
          drafts = judged.drafts;
          // Breaker bookkeeping: successes restore, failures trip.
          for (let i = 0; i < judged.stats.calls - judged.stats.failures; i++) {
            breaker.recordSuccess();
          }
          for (let i = 0; i < judged.stats.failures; i++) {
            breaker.recordFailure(Date.now());
          }
        }
      } else if (rung === 'heuristics') {
        // §11 rung signal: with groupable tabs present, a pass that
        // produces nothing is low confidence — three in a row steps
        // the ladder down to domain-only.
        const eligibleCount = engineTabs.filter(
          (t) => !t.excluded && !t.pinned && t.groupId === -1,
        ).length;
        if (eligibleCount >= 2 && drafts.length === 0) {
          heuristicDryStreak++;
          if (heuristicDryStreak >= 3) {
            breaker.recordFailure(now);
            breaker.recordFailure(now);
            breaker.recordFailure(now);
            heuristicDryStreak = 0;
          }
        } else {
          heuristicDryStreak = 0;
          if (drafts.length > 0) breaker.recordSuccess();
        }
      }

      suggestions = drafts.map(suggestionFromDraft);
      lastGroupingRunAt = Date.now();
      persistGroupState();
    } catch (err) {
      console.warn('[tabsense] grouping pass failed:', err);
    } finally {
      groupingPassRunning = false;
      scheduleRefreshSnapshot();
      if (groupingPassDirty) {
        groupingPassDirty = false;
        scheduleGroupingPass();
      }
    }
  }

  // ------------------------------------------------------------------
  // M2 suggestion actions — the only code paths that ever group a
  // tab, each behind an explicit panel action and live re-validation.
  // ------------------------------------------------------------------

  function removeSuggestion(id: string): void {
    suggestions = suggestions.filter((s) => s.id !== id);
  }

  async function acceptSuggestion(
    suggestionId: string,
    tabIds: number[] | undefined,
    target:
      | { kind: 'group'; groupKey: string }
      | { kind: 'new'; name: string }
      | undefined,
  ): Promise<{ applied: number }> {
    const suggestion = suggestions.find((s) => s.id === suggestionId);
    if (!suggestion || !effective) return { applied: 0 };
    const wanted = (tabIds ?? suggestion.tabIds).filter((id) =>
      suggestion.tabIds.includes(id),
    );
    if (wanted.length === 0) return { applied: 0 };

    const rawTabs = (await chrome.tabs.query({})).filter(
      (t) => t.id !== undefined,
    );
    const byId = new Map(rawTabs.map((t) => [t.id as number, t]));
    // Re-validate every tab: still open, still ungrouped (hands-off
    // rule), still not excluded, still not blocklisted.
    const validIds = wanted.filter((id) => {
      const t = byId.get(id);
      if (!t || isExcludedTab(t)) return false;
      if ((t.groupId ?? -1) !== -1) return false;
      if (isBlocklisted(t.url ?? '', effective?.blocklist ?? [])) return false;
      return true;
    });
    if (validIds.length === 0) return { applied: 0 };

    const effectiveTarget =
      target ??
      (suggestion.kind === 'add-to-group' && suggestion.targetGroupKey
        ? { kind: 'group' as const, groupKey: suggestion.targetGroupKey }
        : {
            kind: 'new' as const,
            name: suggestion.proposedName ?? 'New group',
          });

    let chromeGroupId: number;
    let groupName: string;
    let record: TabSenseGroupRecord | null = null;
    let createdNewGroup = false;

    if (effectiveTarget.kind === 'new') {
      groupName =
        effectiveTarget.name.trim().slice(0, 60) || 'New group';
      try {
        chromeGroupId = await chrome.tabs.group({
          tabIds: validIds as [number, ...number[]],
          createProperties: { windowId: suggestion.windowId },
        });
        await chrome.tabGroups.update(chromeGroupId, { title: groupName });
      } catch {
        return { applied: 0 };
      }
      const members = validIds
        .map((id) => byId.get(id))
        .filter((t): t is chrome.tabs.Tab => t !== undefined)
        .map((t) => {
          const url = t.url ?? '';
          const keys = canonicalKeys(url).keys;
          return {
            id: t.id as number,
            title: t.title ?? '',
            url,
            exactKey: keys.exactKey,
            fuzzyKey: keys.fuzzyKey,
          } satisfies ScorerTabInput;
        });
      const now = Date.now();
      record = {
        localId: groupLocalId(now, groupIdCounter++),
        name: groupName,
        signature: computeGroupSignature(groupName, members),
        exemplarKeys: members
          .map((m) => m.fuzzyKey ?? m.exactKey ?? hostOf(m.url))
          .filter((k) => k !== '')
          .slice(0, 5),
        windowId: suggestion.windowId,
        chromeGroupId,
        memberTabIds: [...validIds],
        createdAt: now,
        updatedAt: now,
      };
      groupRecords.push(record);
      createdNewGroup = true;
    } else {
      const localId = localIdFromGroupKey(effectiveTarget.groupKey);
      record =
        groupRecords.find((r) => r.localId === localId) ?? null;
      if (!record) return { applied: 0 };
      // Resolve the record's live Chrome group (session hint first).
      let resolvedId = record.chromeGroupId;
      if (resolvedId === null || resolvedId === undefined) {
        const member = record.memberTabIds
          .map((id) => byId.get(id))
          .find((t) => t && (t.groupId ?? -1) !== -1);
        resolvedId = member ? (member.groupId as number) : null;
      }
      if (resolvedId === null || resolvedId === undefined) {
        return { applied: 0 };
      }
      try {
        await chrome.tabGroups.get(resolvedId);
        chromeGroupId = await chrome.tabs.group({
          tabIds: validIds as [number, ...number[]],
          groupId: resolvedId,
        });
      } catch {
        return { applied: 0 };
      }
      groupName = record.name;
      record.memberTabIds = [...new Set([...record.memberTabIds, ...validIds])];
      record.updatedAt = Date.now();
    }

    const now = Date.now();
    lastGroupAction = {
      tabIds: [...validIds],
      chromeGroupId,
      recordLocalId: record?.localId ?? null,
      createdNewGroup,
      groupName,
      description: `Grouped ${validIds.length} ${validIds.length === 1 ? 'tab' : 'tabs'} into “${groupName}”`,
      at: now,
    };
    appendGroupActivity({
      id: `g${now}-${suggestionId}`,
      at: now,
      action: 'accept',
      kind: createdNewGroup ? 'new-group' : 'add-to-group',
      groupName,
      tabIds: [...validIds],
      tabTitles: validIds.map((id) => byId.get(id)?.title ?? ''),
    });
    removeSuggestion(suggestionId);
    persistGroupState();
    scheduleGroupingPass();
    scheduleRefreshSnapshot();
    return { applied: validIds.length };
  }

  function dismissSuggestion(suggestionId: string): { dismissed: boolean } {
    const suggestion = suggestions.find((s) => s.id === suggestionId);
    if (!suggestion) return { dismissed: false };
    const now = Date.now();
    dismissals = capDismissals([
      ...dismissals,
      {
        signature: dismissalSignature(
          suggestion.kind,
          suggestion.tabIds,
          suggestion.kind === 'new-group'
            ? `name:${(suggestion.proposedName ?? '').toLowerCase()}`
            : (suggestion.targetGroupKey ?? ''),
        ),
        at: now,
      },
    ]);
    appendGroupActivity({
      id: `g${now}-${suggestionId}`,
      at: now,
      action: 'dismiss',
      kind: suggestion.kind,
      groupName:
        suggestion.kind === 'new-group'
          ? (suggestion.proposedName ?? 'New group')
          : (suggestion.targetGroupName ?? ''),
      tabIds: [...suggestion.tabIds],
      tabTitles: suggestion.tabs.map((t) => t.title),
    });
    removeSuggestion(suggestionId);
    persistGroupState();
    scheduleRefreshSnapshot();
    return { dismissed: true };
  }

  async function undoGroupAction(): Promise<{ undone: number }> {
    const action = lastGroupAction;
    if (!action) return { undone: 0 };
    lastGroupAction = null;
    let undone = 0;
    for (const tabId of action.tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        // Only ungroup tabs still sitting in the group this action
        // filed them into — never a group the user chose since.
        if ((tab.groupId ?? -1) === action.chromeGroupId) {
          await chrome.tabs.ungroup(tabId);
          undone++;
        }
      } catch {
        // Tab is gone — nothing to undo for it.
      }
    }
    if (action.recordLocalId) {
      if (action.createdNewGroup) {
        groupRecords = groupRecords.filter(
          (r) => r.localId !== action.recordLocalId,
        );
      } else {
        const record = groupRecords.find(
          (r) => r.localId === action.recordLocalId,
        );
        if (record) {
          record.memberTabIds = record.memberTabIds.filter(
            (id) => !action.tabIds.includes(id),
          );
          record.updatedAt = Date.now();
        }
      }
    }
    appendGroupActivity({
      id: `g${Date.now()}-undo`,
      at: Date.now(),
      action: 'undo',
      kind: action.createdNewGroup ? 'new-group' : 'add-to-group',
      groupName: action.groupName,
      tabIds: [...action.tabIds],
      tabTitles: [],
    });
    persistGroupState();
    scheduleGroupingPass();
    scheduleRefreshSnapshot();
    return { undone };
  }

  /** Read-modify-write of the local grouping settings object,
   * behind the managed-precedence rule: a field forced by policy
   * cannot be changed locally. */
  async function updateGroupingSetting(
    field: 'groupingPaused' | 'provider' | 'blocklist',
    value: unknown,
  ): Promise<{ applied: boolean; managed: boolean }> {
    if (!effective) await reloadEffectiveSettings();
    if ((effective as EffectiveSettings).managedKeys.includes(field)) {
      return { applied: false, managed: true };
    }
    const stored = await chrome.storage.local.get(GROUPING_SETTINGS_KEY);
    const current =
      typeof stored[GROUPING_SETTINGS_KEY] === 'object' &&
      stored[GROUPING_SETTINGS_KEY] !== null
        ? (stored[GROUPING_SETTINGS_KEY] as Record<string, unknown>)
        : {};
    current[field] = value;
    await chrome.storage.local.set({ [GROUPING_SETTINGS_KEY]: current });
    await reloadEffectiveSettings();
    scheduleGroupingPass();
    scheduleRefreshSnapshot();
    return { applied: true, managed: false };
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
    perfAutoCloseCount++;
    appendActivity({
      id: `${doneAt}-${dup.tabId}`,
      url: dup.url,
      title: dup.title,
      closedTabId: dup.tabId,
      keptTabId: existing.tabId,
      closedAt: doneAt,
      reason: 'auto-close',
    });
    scheduleRefreshSnapshot();
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
    scheduleRefreshSnapshot();
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
    scheduleRefreshSnapshot();
    return { closed };
  }

  /**
   * Panel-initiated manual cleanup of one similar-document group
   * (M1.2): keep the view the user chose, close the other views.
   * This is the only path that ever closes a fuzzy member, and it
   * runs only on an explicit per-group click — the two-tier rule is
   * unchanged (fuzzy matches are never auto-closed). The plan is
   * re-derived from the live index at click time: the keep tab must
   * be a current member of the named fuzzy set, and every tab is
   * re-validated — still tracked, not excluded, still carrying that
   * fuzzyKey — immediately before it is closed. Closed views land
   * in the activity log, so Recently closed can reopen them.
   */
  async function closeSimilarSet(
    fuzzyKey: string,
    keepTabId: number,
  ): Promise<{ closed: number }> {
    const plan = planSimilarClose(
      findFuzzySets(liveKeyedTabs()),
      fuzzyKey,
      keepTabId,
    );
    if (!plan) return { closed: 0 };
    let closed = 0;
    for (const id of plan.closeTabIds) {
      const t = liveTabs.get(id);
      if (!t || t.excluded || t.fuzzyKey !== fuzzyKey) continue;
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
    // refreshSnapshot also recomputes the (exact-tier only) badge.
    scheduleRefreshSnapshot();
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
    suggestions: [],
    grouping: {
      rung: 'heuristics',
      nanoAvailability: 'unknown',
      pausedByUser: false,
      lastRunAt: null,
    },
    groupOptions: [],
    settingsView: {
      autoCloseEnabled: true,
      groupingPaused: false,
      provider: 'nano',
      blocklist: [],
      sources: {
        autoCloseEnabled: 'local',
        groupingPaused: 'local',
        provider: 'local',
        blocklist: 'local',
      },
      managedKeys: [],
    },
    lastGroupAction: null,
  };

  // M3: snapshot persistence is coalesced. The snapshot is a UI
  // mirror — the worker's own decisions never read it — but
  // rebuilding and rewriting it on every tab event made the worker
  // compete with page loads during open storms (the CDP harness
  // measured that contention as added tab-open latency, worst under
  // CPU throttling). Event-driven call sites schedule a refresh
  // instead: at most one rebuild per coalesce window, trailing
  // edge, so a burst of N events costs one rebuild. Flows that must
  // answer the panel with fresh state (init, the snapshot request
  // handler) still call refreshSnapshot() directly.
  const SNAPSHOT_COALESCE_MS = 250;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefreshSnapshot(): void {
    if (snapshotTimer !== null) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      scheduleRefreshSnapshot();
    }, SNAPSHOT_COALESCE_MS);
  }

  async function refreshSnapshot(): Promise<void> {
    // M3 diagnostics: keep the storage-bytes figure fresh (throttled
    // to one read per 30 s; snapshot refreshes are event-driven and
    // off the tab-open path, and the read itself is async).
    if (Date.now() - perfStorageBytesAt > 30_000) {
      perfStorageBytesAt = Date.now();
      chrome.storage.local
        .getBytesInUse(null)
        .then((bytes) => {
          perfStorageBytes = bytes;
        })
        .catch(() => {});
    }
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
            lastAccessed: t.lastAccessed ?? null,
            groupId: t.groupId ?? -1,
          };
        });
      const firstUrl = tabs.find((t) => t.url)?.url;
      const settings = effective;
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
        suggestions,
        grouping: {
          rung: settings?.groupingPaused ? 'paused' : lastEffectiveRung,
          nanoAvailability,
          pausedByUser: settings?.groupingPaused ?? false,
          lastRunAt: lastGroupingRunAt,
        },
        groupOptions: groupRecords
          .filter((r) => r.chromeGroupId !== null)
          .map((r) => ({
            groupKey: groupKeyOf(r),
            name: r.name,
            memberCount: r.memberTabIds.length,
            windowId: r.windowId,
          })),
        settingsView: settings
          ? {
              autoCloseEnabled: settings.autoCloseEnabled,
              groupingPaused: settings.groupingPaused,
              provider: settings.provider,
              blocklist: settings.blocklist,
              sources: settings.sources,
              managedKeys: settings.managedKeys,
            }
          : current.settingsView,
        lastGroupAction: lastGroupAction
          ? {
              description: lastGroupAction.description,
              at: lastGroupAction.at,
            }
          : null,
        diagnostics: currentDiagnostics(),
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
        GROUPS_KEY,
        DISMISSED_KEY,
        GROUP_ACTIVITY_KEY,
        SUGGESTIONS_KEY,
        LAST_ACTION_KEY,
      ]);
      if (Array.isArray(stored[ACTIVITY_KEY])) {
        activity = stored[ACTIVITY_KEY] as ActivityEntry[];
      }
      if (Array.isArray(stored[SWAP_SAMPLES_KEY])) {
        swapSamples = stored[SWAP_SAMPLES_KEY] as SwapSample[];
      }
      autoCloseEnabled = stored[SETTINGS_KEY] !== false;
      if (Array.isArray(stored[GROUPS_KEY])) {
        // Cap on load too: a store written before the cap existed
        // (or grown by any path that missed persist) shrinks here.
        groupRecords = capGroupRecords(
          stored[GROUPS_KEY] as TabSenseGroupRecord[],
        );
      }
      if (Array.isArray(stored[DISMISSED_KEY])) {
        dismissals = stored[DISMISSED_KEY] as DismissalRecord[];
      }
      if (Array.isArray(stored[GROUP_ACTIVITY_KEY])) {
        groupActivity = stored[GROUP_ACTIVITY_KEY] as GroupActivityEntry[];
      }
      if (Array.isArray(stored[SUGGESTIONS_KEY])) {
        suggestions = stored[SUGGESTIONS_KEY] as Suggestion[];
      }
      if (
        typeof stored[LAST_ACTION_KEY] === 'object' &&
        stored[LAST_ACTION_KEY] !== null
      ) {
        lastGroupAction = stored[LAST_ACTION_KEY] as typeof lastGroupAction;
      }
    } catch (err) {
      console.warn('[tabsense] state load failed:', err);
    }
    await reloadEffectiveSettings().catch((err) =>
      console.warn('[tabsense] settings load failed:', err),
    );
    try {
      // M3: this loop is the "duplicate index rebuild on worker
      // start" the budget measures — query + canonicalize + index
      // for the whole pre-existing tab set.
      const rebuildT0 = performance.now();
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) trackTab(tab, false);
      perfRebuildMs = performance.now() - rebuildT0;
    } catch (err) {
      console.warn('[tabsense] initial tab index failed:', err);
    }
    initialized = true;
    void refreshSnapshot();
    // First grouping pass for the already-open tab set (debounced
    // like every pass; the inbox is ready when the user opens the
    // panel, not computed on any tab's critical path).
    scheduleGroupingPass();
  }

  void init();

  // When the core lands: recompute every key with the Wasm engine
  // (parity-identical, but the index should be core-built), then
  // re-evaluate the events that queued while it was instantiating.
  // If it failed, the queue is dropped — no-auto-close mode.
  void ensureCoreReady().then((ok) => {
    if (ok) {
      const reindexT0 = performance.now();
      exactIndex.clear();
      for (const t of liveTabs.values()) {
        if (!t.excluded && t.url !== '') {
          const { keys } = canonicalKeys(t.url);
          t.exactKey = keys.exactKey;
          t.fuzzyKey = keys.fuzzyKey;
        }
        indexAdd(t);
      }
      perfCoreReindexMs = performance.now() - reindexT0;
      const queued = pendingQueue.splice(0);
      for (const { tabId, eventAt } of queued) {
        void evaluateDuplicate(tabId, eventAt, true);
      }
    } else {
      pendingQueue.length = 0;
    }
    scheduleRefreshSnapshot();
  });

  // ------------------------------------------------------------------
  // Tab events (event-driven only — perf constitution: no polling).
  // ------------------------------------------------------------------

  chrome.tabs.onCreated.addListener((tab) => {
    const tracked = trackTab(tab, true);
    if (tracked && tracked.exactKey !== null && tab.id !== undefined) {
      void evaluateDuplicate(tab.id, Date.now(), false);
    }
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
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
    scheduleRefreshSnapshot();
    if (settled || changeInfo.groupId !== undefined) {
      scheduleGroupingPass();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    untrackTab(tabId);
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
  });

  chrome.tabs.onAttached.addListener((tabId, attachInfo) => {
    const tracked = liveTabs.get(tabId);
    if (tracked) tracked.windowId = attachInfo.newWindowId;
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
  });

  chrome.tabs.onDetached.addListener(() => {
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
  });

  // Group membership changes (user grouping by hand, another tool,
  // our own accepts) re-run resolution and the pass. Manual groups
  // thereby stay hands-off automatically.
  chrome.tabGroups.onCreated.addListener(() => {
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
  });
  chrome.tabGroups.onUpdated.addListener(() => {
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
  });
  chrome.tabGroups.onRemoved.addListener(() => {
    scheduleRefreshSnapshot();
    scheduleGroupingPass();
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    untrackTab(removedTabId);
    void chrome.tabs
      .get(addedTabId)
      .then((tab) => trackTab(tab, true))
      .catch(() => undefined);
    scheduleRefreshSnapshot();
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
    if (message?.type === CLOSE_SIMILAR_SET_MESSAGE) {
      const fuzzyKey = message.fuzzyKey;
      const keepTabId = message.keepTabId;
      if (typeof fuzzyKey === 'string' && typeof keepTabId === 'number') {
        void closeSimilarSet(fuzzyKey, keepTabId).then(sendResponse);
      } else {
        sendResponse({ closed: 0 });
      }
      return true;
    }
    if (message?.type === ACCEPT_SUGGESTION_MESSAGE) {
      const tabIds = Array.isArray(message.tabIds)
        ? (message.tabIds as number[])
        : undefined;
      const target =
        message.target &&
        typeof message.target === 'object' &&
        (message.target.kind === 'group' || message.target.kind === 'new')
          ? message.target
          : undefined;
      if (typeof message.suggestionId === 'string') {
        void acceptSuggestion(message.suggestionId, tabIds, target).then(
          sendResponse,
        );
      } else {
        sendResponse({ applied: 0 });
      }
      return true;
    }
    if (message?.type === DISMISS_SUGGESTION_MESSAGE) {
      if (typeof message.suggestionId === 'string') {
        sendResponse(dismissSuggestion(message.suggestionId));
      } else {
        sendResponse({ dismissed: false });
      }
      return undefined;
    }
    if (message?.type === UNDO_GROUP_ACTION_MESSAGE) {
      void undoGroupAction().then(sendResponse);
      return true;
    }
    if (message?.type === SET_GROUPING_PAUSED_MESSAGE) {
      void updateGroupingSetting(
        'groupingPaused',
        message.paused === true,
      ).then(sendResponse);
      return true;
    }
    if (message?.type === SET_PROVIDER_MESSAGE) {
      void updateGroupingSetting(
        'provider',
        message.provider === 'heuristics' ? 'heuristics' : 'nano',
      ).then(sendResponse);
      return true;
    }
    if (message?.type === SET_BLOCKLIST_MESSAGE) {
      const list = Array.isArray(message.blocklist)
        ? (message.blocklist as unknown[]).filter(
            (e): e is string => typeof e === 'string',
          )
        : null;
      void updateGroupingSetting('blocklist', list).then(sendResponse);
      return true;
    }
    if (message?.type === SET_AUTO_CLOSE_MESSAGE) {
      // Managed precedence: a policy-forced value cannot be changed
      // locally (the panel also disables the control).
      if (effective?.managedKeys.includes('autoCloseEnabled')) {
        sendResponse({ autoCloseEnabled, managed: true });
        return undefined;
      }
      autoCloseEnabled = message.enabled !== false;
      void chrome.storage.local
        .set({ [SETTINGS_KEY]: autoCloseEnabled })
        .catch(() => undefined);
      scheduleRefreshSnapshot();
      sendResponse({ autoCloseEnabled });
      return undefined;
    }
    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      (area === 'local' || area === 'managed') &&
      (changes[SETTINGS_KEY] || changes[GROUPING_SETTINGS_KEY])
    ) {
      void reloadEffectiveSettings()
        .then(() => {
          scheduleRefreshSnapshot();
          scheduleGroupingPass();
        })
        .catch(() => undefined);
    }
  });
});
