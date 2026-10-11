/**
 * Gemini Nano judge client (M2) — the "judge" of the grouping
 * pipeline (execution plan E4). The heuristic router proposes
 * candidates; this client asks the on-device model (Chrome's
 * built-in LanguageModel API) to confirm, reject, reassign, or
 * declare a new topic, and to name new groups.
 *
 * Trust rules (proposal §11):
 *  - Every response is parsed against a strict schema
 *    (`validateVerdictText`). Anything else — extra fields, unknown
 *    actions, a group that was not offered, an over-long name — is
 *    rejected as if the model had said nothing.
 *  - Malformed output gets exactly one retry with a simpler prompt,
 *    then the caller falls back to the heuristics-only suggestion at
 *    reduced confidence. Unvalidated output is never applied.
 *  - Every call has a hard timeout (default 10 s) enforced with an
 *    AbortController, and the session is always destroyed.
 *
 * Context note: this module is context-agnostic — it talks to
 * whatever `LanguageModel` global its host context exposes. The M2
 * worker hosts it directly (see the M2 report's Decisions for why
 * an offscreen document is not used in this milestone).
 */

import { isPlatformGroupName } from './groups';

export interface JudgeTabRef {
  title: string;
  host: string;
}

export interface JudgeGroupRef {
  groupKey: string;
  name: string;
}

export interface JudgeRequest {
  kind: 'cluster' | 'assign';
  tabs: JudgeTabRef[];
  candidateGroups: JudgeGroupRef[];
  /** Phase 3: this cluster was flagged as a likely over-merge
   * (size, low same-platform cohesion, or a majority-theme name),
   * so the judge is asked for a partition, not an accept/reject. */
  splitEvaluation?: boolean;
}

export type NanoAction =
  | 'new-group'
  | 'add-to-group'
  | 'reject'
  | 'new-topic'
  | 'split';

export interface NanoVerdict {
  action: NanoAction;
  /** Required for `new-group`; a short free-form group name. */
  name?: string;
  /** Required for `add-to-group`; must be one of the offered keys. */
  groupKey?: string;
  /** Required for `split`: the partition's sub-groups. `tabs` are
   * 1-based indices into the request's tab list, as listed in the
   * prompt. */
  groups?: { name: string; tabs: number[] }[];
  /** Required for `split`: 1-based indices the judge deliberately
   * leaves ungrouped. Together with the groups' tabs it must
   * cover every tab in the request exactly once. */
  ungrouped?: number[];
}

export const MAX_GROUP_NAME_LENGTH = 60;

/** The host all of the request's tabs share, or null. */
function sharedHostOf(req: JudgeRequest): string | null {
  const hosts = new Set(req.tabs.map((t) => t.host));
  return hosts.size === 1 ? [...hosts][0] : null;
}

function validGroupName(name: unknown, req: JudgeRequest): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > MAX_GROUP_NAME_LENGTH) {
    return null;
  }
  if (isPlatformGroupName(trimmed, sharedHostOf(req))) return null;
  return trimmed;
}

/**
 * Strict validation of a `split` verdict (Phase 3): cluster
 * requests only; a non-empty list of sub-groups, each with a valid
 * topic name and at least two in-range tab indices; an explicit
 * ungrouped list; and groups + ungrouped together covering every
 * tab in the request exactly once — no tab in two places, no tab
 * silently dropped. Any violation makes the whole verdict invalid
 * output, exactly like any other malformed verdict.
 */
function validateSplitVerdict(
  obj: Record<string, unknown>,
  req: JudgeRequest,
): NanoVerdict | null {
  if (req.kind !== 'cluster') return null;
  const n = req.tabs.length;
  const groupsRaw = obj.groups;
  const ungroupedRaw = obj.ungrouped;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) return null;
  if (!Array.isArray(ungroupedRaw)) return null;
  const seen = new Set<number>();
  const takeIndices = (raw: unknown): number[] | null => {
    if (!Array.isArray(raw)) return null;
    const out: number[] = [];
    for (const v of raw) {
      if (typeof v !== 'number' || !Number.isInteger(v)) return null;
      if (v < 1 || v > n || seen.has(v)) return null;
      seen.add(v);
      out.push(v);
    }
    return out;
  };
  const groups: { name: string; tabs: number[] }[] = [];
  for (const g of groupsRaw) {
    if (typeof g !== 'object' || g === null) return null;
    const gobj = g as Record<string, unknown>;
    for (const key of Object.keys(gobj)) {
      if (key !== 'name' && key !== 'tabs') return null;
    }
    const name = validGroupName(gobj.name, req);
    if (name === null) return null;
    const tabs = takeIndices(gobj.tabs);
    if (tabs === null || tabs.length < 2) return null;
    groups.push({ name, tabs });
  }
  const ungrouped = takeIndices(ungroupedRaw);
  if (ungrouped === null) return null;
  if (seen.size !== n) return null; // every tab accounted for
  return { action: 'split', groups, ungrouped };
}

/** Strict verdict validation. Returns null for anything that is not
 * exactly one well-formed verdict for this request. */
export function validateVerdictText(
  text: string,
  req: JudgeRequest,
): NanoVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (
      key !== 'action' &&
      key !== 'name' &&
      key !== 'groupKey' &&
      key !== 'groups' &&
      key !== 'ungrouped'
    ) {
      return null;
    }
  }
  const action = obj.action;
  if (
    action !== 'new-group' &&
    action !== 'add-to-group' &&
    action !== 'reject' &&
    action !== 'new-topic' &&
    action !== 'split'
  ) {
    return null;
  }
  if (action !== 'split' && ('groups' in obj || 'ungrouped' in obj)) {
    return null;
  }
  if (action === 'split') {
    return validateSplitVerdict(obj, req);
  }
  if (action === 'new-group') {
    // A name that is just the platform/domain the tabs live on is
    // invalid output (Phase 3) — it names the container, not the
    // topic. Rejection routes through the usual invalid-output
    // path (one simpler retry, then suggestion-only fallback).
    const name = validGroupName(obj.name, req);
    if (name === null) return null;
    return { action, name };
  }
  if (action === 'add-to-group') {
    const groupKey = obj.groupKey;
    if (typeof groupKey !== 'string') return null;
    if (!req.candidateGroups.some((g) => g.groupKey === groupKey)) {
      return null;
    }
    return { action, groupKey };
  }
  return { action };
}

function describeTabs(tabs: JudgeTabRef[]): string {
  return tabs
    .map((t, i) => `${i + 1}. "${t.title}" (${t.host})`)
    .join('\n');
}

function describeGroups(groups: JudgeGroupRef[]): string {
  if (groups.length === 0) return '(no existing groups)';
  return groups.map((g) => `- ${g.groupKey}: "${g.name}"`).join('\n');
}

/** The judge prompt. `simple` is the retry form: shorter, with the
 * answer shape spelled out as a template. */
export function buildJudgePrompt(req: JudgeRequest, simple = false): string {
  if (simple) {
    const lines = [
      'Decide how to organize these browser tabs.',
      `Tabs:\n${describeTabs(req.tabs)}`,
      `Existing groups:\n${describeGroups(req.candidateGroups)}`,
      'Reply with JSON only, exactly one of:',
      '{"action":"new-group","name":"<short name>"}',
      '{"action":"add-to-group","groupKey":"<one group key above>"}',
      '{"action":"reject"}',
      '{"action":"new-topic"}',
    ];
    if (req.kind === 'cluster') {
      lines.push(
        '{"action":"split","groups":[{"name":"<topic name>","tabs":[<tab numbers>]}],"ungrouped":[<tab numbers>]}',
      );
    }
    lines.push('Names must name the topic, never the website.');
    return lines.join('\n');
  }
  const task =
    req.kind === 'cluster'
      ? 'These browser tabs were clustered by a heuristic that thinks they belong together. Decide whether they form one coherent topic group, belong in one of the existing groups instead, or should not be grouped at all.'
      : 'This browser tab was matched by a heuristic to a group. Decide whether it belongs in one of the existing groups, starts a genuinely new topic, or should not be grouped at all.';
  const lines = [
    task,
    `Tabs:\n${describeTabs(req.tabs)}`,
    `Existing groups:\n${describeGroups(req.candidateGroups)}`,
  ];
  if (req.kind === 'cluster') {
    lines.push(
      'If the tabs span more than one topic, do not force them into one group. Answer with a split instead: {"action":"split","groups":[{"name":"<topic name>","tabs":[<tab numbers>]}],"ungrouped":[<tab numbers>]} — one entry per topic (at least two tabs each), listing every tab number exactly once: in one group, or in "ungrouped" when it belongs to no topic.',
      'Tabs that merely share a website — above all a document platform like Google Docs or Notion, where one site holds many unrelated documents — are not one topic. A single group covering many tabs from one such platform is presumptively wrong: split it by topic, or reject it.',
    );
    if (req.splitEvaluation) {
      lines.push(
        'This cluster was flagged as a likely over-merge (too large, low title cohesion, or named for a theme many of its tabs do not share). Prefer a split, or reject it; answer new-group only if every tab genuinely shares one topic.',
      );
    }
  }
  lines.push(
    'Group names must name the topic — never the website or platform the tabs share (not "Google", "Google Docs", "Notion", or a domain name).',
    'Answer with a single JSON object and nothing else:',
    '- {"action":"new-group","name":"<short descriptive name>"} to create a new group',
    '- {"action":"add-to-group","groupKey":"<group key>"} to file into an existing group',
    '- {"action":"new-topic"} when the tab(s) start a topic of their own',
    '- {"action":"reject"} when grouping them would be wrong',
  );
  if (req.kind === 'cluster') {
    lines.push(
      '- {"action":"split","groups":[{"name":"<topic name>","tabs":[<tab numbers>]}],"ungrouped":[<tab numbers>]} to split into topic groups',
    );
  }
  return lines.join('\n');
}

// -------------------------------------------------------------------
// LanguageModel surface (the slice this client uses). Both the
// current `LanguageModel` global and the older `ai.languageModel`
// shape are recognized.
// -------------------------------------------------------------------

export interface NanoSession {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

/** The slice of the Prompt API's download monitor this client uses:
 * Chrome fires `downloadprogress` events on it while the model
 * downloads (loaded is a 0..1 fraction, when the browser reports
 * one at all). */
export interface NanoDownloadMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded?: number }) => void,
  ): void;
}

/** Language expectations declared on every create() call: Chrome
 * logs a console warning ("No output language was specified…")
 * when they are omitted. TabSense prompts and parses in English,
 * so every session this client creates declares English in/out. */
export const NANO_LANGUAGE_OPTIONS: {
  expectedInputs: { type: string; languages: string[] }[];
  expectedOutputs: { type: string; languages: string[] }[];
} = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

export interface LanguageModelLike {
  availability(): Promise<unknown>;
  create(options?: {
    systemPrompt?: string;
    monitor?: (m: NanoDownloadMonitor) => void;
    expectedInputs?: { type: string; languages: string[] }[];
    expectedOutputs?: { type: string; languages: string[] }[];
  }): Promise<NanoSession>;
}

export function detectLanguageModel(
  scope: Record<string, unknown> = globalThis as unknown as Record<
    string,
    unknown
  >,
): LanguageModelLike | null {
  const direct = scope['LanguageModel'] as LanguageModelLike | undefined;
  if (
    direct &&
    typeof direct.availability === 'function' &&
    typeof direct.create === 'function'
  ) {
    return direct;
  }
  const ai = scope['ai'] as { languageModel?: LanguageModelLike } | undefined;
  const legacy = ai?.languageModel;
  if (
    legacy &&
    typeof legacy.availability === 'function' &&
    typeof legacy.create === 'function'
  ) {
    return legacy;
  }
  return null;
}

export type NanoAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable';

/** Normalize both availability shapes (string enum, and the older
 * `{available: 'readily' | 'after-download' | 'no'}` object). */
export function normalizeAvailability(raw: unknown): NanoAvailability {
  const value =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && raw !== null
        ? String((raw as Record<string, unknown>)['available'] ?? '')
        : '';
  switch (value) {
    case 'available':
    case 'readily':
      return 'available';
    case 'downloadable':
    case 'after-download':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    default:
      return 'unavailable';
  }
}

/** Why the on-device model cannot judge right now, for the
 * settings surface: the not-downloaded states are actionable (a
 * user gesture can start the download), `unavailable` is not. */
export type NanoAvailabilityProblem =
  | 'not-downloaded'
  | 'downloading'
  | 'unavailable';

export function nanoAvailabilityProblem(
  availability: NanoAvailability,
): NanoAvailabilityProblem | null {
  switch (availability) {
    case 'available':
      return null;
    case 'downloadable':
      return 'not-downloaded';
    case 'downloading':
      return 'downloading';
    case 'unavailable':
      return 'unavailable';
  }
}

/**
 * Trigger the on-device model download. The Prompt API only starts
 * a download from a user activation, so this is called from a click
 * handler chain (panel button → worker message → here); creating a
 * session is what kicks the download off, and the monitor reports
 * progress. The probe session is destroyed immediately — judging
 * creates its own sessions. Returns true when the create resolved
 * (download finished or the model became usable); false on any
 * error. Never throws.
 */
export async function downloadModel(
  lm: LanguageModelLike,
  onProgress?: (loaded: number | null) => void,
): Promise<boolean> {
  let session: NanoSession | null = null;
  try {
    session = await lm.create({
      ...NANO_LANGUAGE_OPTIONS,
      monitor: (m) => {
        m.addEventListener('downloadprogress', (event) => {
          onProgress?.(
            typeof event.loaded === 'number' ? event.loaded : null,
          );
        });
      },
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      session?.destroy();
    } catch {
      // Same rationale as judgeAttempt: not worth failing over.
    }
  }
}

export const DEFAULT_NANO_TIMEOUT_MS = 10_000;

export interface JudgeOutcome {
  /** The validated verdict, or null when both attempts failed
   * validation (or the call itself failed). The caller falls back
   * to the heuristics-only suggestion at reduced confidence. */
  verdict: NanoVerdict | null;
  attempts: number;
  /** True when the call threw or timed out (a breaker signal), as
   * opposed to merely producing malformed output. */
  callFailed: boolean;
}

/** One judge attempt: create a session, prompt with a hard timeout,
 * validate strictly, always destroy the session. Never throws. */
async function judgeAttempt(
  lm: LanguageModelLike,
  req: JudgeRequest,
  timeoutMs: number,
  simple: boolean,
): Promise<{ verdict: NanoVerdict | null; callFailed: boolean }> {
  let session: NanoSession | null = null;
  try {
    session = await lm.create({
      ...NANO_LANGUAGE_OPTIONS,
      systemPrompt:
        'You organize browser tabs into topic groups. You answer with one JSON object only.',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const text = await session.prompt(buildJudgePrompt(req, simple), {
        signal: controller.signal,
      });
      return { verdict: validateVerdictText(text, req), callFailed: false };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { verdict: null, callFailed: true };
  } finally {
    try {
      session?.destroy();
    } catch {
      // A session that won't destroy is not worth failing over.
    }
  }
}

/** Judge with the §11 retry rule: one retry with a simpler prompt,
 * then give up (null) — the caller degrades to heuristics. */
export async function judgeWithRetry(
  lm: LanguageModelLike,
  req: JudgeRequest,
  options: { timeoutMs?: number } = {},
): Promise<JudgeOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NANO_TIMEOUT_MS;
  const first = await judgeAttempt(lm, req, timeoutMs, false);
  if (first.verdict) {
    return { verdict: first.verdict, attempts: 1, callFailed: false };
  }
  if (first.callFailed) {
    return { verdict: null, attempts: 1, callFailed: true };
  }
  const second = await judgeAttempt(lm, req, timeoutMs, true);
  return {
    verdict: second.verdict,
    attempts: 2,
    callFailed: second.callFailed,
  };
}
