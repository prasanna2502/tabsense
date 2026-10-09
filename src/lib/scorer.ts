/**
 * Heuristic scorer / clusterer (M2) — TypeScript mirror of the Rust
 * core's `scorer.rs`. The worker prefers the Wasm implementation
 * (via `src/wasm/load.ts`) and falls back to this one while the core
 * is instantiating or if it failed — the same engine-selection
 * pattern as the canonicalizer. Both implementations share
 * tokenization, weights, and thresholds, and the same fixture cases
 * run in vitest and in `cargo test` (1e-6 tolerance).
 *
 * The router contract (execution plan E4): score a tab against
 * existing groups → top-K (≤5) candidates; cluster ungrouped tabs →
 * candidate new groups. Nothing here applies anything — the
 * suggestion engine and the Nano judge sit downstream.
 */

export interface ScorerTabInput {
  id: number;
  title: string;
  url: string;
  exactKey: string | null;
  fuzzyKey: string | null;
}

export interface ScorerGroupInput {
  groupKey: string;
  name: string;
  exemplars: ScorerTabInput[];
}

export interface ScorerCandidate {
  groupKey: string;
  score: number;
}

export interface ScorerCluster {
  tabIds: number[];
  nameSeed: string;
  cohesion: number;
}

export interface Scorer {
  scoreCandidates(
    tab: ScorerTabInput,
    groups: readonly ScorerGroupInput[],
  ): ScorerCandidate[];
  clusterTabs(tabs: readonly ScorerTabInput[]): ScorerCluster[];
}

/** Minimum score for "add this tab to that group" candidates. */
export const ADD_THRESHOLD = 0.45;
/** Minimum mean affinity for a tab to join a forming cluster. */
export const CLUSTER_THRESHOLD = 0.36;
/** Maximum candidate groups returned per tab (the router contract). */
export const TOP_K = 5;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'com', 'for', 'from',
  'get', 'how', 'html', 'http', 'https', 'i', 'in', 'into', 'is', 'it',
  'its', 'me', 'my', 'new', 'of', 'on', 'or', 'our', 'page', 'that',
  'the', 'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where',
  'why', 'with', 'www', 'you', 'your',
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  let cur = '';
  const flush = () => {
    if (cur.length >= 2 && !STOPWORDS.has(cur)) out.add(cur);
    cur = '';
  };
  for (const ch of text) {
    if (/[a-zA-Z0-9]/.test(ch)) cur += ch.toLowerCase();
    else flush();
  }
  flush();
  return out;
}

/** Host for scoring: lowercase, leading "www." stripped (repeatedly,
 * matching the Rust core). "" for unparseable URLs. */
export function hostOf(url: string): string {
  try {
    let host = new URL(url).hostname.toLowerCase();
    while (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '';
  }
}

interface Features {
  id: number;
  host: string;
  titleTokens: Set<string>;
  pathTokens: Set<string>;
  fuzzyKey: string | null;
}

function featuresOf(tab: ScorerTabInput): Features {
  const pathTokens = new Set<string>();
  let host = '';
  try {
    const parsed = new URL(tab.url);
    host = hostOf(tab.url);
    for (const segment of parsed.pathname.split('/')) {
      for (const tok of tokenize(segment)) pathTokens.add(tok);
    }
  } catch {
    // Unparseable URL: no host/path features; title still scores.
  }
  return {
    id: tab.id,
    host,
    titleTokens: tokenize(tab.title),
    pathTokens,
    fuzzyKey: tab.fuzzyKey,
  };
}

/** Title containment |A∩B| / min(|A|,|B|), damped by half only when
 * the shorter title has ≤2 tokens and the titles share fewer than 2
 * (see scorer.rs for the rationale). */
function titleScore(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (min === 0) return 0;
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter++;
  const containment = inter / min;
  return inter < 2 && min <= 2 ? containment * (inter / 2) : containment;
}

function overlapCoeff(a: Set<string>, b: Set<string>): number {
  const min = Math.min(a.size, b.size);
  if (min === 0) return 0;
  let inter = 0;
  for (const tok of a) if (b.has(tok)) inter++;
  return inter / min;
}

/** Pairwise affinity between two tabs:
 * 0.25·same-host + 0.60·title containment + 0.10·path overlap
 * + 0.25·same-fuzzy-key, clamped to 1. */
export function pairScore(a: ScorerTabInput, b: ScorerTabInput): number {
  return pairScoreFeatures(featuresOf(a), featuresOf(b));
}

function pairScoreFeatures(a: Features, b: Features): number {
  let score = 0;
  if (a.host !== '' && a.host === b.host) score += 0.25;
  score += 0.6 * titleScore(a.titleTokens, b.titleTokens);
  score += 0.1 * overlapCoeff(a.pathTokens, b.pathTokens);
  if (a.fuzzyKey && b.fuzzyKey && a.fuzzyKey === b.fuzzyKey) score += 0.25;
  return Math.min(1, score);
}

function groupScore(tab: Features, exemplars: readonly Features[]): number {
  let best = 0;
  let supporters = 0;
  for (const ex of exemplars) {
    const s = pairScoreFeatures(tab, ex);
    if (s > best) best = s;
    if (s >= 0.4) supporters++;
  }
  if (supporters > 1) best = Math.min(1, best + 0.05 * (supporters - 1));
  return best;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function scoreCandidates(
  tab: ScorerTabInput,
  groups: readonly ScorerGroupInput[],
): ScorerCandidate[] {
  const tf = featuresOf(tab);
  const out: ScorerCandidate[] = [];
  for (const g of groups) {
    const score = groupScore(tf, g.exemplars.map(featuresOf));
    if (score >= ADD_THRESHOLD) out.push({ groupKey: g.groupKey, score });
  }
  out.sort(
    (a, b) => b.score - a.score || compareStrings(a.groupKey, b.groupKey),
  );
  return out.slice(0, TOP_K);
}

function meanAffinity(tab: Features, members: readonly Features[]): number {
  if (members.length === 0) return 0;
  let sum = 0;
  for (const m of members) sum += pairScoreFeatures(tab, m);
  return sum / members.length;
}

function nameSeed(members: readonly Features[]): string {
  const counts = new Map<string, number>();
  for (const m of members) {
    for (const tok of m.titleTokens) {
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const tok of [...counts.keys()].sort(compareStrings)) {
    const count = counts.get(tok) as number;
    if (count > bestCount) {
      best = tok;
      bestCount = count;
    }
  }
  if (best !== null) return best;
  return members[0]?.host.split('.')[0] ?? '';
}

/** Greedy deterministic clustering (see scorer.rs). */
export function clusterTabs(
  tabs: readonly ScorerTabInput[],
): ScorerCluster[] {
  const ordered = [...tabs].sort((a, b) => a.id - b.id);
  const feats = ordered.map(featuresOf);
  const clusters: Features[][] = [];
  for (const f of feats) {
    let bestIdx = -1;
    let bestAff = 0;
    for (let i = 0; i < clusters.length; i++) {
      const aff = meanAffinity(f, clusters[i]);
      if (aff >= CLUSTER_THRESHOLD && aff > bestAff) {
        bestAff = aff;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) clusters[bestIdx].push(f);
    else clusters.push([f]);
  }
  const out: ScorerCluster[] = [];
  for (const members of clusters) {
    if (members.length < 2) continue;
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        sum += pairScoreFeatures(members[i], members[j]);
        pairs++;
      }
    }
    out.push({
      tabIds: members.map((m) => m.id),
      nameSeed: nameSeed(members),
      cohesion: pairs > 0 ? sum / pairs : 0,
    });
  }
  return out;
}

/** The TS implementation of the router contract. */
export const tsScorer: Scorer = { scoreCandidates, clusterTabs };
