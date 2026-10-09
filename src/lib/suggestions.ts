/**
 * Suggestion engine (M2) — Suggest mode only. This module turns the
 * heuristic router's candidates (plus, on the nano rung, the Nano
 * judge's verdicts) into a reviewable inbox. **Nothing here is ever
 * applied**: a suggestion exists so the user can accept, reassign,
 * or dismiss it in the panel. Applying happens only in the worker,
 * only on an explicit accept.
 *
 * Eligibility is the trust core of the feature:
 *  - Grouping is per-window.
 *  - Tabs already in ANY Chrome group are never suggested: not out
 *    of manual groups (never moved, never renamed), not out of
 *    TabSense groups (already filed). This is the A2 hands-off rule.
 *  - Pinned tabs and the dedupe engine's exclusions (browser pages,
 *    extension pages, URL-less tabs) are out.
 *  - Blocklisted hosts are out (sensitive domains are never
 *    suggested or grouped).
 *  - Dismissed (kind, tab set, target) signatures are out — a
 *    dismissal sticks.
 */

import type { LadderRung } from './breaker';
import { isBlocklisted } from './blocklist';
import {
  dismissalSignature,
  groupKeyOf,
  type DismissalRecord,
  type TabSenseGroupRecord,
} from './groups';
import type { JudgeRequest, NanoVerdict } from './nano';
import {
  hostOf,
  type Scorer,
  type ScorerGroupInput,
  type ScorerTabInput,
} from './scorer';

export type SuggestionSource = 'nano' | 'heuristics' | 'domain-only';
export type SuggestionKind = 'new-group' | 'add-to-group';

export interface EngineTab extends ScorerTabInput {
  windowId: number;
  /** Chrome group ID, or -1 when ungrouped (TAB_GROUP_ID_NONE). */
  groupId: number;
  pinned: boolean;
  /** The dedupe engine's exclusion (isExcludedTab). */
  excluded: boolean;
}

export interface EngineGroup {
  record: TabSenseGroupRecord;
  /** Live member tabs (resolved by the worker for this pass). */
  members: ScorerTabInput[];
}

export interface SuggestionDraft {
  kind: SuggestionKind;
  windowId: number;
  tabIds: number[];
  tabs: ScorerTabInput[];
  targetGroupKey: string | null;
  targetGroupName: string | null;
  proposedName: string | null;
  confidence: number;
  source: SuggestionSource;
  /** True when Nano was consulted, its output failed validation,
   * and this draft is the heuristics fallback (reduced confidence). */
  nanoFallback: boolean;
}

export interface EngineInput {
  tabs: readonly EngineTab[];
  groups: readonly EngineGroup[];
  blocklist: readonly string[];
  rung: LadderRung;
  dismissed: readonly DismissalRecord[];
  scorer: Scorer;
}

/** Inbox size guard: a reviewable inbox, not a wall (M1.2 lesson). */
export const MAX_SUGGESTIONS_PER_WINDOW = 10;

function titleCaseSeed(seed: string): string {
  if (seed === '') return '';
  return seed.charAt(0).toUpperCase() + seed.slice(1);
}

function hostTopicName(url: string): string {
  const label = hostOf(url).split('.')[0] ?? '';
  return titleCaseSeed(label);
}

function isEligible(tab: EngineTab, blocklist: readonly string[]): boolean {
  if (tab.excluded || tab.pinned) return false;
  if (tab.groupId !== -1) return false; // in some group — hands off
  if (isBlocklisted(tab.url, blocklist)) return false;
  return true;
}

function draftSignature(draft: SuggestionDraft): string {
  return dismissalSignature(
    draft.kind,
    draft.tabIds,
    draft.kind === 'new-group'
      ? `name:${(draft.proposedName ?? '').toLowerCase()}`
      : (draft.targetGroupKey ?? ''),
  );
}

function domainOnlyDrafts(
  eligible: readonly EngineTab[],
  groups: readonly EngineGroup[],
  windowId: number,
): SuggestionDraft[] {
  const drafts: SuggestionDraft[] = [];
  const byHost = new Map<string, EngineTab[]>();
  for (const tab of eligible) {
    const host = hostOf(tab.url);
    if (host === '') continue;
    // A group whose live members all share this host takes the tab.
    const homeGroup = groups.find(
      (g) =>
        g.members.length > 0 &&
        g.members.every((m) => hostOf(m.url) === host),
    );
    if (homeGroup) {
      drafts.push({
        kind: 'add-to-group',
        windowId,
        tabIds: [tab.id],
        tabs: [tab],
        targetGroupKey: groupKeyOf(homeGroup.record),
        targetGroupName: homeGroup.record.name,
        proposedName: null,
        confidence: 0.5,
        source: 'domain-only',
        nanoFallback: false,
      });
      continue;
    }
    const bucket = byHost.get(host) ?? [];
    bucket.push(tab);
    byHost.set(host, bucket);
  }
  for (const [host, bucket] of byHost) {
    if (bucket.length < 2) continue;
    drafts.push({
      kind: 'new-group',
      windowId,
      tabIds: bucket.map((t) => t.id),
      tabs: bucket,
      targetGroupKey: null,
      targetGroupName: null,
      proposedName: titleCaseSeed(host.split('.')[0] ?? '') || 'New group',
      confidence: 0.5,
      source: 'domain-only',
      nanoFallback: false,
    });
  }
  return drafts;
}

function heuristicDrafts(
  eligible: readonly EngineTab[],
  groups: readonly EngineGroup[],
  scorer: Scorer,
  windowId: number,
): SuggestionDraft[] {
  const drafts: SuggestionDraft[] = [];
  const groupInputs: ScorerGroupInput[] = groups.map((g) => ({
    groupKey: groupKeyOf(g.record),
    name: g.record.name,
    exemplars: g.members,
  }));

  const clustered = new Set<number>();
  for (const cluster of scorer.clusterTabs(eligible)) {
    const members = cluster.tabIds
      .map((id) => eligible.find((t) => t.id === id))
      .filter((t): t is EngineTab => t !== undefined);
    if (members.length < 2) continue;
    for (const m of members) clustered.add(m.id);
    drafts.push({
      kind: 'new-group',
      windowId,
      tabIds: members.map((m) => m.id),
      tabs: members,
      targetGroupKey: null,
      targetGroupName: null,
      proposedName:
        titleCaseSeed(cluster.nameSeed) ||
        hostTopicName(members[0].url) ||
        'New group',
      confidence: cluster.cohesion,
      source: 'heuristics',
      nanoFallback: false,
    });
  }

  // Singletons: the router's top candidate (of its top-K) becomes an
  // add-to-group suggestion.
  for (const tab of eligible) {
    if (clustered.has(tab.id)) continue;
    const candidates = scorer.scoreCandidates(tab, groupInputs);
    const best = candidates[0];
    if (!best) continue;
    const group = groups.find(
      (g) => groupKeyOf(g.record) === best.groupKey,
    );
    if (!group) continue;
    drafts.push({
      kind: 'add-to-group',
      windowId,
      tabIds: [tab.id],
      tabs: [tab],
      targetGroupKey: best.groupKey,
      targetGroupName: group.record.name,
      proposedName: null,
      confidence: best.score,
      source: 'heuristics',
      nanoFallback: false,
    });
  }
  return drafts;
}

/** Build the suggestion inbox for one pass. Pure and synchronous —
 * Nano judging is layered on top by `applyNanoJudgments`. */
export function buildSuggestions(input: EngineInput): SuggestionDraft[] {
  if (input.rung === 'paused') return [];
  const dismissed = new Set(input.dismissed.map((d) => d.signature));
  const windowIds = [...new Set(input.tabs.map((t) => t.windowId))].sort(
    (a, b) => a - b,
  );
  const all: SuggestionDraft[] = [];
  for (const windowId of windowIds) {
    const tabs = input.tabs.filter((t) => t.windowId === windowId);
    const eligible = tabs.filter((t) => isEligible(t, input.blocklist));
    if (eligible.length === 0) continue;
    const groups = input.groups.filter(
      (g) => g.record.windowId === windowId,
    );
    const drafts =
      input.rung === 'domain-only'
        ? domainOnlyDrafts(eligible, groups, windowId)
        : heuristicDrafts(eligible, groups, input.scorer, windowId);
    const kept = drafts
      .filter((d) => !dismissed.has(draftSignature(d)))
      .sort(
        (a, b) =>
          b.confidence - a.confidence || a.tabIds[0] - b.tabIds[0],
      )
      .slice(0, MAX_SUGGESTIONS_PER_WINDOW);
    all.push(...kept);
  }
  return all.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.windowId - b.windowId ||
      a.tabIds[0] - b.tabIds[0],
  );
}

// -------------------------------------------------------------------
// Nano judging layer
// -------------------------------------------------------------------

/** The judge the worker injects: one validated verdict (or null)
 * per request; `callFailed` distinguishes transport/timeout
 * failures from malformed output. Both feed the circuit breaker. */
export type NanoJudgeFn = (req: JudgeRequest) => Promise<{
  verdict: NanoVerdict | null;
  callFailed: boolean;
}>;

export interface JudgeStats {
  calls: number;
  failures: number;
}

function judgeRequestFor(
  draft: SuggestionDraft,
  groups: readonly EngineGroup[],
): JudgeRequest {
  return {
    kind: draft.kind === 'new-group' ? 'cluster' : 'assign',
    tabs: draft.tabs.map((t) => ({ title: t.title, host: hostOf(t.url) })),
    candidateGroups: groups.map((g) => ({
      groupKey: groupKeyOf(g.record),
      name: g.record.name,
    })),
  };
}

/**
 * Run the Nano judge over heuristic drafts (nano rung only).
 * Sequential with per-draft isolation: one bad call never stalls or
 * sinks the batch. Drafts the judge rejects disappear; drafts whose
 * judging failed validation survive as heuristics fallbacks at
 * reduced confidence (×0.7), flagged `nanoFallback`.
 */
export async function applyNanoJudgments(
  drafts: readonly SuggestionDraft[],
  groups: readonly EngineGroup[],
  judge: NanoJudgeFn,
): Promise<{ drafts: SuggestionDraft[]; stats: JudgeStats }> {
  const stats: JudgeStats = { calls: 0, failures: 0 };
  const out: SuggestionDraft[] = [];
  for (const draft of drafts) {
    const windowGroups = groups.filter(
      (g) => g.record.windowId === draft.windowId,
    );
    let result: { verdict: NanoVerdict | null; callFailed: boolean };
    try {
      result = await judge(judgeRequestFor(draft, windowGroups));
    } catch {
      result = { verdict: null, callFailed: true };
    }
    stats.calls++;
    const verdict = result.verdict;
    if (!verdict) {
      stats.failures++;
      out.push({
        ...draft,
        confidence: draft.confidence * 0.7,
        nanoFallback: true,
      });
      continue;
    }
    if (verdict.action === 'reject') continue;
    if (verdict.action === 'add-to-group' && verdict.groupKey) {
      const group = windowGroups.find(
        (g) => groupKeyOf(g.record) === verdict.groupKey,
      );
      if (!group) continue;
      out.push({
        ...draft,
        kind: 'add-to-group',
        targetGroupKey: verdict.groupKey,
        targetGroupName: group.record.name,
        proposedName: null,
        confidence: 0.9,
        source: 'nano',
        nanoFallback: false,
      });
      continue;
    }
    if (draft.kind === 'add-to-group') {
      // new-topic / new-group for a single tab: a group of one is
      // not a suggestion — the tab stays unfiled.
      continue;
    }
    // Cluster drafts: new-group (judge's name wins) or new-topic
    // (the cluster IS the new topic; heuristic name stands).
    out.push({
      ...draft,
      proposedName:
        verdict.action === 'new-group' && verdict.name
          ? verdict.name
          : draft.proposedName,
      confidence: Math.min(0.95, draft.confidence + 0.1),
      source: 'nano',
      nanoFallback: false,
    });
  }
  return { drafts: out, stats };
}
