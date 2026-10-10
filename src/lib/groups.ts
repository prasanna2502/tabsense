/**
 * TabSense group memory (M2).
 *
 * Group identity is **name + exemplar signature** — never the
 * session-scoped Chrome group ID (plan default A7: Chrome group IDs
 * die with the session; a group's name plus the canonical keys of
 * its exemplar members is how a group is recognized again). The
 * Chrome group ID is recorded only as a last-known hint for
 * resolution within the current session.
 *
 * Only groups TabSense created get a record here. A Chrome tab group
 * with no record is a **manual group** (created by the user, or by
 * another tool): hands-off, always — TabSense never suggests moving
 * tabs out of one, adding tabs to one, or renaming one (exit
 * criterion A2).
 */

import { hostOf, type ScorerTabInput } from './scorer';

export interface TabSenseGroupRecord {
  /** Stable local identity, assigned at creation. */
  localId: string;
  /** Free-form name; sticky once set, and locked once the user
   * renames the group in Chrome (the worker adopts the new name
   * rather than fighting it). */
  name: string;
  /** name + exemplar signature at last sync (see computeSignature). */
  signature: string;
  /** Canonical keys of the exemplar members the signature was
   * built from — kept so a live group can be recognized by member
   * overlap even across sessions (where Chrome group IDs die). */
  exemplarKeys: string[];
  windowId: number;
  /** Last known Chrome group ID — session-scoped hint only. */
  chromeGroupId: number | null;
  /** Last known member tab IDs (live resolution happens per pass). */
  memberTabIds: number[];
  createdAt: number;
  updatedAt: number;
}

/** The identity string from a name and an exemplar key set. */
export function signatureFromKeys(
  name: string,
  keys: readonly string[],
): string {
  const nameNorm = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const sorted = [...keys].filter((k) => k !== '').sort();
  return `v1|${nameNorm}|${sorted.slice(0, 5).join(',')}`;
}

/** Deterministic group identity: normalized name + the sorted
 * canonical keys (fuzzy preferred, exact otherwise, host as the
 * last resort) of up to 5 exemplar members. */
export function computeGroupSignature(
  name: string,
  exemplars: readonly ScorerTabInput[],
): string {
  return signatureFromKeys(
    name,
    exemplars.map((t) => t.fuzzyKey ?? t.exactKey ?? hostOf(t.url)),
  );
}

/** The exemplar key set of a tab list (for a group record). */
export function exemplarKeysOf(
  tabs: readonly ScorerTabInput[],
): string[] {
  return tabs
    .map((t) => t.fuzzyKey ?? t.exactKey ?? hostOf(t.url))
    .filter((k) => k !== '')
    .slice(0, 5);
}

/** Local ID for a new group record (timestamp + counter, so two
 * groups created in the same millisecond still differ). */
export function groupLocalId(now: number, counter: number): string {
  return `g${now.toString(36)}-${counter}`;
}

/** The groupKey used across the scorer/engine boundary. */
export function groupKeyOf(record: TabSenseGroupRecord): string {
  return `ts:${record.localId}`;
}

export function localIdFromGroupKey(groupKey: string): string | null {
  return groupKey.startsWith('ts:') ? groupKey.slice(3) : null;
}

// -------------------------------------------------------------------
// Dismissals — a dismissed suggestion must not silently re-form on
// the next pass. A dismissal is keyed by what was dismissed: the
// kind, the tab set, and the target (group or proposed name).
// -------------------------------------------------------------------

export interface DismissalRecord {
  signature: string;
  at: number;
}

export const DISMISSAL_CAP = 200;

/** Upper bound on retained group-memory records (M3). Before M3
 * this store grew monotonically — every group ever created kept a
 * record for the life of the profile. Records exist so a returning
 * group can be recognized by name + exemplar signature; that value
 * decays with age, and 200 records (~140 KB worst case) is far past
 * any plausible working set of recurring groups. */
export const GROUP_RECORDS_CAP = 200;

/**
 * Bound the group-memory store. Records whose Chrome group is live
 * in this session are never evicted; dormant records are kept
 * newest-updated first. Survivor order matches the input order.
 * If live records alone exceed the cap (a >200-group session), the
 * cap yields — live state is never dropped.
 */
export function capGroupRecords(
  records: readonly TabSenseGroupRecord[],
): TabSenseGroupRecord[] {
  if (records.length <= GROUP_RECORDS_CAP) return [...records];
  const live = records.filter((r) => r.chromeGroupId !== null);
  const dormant = records
    .filter((r) => r.chromeGroupId === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = Math.max(GROUP_RECORDS_CAP, live.length);
  const kept = new Set(
    [...live, ...dormant].slice(0, limit).map((r) => r.localId),
  );
  return records.filter((r) => kept.has(r.localId));
}

export function dismissalSignature(
  kind: 'new-group' | 'add-to-group',
  tabIds: readonly number[],
  targetKey: string,
): string {
  const ids = [...tabIds].sort((a, b) => a - b).join(',');
  return `${kind}|${targetKey}|${ids}`;
}

export function capDismissals(
  records: readonly DismissalRecord[],
): DismissalRecord[] {
  return [...records]
    .sort((a, b) => b.at - a.at)
    .slice(0, DISMISSAL_CAP);
}
