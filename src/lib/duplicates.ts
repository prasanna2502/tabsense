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
