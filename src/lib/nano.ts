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
}

export type NanoAction = 'new-group' | 'add-to-group' | 'reject' | 'new-topic';

export interface NanoVerdict {
  action: NanoAction;
  /** Required for `new-group`; a short free-form group name. */
  name?: string;
  /** Required for `add-to-group`; must be one of the offered keys. */
  groupKey?: string;
}

export const MAX_GROUP_NAME_LENGTH = 60;

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
    if (key !== 'action' && key !== 'name' && key !== 'groupKey') {
      return null;
    }
  }
  const action = obj.action;
  if (
    action !== 'new-group' &&
    action !== 'add-to-group' &&
    action !== 'reject' &&
    action !== 'new-topic'
  ) {
    return null;
  }
  if (action === 'new-group') {
    const name = obj.name;
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (trimmed === '' || trimmed.length > MAX_GROUP_NAME_LENGTH) {
      return null;
    }
    return { action, name: trimmed };
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
    return [
      'Decide how to organize these browser tabs.',
      `Tabs:\n${describeTabs(req.tabs)}`,
      `Existing groups:\n${describeGroups(req.candidateGroups)}`,
      'Reply with JSON only, exactly one of:',
      '{"action":"new-group","name":"<short name>"}',
      '{"action":"add-to-group","groupKey":"<one group key above>"}',
      '{"action":"reject"}',
      '{"action":"new-topic"}',
    ].join('\n');
  }
  const task =
    req.kind === 'cluster'
      ? 'These browser tabs were clustered by a heuristic that thinks they belong together. Decide whether they form one coherent topic group, belong in one of the existing groups instead, or should not be grouped at all.'
      : 'This browser tab was matched by a heuristic to a group. Decide whether it belongs in one of the existing groups, starts a genuinely new topic, or should not be grouped at all.';
  return [
    task,
    `Tabs:\n${describeTabs(req.tabs)}`,
    `Existing groups:\n${describeGroups(req.candidateGroups)}`,
    'Answer with a single JSON object and nothing else:',
    '- {"action":"new-group","name":"<short descriptive name>"} to create a new group',
    '- {"action":"add-to-group","groupKey":"<group key>"} to file into an existing group',
    '- {"action":"new-topic"} when the tab(s) start a topic of their own',
    '- {"action":"reject"} when grouping them would be wrong',
  ].join('\n');
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

export interface LanguageModelLike {
  availability(): Promise<unknown>;
  create(options?: { systemPrompt?: string }): Promise<NanoSession>;
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
