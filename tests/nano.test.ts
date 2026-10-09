import { describe, expect, it } from 'vitest';
import {
  buildJudgePrompt,
  judgeWithRetry,
  normalizeAvailability,
  validateVerdictText,
  type JudgeRequest,
  type LanguageModelLike,
  type NanoSession,
} from '../src/lib/nano';

const REQ: JudgeRequest = {
  kind: 'assign',
  tabs: [{ title: 'Chicken soup recipe', host: 'allrecipes.com' }],
  candidateGroups: [
    { groupKey: 'ts:g1', name: 'Recipes' },
    { groupKey: 'ts:g2', name: 'Travel' },
  ],
};

describe('validateVerdictText', () => {
  it('accepts a well-formed add-to-group verdict (prose around JSON tolerated)', () => {
    expect(
      validateVerdictText(
        'Here is my answer: {"action":"add-to-group","groupKey":"ts:g1"}',
        REQ,
      ),
    ).toEqual({ action: 'add-to-group', groupKey: 'ts:g1' });
  });

  it('accepts new-group with a name, and reject / new-topic bare', () => {
    expect(
      validateVerdictText('{"action":"new-group","name":"Comfort Food"}', REQ),
    ).toEqual({ action: 'new-group', name: 'Comfort Food' });
    expect(validateVerdictText('{"action":"reject"}', REQ)).toEqual({
      action: 'reject',
    });
    expect(validateVerdictText('{"action":"new-topic"}', REQ)).toEqual({
      action: 'new-topic',
    });
  });

  it('rejects a group that was not offered', () => {
    expect(
      validateVerdictText('{"action":"add-to-group","groupKey":"ts:nope"}', REQ),
    ).toBeNull();
  });

  it('rejects extra fields, unknown actions, and malformed JSON', () => {
    expect(
      validateVerdictText(
        '{"action":"reject","confidence":0.9}',
        REQ,
      ),
    ).toBeNull();
    expect(validateVerdictText('{"action":"merge-everything"}', REQ)).toBeNull();
    expect(validateVerdictText('not json at all', REQ)).toBeNull();
    expect(validateVerdictText('{"action":"reject"', REQ)).toBeNull();
  });

  it('rejects a missing, blank, or over-long group name', () => {
    expect(validateVerdictText('{"action":"new-group"}', REQ)).toBeNull();
    expect(
      validateVerdictText('{"action":"new-group","name":"   "}', REQ),
    ).toBeNull();
    expect(
      validateVerdictText(
        `{"action":"new-group","name":"${'x'.repeat(61)}"}`,
        REQ,
      ),
    ).toBeNull();
  });
});

describe('normalizeAvailability', () => {
  it('maps both API shapes', () => {
    expect(normalizeAvailability('available')).toBe('available');
    expect(normalizeAvailability('downloadable')).toBe('downloadable');
    expect(normalizeAvailability('downloading')).toBe('downloading');
    expect(normalizeAvailability('unavailable')).toBe('unavailable');
    expect(normalizeAvailability({ available: 'readily' })).toBe('available');
    expect(normalizeAvailability({ available: 'after-download' })).toBe(
      'downloadable',
    );
    expect(normalizeAvailability({ available: 'no' })).toBe('unavailable');
    expect(normalizeAvailability(undefined)).toBe('unavailable');
  });
});

function mockLm(responses: (string | Error)[]): LanguageModelLike {
  let calls = 0;
  return {
    availability: () => Promise.resolve('available'),
    create: () => {
      const response = responses[Math.min(calls++, responses.length - 1)];
      const session: NanoSession = {
        prompt: () =>
          response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response),
        destroy: () => undefined,
      };
      return Promise.resolve(session);
    },
  };
}

describe('judgeWithRetry', () => {
  it('returns a first-attempt verdict without retrying', async () => {
    const lm = mockLm(['{"action":"reject"}']);
    const outcome = await judgeWithRetry(lm, REQ);
    expect(outcome.verdict).toEqual({ action: 'reject' });
    expect(outcome.attempts).toBe(1);
    expect(outcome.callFailed).toBe(false);
  });

  it('retries once with a simpler prompt after malformed output', async () => {
    const lm = mockLm(['I think it goes in Recipes!', '{"action":"add-to-group","groupKey":"ts:g1"}']);
    const outcome = await judgeWithRetry(lm, REQ);
    expect(outcome.verdict).toEqual({
      action: 'add-to-group',
      groupKey: 'ts:g1',
    });
    expect(outcome.attempts).toBe(2);
  });

  it('gives up after two malformed attempts (caller falls back to heuristics)', async () => {
    const lm = mockLm(['garbage', 'still garbage']);
    const outcome = await judgeWithRetry(lm, REQ);
    expect(outcome.verdict).toBeNull();
    expect(outcome.attempts).toBe(2);
    expect(outcome.callFailed).toBe(false);
  });

  it('reports a throwing call as a failure without retrying', async () => {
    const lm = mockLm([new Error('model exploded')]);
    const outcome = await judgeWithRetry(lm, REQ);
    expect(outcome.verdict).toBeNull();
    expect(outcome.callFailed).toBe(true);
    expect(outcome.attempts).toBe(1);
  });

  it('times out a hung prompt via the abort signal', async () => {
    const lm: LanguageModelLike = {
      availability: () => Promise.resolve('available'),
      create: () =>
        Promise.resolve({
          prompt: (_input: string, opts?: { signal?: AbortSignal }) =>
            new Promise<string>((_resolve, reject) => {
              opts?.signal?.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            }),
          destroy: () => undefined,
        }),
    };
    const outcome = await judgeWithRetry(lm, REQ, { timeoutMs: 20 });
    expect(outcome.verdict).toBeNull();
    expect(outcome.callFailed).toBe(true);
  });

  it('the retry prompt is the simple template form', () => {
    expect(buildJudgePrompt(REQ, true)).toContain('Reply with JSON only');
    expect(buildJudgePrompt(REQ, false)).toContain('JSON object');
  });
});
