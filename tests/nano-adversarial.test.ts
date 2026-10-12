/**
 * Nano judge contract fuzzing (test-hardening commission,
 * method 5). The judge's output is untrusted input: a local model
 * that hallucinates JSON shapes. Everything here attacks the
 * validation boundary — validateVerdictText directly, and the
 * invariant that matters most end-to-end: UNVALIDATED OUTPUT IS
 * NEVER APPLIED. Malformed output degrades a draft to the
 * heuristics fallback at reduced confidence; it never renames,
 * retargets, or drops a draft on the model's say-so.
 *
 * Defect D6 (P1) was found here and fixed on this branch:
 * judgeAttempt's 10 s timeout covered only session.prompt (via
 * the abort signal); a create() that never resolved — the
 * model-download stall — wedged the grouping pass forever. The
 * whole attempt is now raced against the hard timeout, and a
 * session that arrives after the deadline is destroyed on
 * arrival. (downloadModel deliberately has NO timeout: a real
 * model download takes minutes and runs from a user gesture.)
 */

import { describe, expect, it } from 'vitest';
import {
  detectLanguageModel,
  judgeWithRetry,
  nanoAvailabilityProblem,
  normalizeAvailability,
  validateVerdictText,
  type JudgeRequest,
  type LanguageModelLike,
  type NanoSession,
} from '../src/lib/nano';
import { applyNanoJudgments, type SuggestionDraft } from '../src/lib/suggestions';
import type { ScorerTabInput } from '../src/lib/scorer';

const REQ: JudgeRequest = {
  kind: 'cluster',
  tabs: [
    { title: 'Quarterly planning notes', host: 'docs.google.com' },
    { title: 'Quarterly budget sheet', host: 'docs.google.com' },
    { title: 'Quarterly roadmap', host: 'docs.google.com' },
  ],
  candidateGroups: [{ groupKey: 'ts:g1', name: 'Existing Group' }],
};

const v = (text: string, req: JudgeRequest = REQ) =>
  validateVerdictText(text, req);

describe('validateVerdictText — shape strictness', () => {
  it('accepts the four simple actions in their exact shapes', () => {
    expect(v('{"action":"new-group","name":"Quarterly Work"}')).toEqual({
      action: 'new-group',
      name: 'Quarterly Work',
    });
    expect(v('{"action":"add-to-group","groupKey":"ts:g1"}')).toEqual({
      action: 'add-to-group',
      groupKey: 'ts:g1',
    });
    expect(v('{"action":"reject"}')).toEqual({ action: 'reject' });
    expect(v('{"action":"new-topic"}')).toEqual({ action: 'new-topic' });
  });

  it('tolerates prose around the JSON object (brace slicing), but not two objects', () => {
    expect(
      v('Here is my verdict: {"action":"reject"} — hope that helps'),
    ).toEqual({ action: 'reject' });
    expect(v('{"action":"reject"} {"action":"new-group","name":"X"}')).toBeNull();
  });

  it.each([
    ['no braces at all', 'reject'],
    ['empty object', '{}'],
    ['unknown action', '{"action":"merge-everything"}'],
    ['action wrong type', '{"action":7}'],
    ['extra key', '{"action":"reject","confidence":0.9}'],
    ['trailing garbage inside braces', '{"action":"reject",}'],
  ])('rejects %s', (_name, text) => {
    expect(v(text)).toBeNull();
  });

  it('non-split actions carrying split fields are invalid', () => {
    expect(v('{"action":"reject","groups":[]}')).toBeNull();
    expect(v('{"action":"new-group","name":"X","ungrouped":[]}')).toBeNull();
  });

  it('characterization: a reject carrying an irrelevant name is still a reject (name is an allowed key, ignored for this action)', () => {
    expect(v('{"action":"reject","name":"Whatever"}')).toEqual({
      action: 'reject',
    });
  });

  it('characterization: brace slicing also unwraps an array-wrapped object — the inner object still faces full validation, so the tolerance is safe', () => {
    expect(v('[{"action":"reject"}]')).toEqual({ action: 'reject' });
    expect(v('[{"action":"reject","smuggled":1}]')).toBeNull();
  });
});

describe('validateVerdictText — name and groupKey gates', () => {
  it('name is trimmed; empty, oversized, and non-string names fail', () => {
    expect(v('{"action":"new-group","name":"  Padded Name  "}')).toEqual({
      action: 'new-group',
      name: 'Padded Name',
    });
    expect(v('{"action":"new-group","name":"   "}')).toBeNull();
    expect(v(`{"action":"new-group","name":"${'x'.repeat(60)}"}`)).not.toBeNull();
    expect(v(`{"action":"new-group","name":"${'x'.repeat(61)}"}`)).toBeNull();
    expect(v('{"action":"new-group","name":42}')).toBeNull();
    expect(v('{"action":"new-group"}')).toBeNull();
  });

  it('platform names are invalid output for new-group', () => {
    expect(v('{"action":"new-group","name":"Google Docs"}')).toBeNull();
    expect(v('{"action":"new-group","name":"docs.google.com"}')).toBeNull();
    expect(v('{"action":"new-group","name":"docs"}')).toBeNull(); // shared host label
    // D7 linkage: the trailing-dot evasion dies here too.
    expect(v('{"action":"new-group","name":"google.com."}')).toBeNull();
  });

  it('the same word is a fine name when the tabs do not share that platform host', () => {
    const req: JudgeRequest = {
      kind: 'cluster',
      tabs: [
        { title: 'a', host: 'blog.example.com' },
        { title: 'b', host: 'news.example.org' },
      ],
      candidateGroups: [],
    };
    expect(v('{"action":"new-group","name":"Docs"}', req)).toEqual({
      action: 'new-group',
      name: 'Docs',
    });
  });

  it('add-to-group must name an OFFERED group key', () => {
    expect(v('{"action":"add-to-group","groupKey":"ts:other"}')).toBeNull();
    expect(v('{"action":"add-to-group","groupKey":7}')).toBeNull();
    expect(v('{"action":"add-to-group"}')).toBeNull();
  });
});

describe('validateVerdictText — split verdicts (Phase 3 partition contract)', () => {
  const split = (obj: unknown, req: JudgeRequest = REQ) =>
    v(JSON.stringify(obj), req);
  const GOOD = {
    action: 'split',
    groups: [{ name: 'Planning', tabs: [1, 2] }],
    ungrouped: [3],
  };

  it('accepts an exact partition: every tab in exactly one place', () => {
    expect(split(GOOD)).toEqual({
      action: 'split',
      groups: [{ name: 'Planning', tabs: [1, 2] }],
      ungrouped: [3],
    });
    expect(
      split({
        action: 'split',
        groups: [
          { name: 'A', tabs: [1, 2] },
          { name: 'B', tabs: [3, 4] },
        ],
        ungrouped: [],
      }, { ...REQ, tabs: [...REQ.tabs, { title: 'x', host: 'h' }] }),
    ).not.toBeNull();
  });

  it.each([
    ['a tab assigned twice', { ...GOOD, groups: [{ name: 'P', tabs: [1, 2] }, { name: 'Q', tabs: [2, 3] }], ungrouped: [] }],
    ['a tab omitted entirely', { ...GOOD, ungrouped: [] }],
    ['a tab in both a group and ungrouped', { ...GOOD, ungrouped: [2, 3] }],
    ['a duplicate inside ungrouped', { ...GOOD, ungrouped: [3, 3] }],
    ['an out-of-range index', { ...GOOD, groups: [{ name: 'P', tabs: [1, 4] }] }],
    ['a zero index', { ...GOOD, groups: [{ name: 'P', tabs: [0, 1] }] }],
    ['a float index', { ...GOOD, groups: [{ name: 'P', tabs: [1.5, 2] }] }],
    ['a string index', { ...GOOD, groups: [{ name: 'P', tabs: ['1', 2] }] }],
    ['a one-tab group', { ...GOOD, groups: [{ name: 'P', tabs: [1] }], ungrouped: [2, 3] }],
    ['no groups at all', { ...GOOD, groups: [] }],
    ['ungrouped missing', { action: 'split', groups: GOOD.groups }],
    ['ungrouped not an array', { ...GOOD, ungrouped: 3 }],
    ['a group with an extra key', { ...GOOD, groups: [{ name: 'P', tabs: [1, 2], color: 'red' }] }],
    ['a group with a platform name', { ...GOOD, groups: [{ name: 'Google Docs', tabs: [1, 2] }] }],
    ['a group that is not an object', { ...GOOD, groups: ['Planning'] }],
  ] as Array<[string, unknown]>)('rejects %s', (_name, obj) => {
    expect(split(obj)).toBeNull();
  });

  it('split is cluster-only: an assign request can never produce one', () => {
    expect(split(GOOD, { ...REQ, kind: 'assign' })).toBeNull();
  });
});

// ------------------------------------------------------------------
// judgeWithRetry against fake language models
// ------------------------------------------------------------------

interface FakeSession extends NanoSession {
  destroyed: boolean;
  prompts: string[];
}

function fakeLm(behavior: {
  create?: () => Promise<NanoSession>;
  prompt?: (input: string) => Promise<string>;
}): { lm: LanguageModelLike; sessions: FakeSession[]; createOptions: unknown[] } {
  const sessions: FakeSession[] = [];
  const createOptions: unknown[] = [];
  const lm: LanguageModelLike = {
    availability: async () => 'available',
    create: async (options) => {
      createOptions.push(options);
      if (behavior.create) return behavior.create();
      const session: FakeSession = {
        destroyed: false,
        prompts: [],
        prompt: async (input: string) => {
          session.prompts.push(input);
          if (behavior.prompt) return behavior.prompt(input);
          return '{"action":"reject"}';
        },
        destroy: () => {
          session.destroyed = true;
        },
      };
      sessions.push(session);
      return session;
    },
  };
  return { lm, sessions, createOptions };
}

describe('judgeWithRetry — retry and failure semantics', () => {
  it('a valid first answer takes one attempt; the session is destroyed; language options are declared', async () => {
    const { lm, sessions, createOptions } = fakeLm({});
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 1000 });
    expect(out).toEqual({
      verdict: { action: 'reject' },
      attempts: 1,
      callFailed: false,
    });
    expect(sessions[0].destroyed).toBe(true);
    expect(createOptions[0]).toMatchObject({
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
  });

  it('malformed output gets exactly one simpler retry, then gives up as a VALIDATION failure (not a call failure)', async () => {
    const { lm, sessions } = fakeLm({
      prompt: async () => 'the tabs look related to me',
    });
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 1000 });
    expect(out).toEqual({ verdict: null, attempts: 2, callFailed: false });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.destroyed)).toBe(true);
    // The retry uses the simpler prompt form.
    expect(sessions[0].prompts[0]).not.toBe(sessions[1].prompts[0]);
  });

  it('malformed first, valid second: the second verdict is used', async () => {
    let n = 0;
    const { lm } = fakeLm({
      prompt: async () =>
        ++n === 1 ? 'garbage' : '{"action":"new-group","name":"Quarterly Work"}',
    });
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 1000 });
    expect(out.verdict).toEqual({
      action: 'new-group',
      name: 'Quarterly Work',
    });
    expect(out.attempts).toBe(2);
  });

  it('a throwing prompt is a CALL failure: no retry, session still destroyed', async () => {
    const { lm, sessions } = fakeLm({
      prompt: async () => {
        throw new Error('model exploded');
      },
    });
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 1000 });
    expect(out).toEqual({ verdict: null, attempts: 1, callFailed: true });
    expect(sessions[0].destroyed).toBe(true);
  });

  it('a throwing create is a call failure with no retry', async () => {
    const { lm } = fakeLm({
      create: async () => {
        throw new Error('no model');
      },
    });
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 1000 });
    expect(out).toEqual({ verdict: null, attempts: 1, callFailed: true });
  });

  it('a prompt that hangs but honors the abort signal fails as a call failure, bounded', async () => {
    const sessions: FakeSession[] = [];
    const lm2: LanguageModelLike = {
      availability: async () => 'available',
      create: async () => {
        const session: FakeSession = {
          destroyed: false,
          prompts: [],
          prompt: (_input: string, options?: { signal?: AbortSignal }) =>
            new Promise<string>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            }),
          destroy: () => {
            session.destroyed = true;
          },
        };
        sessions.push(session);
        return session;
      },
    };
    const start = Date.now();
    const out = await judgeWithRetry(lm2, REQ, { timeoutMs: 60 });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out).toEqual({ verdict: null, attempts: 1, callFailed: true });
    expect(sessions[sessions.length - 1].destroyed).toBe(true);
  });

  it('a prompt that ignores the abort signal is still bounded by the hard timeout (D6 backstop)', async () => {
    const { lm, sessions } = fakeLm({
      prompt: () => new Promise<string>(() => undefined), // never settles
    });
    const start = Date.now();
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 60 });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out).toEqual({ verdict: null, attempts: 1, callFailed: true });
    expect(sessions[0].destroyed).toBe(true);
  });

  it('D6 regression: a create() that never resolves cannot wedge the judge', async () => {
    const { lm } = fakeLm({
      create: () => new Promise<NanoSession>(() => undefined),
    });
    const start = Date.now();
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 60 });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(out).toEqual({ verdict: null, attempts: 1, callFailed: true });
  });

  it('D6 regression: a session created after the timeout is destroyed on arrival', async () => {
    let resolveCreate: ((s: NanoSession) => void) | null = null;
    const lateSession: FakeSession = {
      destroyed: false,
      prompts: [],
      prompt: async () => '{"action":"reject"}',
      destroy: () => {
        lateSession.destroyed = true;
      },
    };
    const { lm } = fakeLm({
      create: () =>
        new Promise<NanoSession>((res) => {
          resolveCreate = res;
        }),
    });
    const out = await judgeWithRetry(lm, REQ, { timeoutMs: 40 });
    expect(out.callFailed).toBe(true);
    expect(lateSession.destroyed).toBe(false);
    resolveCreate!(lateSession);
    await new Promise((r) => setTimeout(r, 10));
    expect(lateSession.destroyed).toBe(true);
  });
});

// ------------------------------------------------------------------
// The never-apply-unvalidated invariant, end to end
// ------------------------------------------------------------------

describe('invariant: unvalidated model output is never applied', () => {
  const engineTab = (id: number, title: string): ScorerTabInput => ({
    id,
    title,
    url: `https://docs.google.com/document/d/D${id}/edit`,
    exactKey: `gdoc:document:D${id}/edit`,
    fuzzyKey: `gdoc:document:D${id}`,
  });
  const draft: SuggestionDraft = {
    kind: 'new-group',
    windowId: 1,
    tabIds: [1, 2, 3],
    tabs: [engineTab(1, 'A'), engineTab(2, 'B'), engineTab(3, 'C')],
    targetGroupKey: null,
    targetGroupName: null,
    proposedName: 'Heuristic Cluster',
    confidence: 0.8,
    source: 'heuristics',
    nanoFallback: false,
  };

  async function judgeReturning(text: string) {
    const { lm } = fakeLm({ prompt: async () => text });
    return (req: JudgeRequest) => judgeWithRetry(lm, req, { timeoutMs: 1000 });
  }

  it('a verdict naming an unoffered group degrades the draft to fallback — never retargets it', async () => {
    const judge = await judgeReturning(
      '{"action":"add-to-group","groupKey":"ts:not-offered"}',
    );
    const { drafts, stats } = await applyNanoJudgments([draft], [], judge);
    expect(stats).toEqual({ calls: 1, failures: 1 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].source).toBe('heuristics');
    expect(drafts[0].nanoFallback).toBe(true);
    expect(drafts[0].confidence).toBeCloseTo(0.56);
    expect(drafts[0].targetGroupKey).toBeNull();
  });

  it('a platform-named verdict degrades to fallback — the draft keeps its heuristic name', async () => {
    const judge = await judgeReturning(
      '{"action":"new-group","name":"Google Docs"}',
    );
    const { drafts } = await applyNanoJudgments([draft], [], judge);
    expect(drafts[0].proposedName).toBe('Heuristic Cluster');
    expect(drafts[0].nanoFallback).toBe(true);
  });

  it('a split verdict with an overlapping partition degrades to fallback — no partial application', async () => {
    const judge = await judgeReturning(
      JSON.stringify({
        action: 'split',
        groups: [
          { name: 'One', tabs: [1, 2] },
          { name: 'Two', tabs: [2, 3] },
        ],
        ungrouped: [],
      }),
    );
    const { drafts } = await applyNanoJudgments([draft], [], judge);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].nanoFallback).toBe(true);
    expect(drafts[0].tabIds).toEqual([1, 2, 3]);
  });

  it('pure garbage degrades to fallback after the internal retry', async () => {
    const judge = await judgeReturning('all three tabs are about quarterly work');
    const { drafts, stats } = await applyNanoJudgments([draft], [], judge);
    expect(stats.failures).toBe(1);
    expect(drafts[0].nanoFallback).toBe(true);
  });

  it('and a VALID verdict is applied — the boundary is validation, not distrust of everything', async () => {
    const judge = await judgeReturning(
      '{"action":"new-group","name":"Quarterly Work"}',
    );
    const { drafts, stats } = await applyNanoJudgments([draft], [], judge);
    expect(stats).toEqual({ calls: 1, failures: 0 });
    expect(drafts[0].source).toBe('nano');
    expect(drafts[0].proposedName).toBe('Quarterly Work');
    expect(drafts[0].nanoFallback).toBe(false);
  });

  it('a VALID split partitions the draft: sub-groups become nano drafts, ungrouped tabs get none', async () => {
    const judge = await judgeReturning(
      JSON.stringify({
        action: 'split',
        groups: [{ name: 'Pair Group', tabs: [1, 2] }],
        ungrouped: [3],
      }),
    );
    const { drafts, stats } = await applyNanoJudgments([draft], [], judge);
    expect(stats).toEqual({ calls: 1, failures: 0 });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].tabIds).toEqual([1, 2]);
    expect(drafts[0].proposedName).toBe('Pair Group');
    expect(drafts[0].source).toBe('nano');
    expect(drafts[0].fromPartition).toBe(true);
  });
});

// ------------------------------------------------------------------
// Detection and availability shapes
// ------------------------------------------------------------------

describe('detectLanguageModel / normalizeAvailability shape fuzz', () => {
  it('finds the modern global and the legacy ai.languageModel', () => {
    const lm = {
      availability: async () => 'available',
      create: async () => {
        throw new Error('unused');
      },
    };
    expect(detectLanguageModel({ LanguageModel: lm })).toBe(lm);
    expect(detectLanguageModel({ ai: { languageModel: lm } })).toBe(lm);
    expect(detectLanguageModel({ LanguageModel: lm, ai: {} })).toBe(lm);
  });

  it('rejects partial shapes', () => {
    expect(detectLanguageModel({})).toBeNull();
    expect(detectLanguageModel({ LanguageModel: { availability: async () => 'available' } })).toBeNull();
    expect(detectLanguageModel({ LanguageModel: { create: async () => ({}) } })).toBeNull();
    expect(detectLanguageModel({ ai: { languageModel: null } })).toBeNull();
    expect(detectLanguageModel({ LanguageModel: 'a string' })).toBeNull();
  });

  it('normalizes both availability shapes and defaults garbage to unavailable', () => {
    expect(normalizeAvailability('available')).toBe('available');
    expect(normalizeAvailability('readily')).toBe('available');
    expect(normalizeAvailability({ available: 'readily' })).toBe('available');
    expect(normalizeAvailability('downloadable')).toBe('downloadable');
    expect(normalizeAvailability({ available: 'after-download' })).toBe('downloadable');
    expect(normalizeAvailability('downloading')).toBe('downloading');
    for (const junk of [null, undefined, 42, {}, { available: 5 }, 'yes', []] as unknown[]) {
      expect(normalizeAvailability(junk)).toBe('unavailable');
    }
    expect(nanoAvailabilityProblem('available')).toBeNull();
    expect(nanoAvailabilityProblem('downloadable')).toBe('not-downloaded');
    expect(nanoAvailabilityProblem('downloading')).toBe('downloading');
    expect(nanoAvailabilityProblem('unavailable')).toBe('unavailable');
  });
});
