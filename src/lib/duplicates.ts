/**
 * Exact-URL duplicate counting (M0 scope).
 *
 * "Exact" means the URL strings are identical — no canonicalization yet.
 * Canonical/doc-ID duplicate detection is M1 (see docs/execution-plan.md).
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
