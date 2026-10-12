/**
 * Duplicate counting and set building.
 *
 * M0: `summarizeDuplicates` counts identical URL strings (kept as the
 * continuity metric in the panel).
 * M1: `findExactDuplicateSets` / `findFuzzySets` group tabs by their
 * canonicalizer keys — exact sets are the auto-close tier, fuzzy sets
 * are "same document, different view" (suggestion tier, never
 * auto-closed).
 */

export interface DuplicateGroup {
  url: string;
  /** Total number of tabs open with this URL. */
  count: number;
}

export interface DuplicateSummary {
  /** Total number of tabs considered. */
  totalTabs: number;
  /** Number of distinct URLs. */
  uniqueUrls: number;
  /** Extra copies beyond the first for each URL (tabs that are duplicates). */
  duplicateTabs: number;
  /** One entry per URL open more than once, most-duplicated first. */
  groups: DuplicateGroup[];
}

export function summarizeDuplicates(urls: readonly string[]): DuplicateSummary {
  const counts = new Map<string, number>();
  for (const url of urls) {
    if (!url) continue;
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  const groups: DuplicateGroup[] = [];
  let duplicateTabs = 0;
  for (const [url, count] of counts) {
    if (count > 1) {
      groups.push({ url, count });
      duplicateTabs += count - 1;
    }
  }
  groups.sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
  return {
    totalTabs: urls.filter(Boolean).length,
    uniqueUrls: counts.size,
    duplicateTabs,
    groups,
  };
}

/** The key-bearing shape the canonical set builders need (TabInfo
 * satisfies it structurally). Tabs with null keys — the engine's
 * exclusions — never join a set. */
export interface KeyedTab {
  id: number;
  exactKey: string | null;
  fuzzyKey: string | null;
  firstSeenAt: number | null;
}

export interface ExactDuplicateSet {
  exactKey: string;
  tabIds: number[];
  /** The most recently seen tab of the set — the survivor of a bulk
   * "keep newest, close the rest". */
  newestTabId: number;
}

export interface FuzzySet {
  fuzzyKey: string;
  tabIds: number[];
  /** The distinct exact keys present — a fuzzy set only exists when
   * at least two different views of one document are open. */
  exactKeys: string[];
}

function newestFirst(a: KeyedTab, b: KeyedTab): number {
  const ta = a.firstSeenAt ?? -1;
  const tb = b.firstSeenAt ?? -1;
  return tb - ta || b.id - a.id;
}

/** Groups of 2+ tabs sharing one exactKey (auto-close tier). */
export function findExactDuplicateSets(
  tabs: readonly KeyedTab[],
): ExactDuplicateSet[] {
  const byKey = new Map<string, KeyedTab[]>();
  for (const tab of tabs) {
    if (tab.exactKey === null) continue;
    const list = byKey.get(tab.exactKey) ?? [];
    list.push(tab);
    byKey.set(tab.exactKey, list);
  }
  const sets: ExactDuplicateSet[] = [];
  for (const [exactKey, list] of byKey) {
    if (list.length < 2) continue;
    const ordered = [...list].sort(newestFirst);
    sets.push({
      exactKey,
      tabIds: ordered.map((t) => t.id),
      newestTabId: ordered[0].id,
    });
  }
  sets.sort(
    (a, b) => b.tabIds.length - a.tabIds.length || a.exactKey.localeCompare(b.exactKey),
  );
  return sets;
}

/** Total extra copies across exact duplicate sets — the number of
 * tabs a "close all extra copies" action would close, and the number
 * the toolbar badge advertises. Panel and worker share this so the
 * two always agree. */
export function countExtraCopies(
  sets: readonly ExactDuplicateSet[],
): number {
  return sets.reduce((n, s) => n + Math.max(0, s.tabIds.length - 1), 0);
}

export interface BulkClosePlan {
  exactKey: string;
  /** The survivor: the set's newest tab (same pick as the panel's
   * per-set "keep newest"). */
  keepTabId: number;
  /** Tabs to close, newest-first (set order minus the survivor). */
  closeTabIds: number[];
}

/** Plan a global "close all extra copies": one entry per exact set,
 * keeping each set's newest tab. Pure — the worker re-derives the
 * sets from its live index at click time and re-validates every tab
 * before closing, so a stale plan can never close the wrong tab. */
export function planBulkClose(
  sets: readonly ExactDuplicateSet[],
): BulkClosePlan[] {
  return sets.map((s) => ({
    exactKey: s.exactKey,
    keepTabId: s.newestTabId,
    closeTabIds: s.tabIds.slice(1),
  }));
}

export interface SimilarClosePlan {
  fuzzyKey: string;
  /** The survivor the user chose to keep. */
  keepTabId: number;
  /** Every other current member of the set, in set order. */
  closeTabIds: number[];
}

/** Plan a manual "keep one view, close the others" cleanup of one
 * fuzzy set (M1.2). This is the only path that ever closes a fuzzy
 * member, and only on an explicit per-group user action — fuzzy
 * matches are never auto-closed. Returns null when the named set no
 * longer exists or the keep tab is not a current member, so a stale
 * panel can never close the wrong tabs. Pure — the worker re-derives
 * the sets from its live index at click time and re-validates every
 * tab again before closing it. */
export function planSimilarClose(
  sets: readonly FuzzySet[],
  fuzzyKey: string,
  keepTabId: number,
): SimilarClosePlan | null {
  const set = sets.find((s) => s.fuzzyKey === fuzzyKey);
  if (!set || !set.tabIds.includes(keepTabId)) return null;
  return {
    fuzzyKey,
    keepTabId,
    closeTabIds: set.tabIds.filter((id) => id !== keepTabId),
  };
}

/** Creation evidence for the intentional-duplicate fingerprint
 * (Phase 2), assembled by the worker from the tabs.onCreated event
 * and its canonical index/tracking records — nothing else. */
export interface IntentionalDuplicateEvidence {
  /** Canonical key of the newly created tab (null = unkeyable). */
  newExactKey: string | null;
  /** Canonical key of the candidate source tab. */
  sourceExactKey: string | null;
  /** The new tab's openerTabId, as reported at creation. */
  openerTabId: number | null | undefined;
  /** The candidate source tab's id. */
  sourceTabId: number | null;
  /** The new tab's index at creation. */
  newIndex: number;
  /** The source tab's index at creation. */
  sourceIndex: number;
  /** Both tabs are in the same window. */
  sameWindow: boolean;
  /** The source tab was the active tab in its window at creation. */
  sourceWasActive: boolean;
}

/**
 * The intentional-duplicate fingerprint: ALL conditions required.
 * It matches the browser's Duplicate command used on the tab being
 * viewed — a copy of the same canonical page, opened from that tab
 * itself, landing immediately to its right, while the source was
 * the active tab. Anything weaker (a no-opener omnibox re-open, a
 * copy of a background tab, a non-adjacent placement) is not
 * evidence of intent and follows the normal duplicate rules.
 */
export function isIntentionalDuplicate(
  e: IntentionalDuplicateEvidence,
): boolean {
  return (
    e.newExactKey !== null &&
    e.sourceExactKey !== null &&
    e.newExactKey === e.sourceExactKey &&
    e.openerTabId !== null &&
    e.openerTabId !== undefined &&
    e.sourceTabId !== null &&
    e.openerTabId === e.sourceTabId &&
    e.sameWindow &&
    e.newIndex === e.sourceIndex + 1 &&
    e.sourceWasActive
  );
}

/** The full keep decision: the fingerprint AND the user's setting.
 * Setting off restores the pre-exemption behavior exactly. */
export function shouldKeepIntentionalDuplicate(
  e: IntentionalDuplicateEvidence,
  keepEnabled: boolean,
): boolean {
  return keepEnabled && isIntentionalDuplicate(e);
}

/**
 * Per-tab exemption store. An exemption attaches to ONE tab id at
 * ONE canonical key: it survives while the tab lives at that key
 * (reloads and same-document navigations included) and ends the
 * moment the tab settles on a different key or closes. It is never
 * a per-URL exemption — another tab opening the same URL follows
 * the normal rules.
 */
export class DuplicateExemptions {
  private byTab = new Map<number, string>();

  mark(tabId: number, exactKey: string): void {
    this.byTab.set(tabId, exactKey);
  }

  /** True when the tab is currently exempt at this key. A tab
   * marked at a different key has navigated away: its exemption
   * ends here (and is dropped), so the caller proceeds with the
   * normal rules for the new key. */
  retain(tabId: number, exactKey: string | null): boolean {
    const marked = this.byTab.get(tabId);
    if (marked === undefined) return false;
    if (exactKey !== null && marked === exactKey) return true;
    this.byTab.delete(tabId);
    return false;
  }

  forget(tabId: number): void {
    this.byTab.delete(tabId);
  }

  has(tabId: number): boolean {
    return this.byTab.has(tabId);
  }
}

/**
 * Deep-link courtesy for the auto-close swap: when the duplicate
 * being closed carries a URL fragment (a Docs heading anchor, a
 * scroll-to-text target, a section hash) that the kept tab's URL
 * does not already have, the kept tab should be navigated to the
 * duplicate's fragment so the user's intended jump survives the
 * close. A fragment-only URL change does not reload the page.
 *
 * Returns the URL the kept tab should navigate to, or null when no
 * transfer applies: the duplicate has no fragment, the kept tab
 * already sits at that fragment, or either URL is unparseable.
 * Pure — the worker performs the actual tabs.update.
 */
export function fragmentTransferTarget(
  keptUrl: string,
  closedUrl: string,
): string | null {
  let kept: URL;
  let closed: URL;
  try {
    kept = new URL(keptUrl);
    closed = new URL(closedUrl);
  } catch {
    return null;
  }
  const fragment = closed.hash;
  if (fragment === '' || kept.hash === fragment) return null;
  kept.hash = fragment;
  return kept.toString();
}

/** Groups of tabs sharing one fuzzyKey across 2+ distinct exactKeys:
 * the same document open in different views/states. Tabs that share
 * an exactKey land in an exact set instead; including them here when
 * a third view exists is deliberate — the set shows every open view
 * of the document. */
export function findFuzzySets(tabs: readonly KeyedTab[]): FuzzySet[] {
  const byKey = new Map<string, KeyedTab[]>();
  for (const tab of tabs) {
    if (tab.fuzzyKey === null || tab.exactKey === null) continue;
    const list = byKey.get(tab.fuzzyKey) ?? [];
    list.push(tab);
    byKey.set(tab.fuzzyKey, list);
  }
  const sets: FuzzySet[] = [];
  for (const [fuzzyKey, list] of byKey) {
    const exactKeys = [...new Set(list.map((t) => t.exactKey as string))];
    if (list.length < 2 || exactKeys.length < 2) continue;
    sets.push({
      fuzzyKey,
      tabIds: [...list].sort(newestFirst).map((t) => t.id),
      exactKeys,
    });
  }
  sets.sort(
    (a, b) => b.tabIds.length - a.tabIds.length || a.fuzzyKey.localeCompare(b.fuzzyKey),
  );
  return sets;
}
