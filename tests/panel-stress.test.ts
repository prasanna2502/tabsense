/**
 * Panel-model stress tests (test-hardening commission,
 * method 6): the side panel's pure display helpers at the shapes
 * real tab sets take — 40+ member fuzzy sets, members differing
 * in several URL components at once, unparseable URLs mixed into
 * a set, credentials/ports/IDN in host labels, recency ties.
 *
 * Also pinned here: the D8 hypothesis from the hardening plan —
 * that faviconFallbackLetter could return a LONE SURROGATE for a
 * title starting with an astral-plane letter — was tested and
 * REFUTED: the regex carries the `u` flag, so the match is the
 * whole code point. The regression test below keeps it that way.
 */

import { describe, expect, it } from 'vitest';
import {
  describeMembers,
  faviconFallbackLetter,
  hostLabel,
  hostPathLabel,
  lastUsedLabel,
  pickDefaultKeepTabId,
  viewDescriptor,
} from '../src/lib/panel-model';
import { summarizeSwaps, type SwapSample } from '../src/lib/snapshot';

describe('describeMembers at scale', () => {
  it('45 identical sheet views get 45 unique descriptors with ordinal suffixes', () => {
    const url = 'https://docs.google.com/spreadsheets/d/S1/edit#gid=0';
    const out = describeMembers(Array(45).fill(url));
    expect(new Set(out).size).toBe(45);
    expect(out[0]).toBe('Sheet tab 0');
    expect(out[1]).toBe('Sheet tab 0 · View 2');
    expect(out[44]).toBe('Sheet tab 0 · View 45');
  });

  it('a set spanning every Docs app describes each member by what actually differs', () => {
    const out = describeMembers([
      'https://docs.google.com/document/d/D1/edit',
      'https://docs.google.com/document/d/D1/view',
      'https://docs.google.com/document/d/D1/edit#heading=h.abc',
      'https://docs.google.com/document/d/D1/comment#heading=h.abc',
      'https://docs.google.com/spreadsheets/d/D1/edit#gid=7',
      'https://docs.google.com/spreadsheets/d/D1/edit?gid=9',
      'https://docs.google.com/presentation/d/D1/edit#slide=id.p1',
    ]);
    expect(out).toEqual([
      'Edit view',
      'Read view',
      'Edit view · linked section',
      'Comment view · linked section',
      'Sheet tab 7',
      'Sheet tab 9',
      'Edit view · Linked slide',
    ]);
  });

  it('multi-component difference: on Sheets the gid wins over the mode (it is the state the user chooses between)', () => {
    expect(
      viewDescriptor('https://docs.google.com/spreadsheets/d/S1/view#gid=3'),
    ).toBe('Sheet tab 3');
    // And a gid arriving by query is honored like the fragment form.
    expect(
      viewDescriptor('https://docs.google.com/spreadsheets/d/S1/edit?gid=12'),
    ).toBe('Sheet tab 12');
  });

  it('unparseable members degrade to the generic line and stay unique', () => {
    const out = describeMembers([
      'not a url at all',
      'https://example.com/page#part',
      'https://example.com/page',
      'also not a url',
    ]);
    expect(out[0]).toBe('Another view');
    expect(out[1]).toBe('Linked section');
    expect(out[2]).toBe('Another view · View 2');
    expect(out[3]).toBe('Another view · View 3');
    expect(new Set(out).size).toBe(4);
  });

  // Labels updated on the PR #6 rebase: PR #5 changed the generic
  // descriptor scheme to name the differing component ("Varies by
  // <param>", "Page: <segment>") in place of the old generic labels
  // ("Different page options" / "Different page view"). The
  // precedence this test pins — fragment beats query beats path,
  // ordinals keep members unique — is unchanged.
  it('generic fallback precedence: fragment beats query beats path', () => {
    const base = 'https://example.com/item?id=1';
    expect(
      describeMembers([base, 'https://example.com/item?id=1#frag'])[1],
    ).toBe('Linked section');
    expect(describeMembers([base, 'https://example.com/item?id=2'])[1]).toBe(
      'Varies by id · View 2', // member 0 reads the same — the difference is symmetric
    );
    expect(describeMembers([base, 'https://example.com/other?id=1'])[1]).toBe(
      'Page: other',
    );
    expect(describeMembers([base, base])[1]).toBe('Another view · View 2');
  });

  it('an empty set describes to an empty list', () => {
    expect(describeMembers([])).toEqual([]);
  });
});

describe('viewDescriptor — site patterns', () => {
  it.each([
    ['https://www.youtube.com/watch?v=V&t=90', 'Starts at 1:30'],
    ['https://www.youtube.com/watch?v=V&t=3661', 'Starts at 1:01:01'],
    ['https://www.youtube.com/watch?v=V&t=1m30s', 'Starts at 1:30'],
    ['https://youtu.be/V?t=45', 'Starts at 0:45'],
    ['https://www.youtube.com/watch?v=V&list=PL1', 'Playlist view'],
    ['https://www.youtube.com/shorts/V', 'Shorts view'],
    ['https://www.youtube.com/live/V', 'Live view'],
    ['https://www.youtube.com/embed/V', 'Embed view'],
    ['https://www.youtube.com/watch?v=V&t=0', null], // zero start is no start
    ['https://www.youtube.com/watch?v=V&t=later', null], // unparseable t
    ['https://www.figma.com/design/K/F?node-id=1-2', 'Selected element'],
    ['https://www.figma.com/design/K/F?page-id=0%3A1', 'Page view'],
    ['https://www.figma.com/design/K/F?node-id=1-2&page-id=0%3A1', 'Selected element'],
    ['https://github.com/u/r/blob/main/a.ts#L12', 'Code line link'],
    ['https://github.com/u/r/blob/main/a.ts#L12-L20', 'Code line link'],
    ['https://github.com/u/r/blob/main/a.ts', null],
    ['https://example.com/anything', null],
    ['not a url', null],
  ] as Array<[string, string | null]>)('%s → %s', (url, expected) => {
    expect(viewDescriptor(url)).toBe(expected);
  });

  it('very long URLs and titles do not break the helpers', () => {
    const longPath = `https://example.com/${'seg/'.repeat(500)}end`;
    expect(hostPathLabel(longPath)).toBe(
      `example.com/${'seg/'.repeat(500)}end`,
    );
    expect(faviconFallbackLetter('x'.repeat(100_000), '')).toBe('X');
    expect(describeMembers([longPath, longPath])).toEqual([
      'Another view',
      'Another view · View 2',
    ]);
  });
});

describe('hostLabel / hostPathLabel', () => {
  it.each([
    ['https://user:secret@www.example.com:8443/x?y=1', 'example.com'],
    ['https://www.www.example.com/', 'www.example.com'], // one www. stripped
    ['https://docs.google.com/document/d/X/edit', 'docs.google.com'],
    ['https://bücher.example.de/', 'xn--bcher-kva.example.de'],
    ['not a url', 'not a url'],
    ['  spaced  ', 'spaced'],
    ['', ''],
  ] as Array<[string, string]>)('hostLabel(%j) → %j', (url, expected) => {
    expect(hostLabel(url)).toBe(expected);
  });

  it.each([
    ['https://example.com/', 'example.com'],
    ['https://example.com/a/b//', 'example.com/a/b'],
    ['https://example.com/a?x=1#frag', 'example.com/a'],
    ['https://sub.example.com:443/deep/path', 'sub.example.com/deep/path'],
  ] as Array<[string, string]>)('hostPathLabel(%j) → %j', (url, expected) => {
    expect(hostPathLabel(url)).toBe(expected);
  });
});

describe('faviconFallbackLetter', () => {
  it('D8 refuted: an astral-plane first letter yields the whole code point, never a lone surrogate', () => {
    const letter = faviconFallbackLetter('𐍈abc', '');
    expect(letter).toBe('𐍈');
    expect([...letter]).toHaveLength(1);
  });

  it.each([
    ['apple pie', '', 'A'],
    ['🚀 launch', '', 'L'],
    ['3M tape', '', '3'],
    ['!!!', 'https://example.com/', 'E'],
    ['', '', '•'],
    // An unparseable "URL" contributes its own first letter via
    // hostLabel's trimmed passthrough — the bullet is only for
    // when neither source has any letter at all.
    ['   ', 'not a url', 'N'],
  ] as Array<[string, string, string]>)(
    '(%j, %j) → %j',
    (title, url, expected) => {
      expect(faviconFallbackLetter(title, url)).toBe(expected);
    },
  );
});

describe('pickDefaultKeepTabId — recency and ties', () => {
  it('empty membership yields null', () => {
    expect(pickDefaultKeepTabId([])).toBeNull();
  });

  it('an active member wins over a more recent inactive one', () => {
    expect(
      pickDefaultKeepTabId([
        { id: 1, active: false, lastAccessed: 9_999 },
        { id: 2, active: true, lastAccessed: 1 },
      ]),
    ).toBe(2);
  });

  it('otherwise the most recently accessed member wins; ties resolve to the earliest in set order', () => {
    expect(
      pickDefaultKeepTabId([
        { id: 1, active: false, lastAccessed: 100 },
        { id: 2, active: false, lastAccessed: 300 },
        { id: 3, active: false, lastAccessed: 300 },
      ]),
    ).toBe(2);
    expect(
      pickDefaultKeepTabId([
        { id: 1, active: false, lastAccessed: null },
        { id: 2, active: false, lastAccessed: null },
      ]),
    ).toBe(1);
  });
});

describe('lastUsedLabel fallbacks', () => {
  const now = new Date(2026, 9, 11, 15, 0, 0);
  it('prefers lastAccessed, falls back to firstSeenAt, then to empty', () => {
    const ts = new Date(2026, 9, 11, 9, 30, 0).getTime();
    expect(
      lastUsedLabel({ lastAccessed: ts, firstSeenAt: ts - 1000 }, now),
    ).toMatch(/^Last used /);
    expect(
      lastUsedLabel({ lastAccessed: null, firstSeenAt: ts }, now),
    ).toMatch(/^Opened /);
    expect(lastUsedLabel({ lastAccessed: null, firstSeenAt: null }, now)).toBe('');
  });

  it('characterization: epoch 0 is falsy and treated as unknown in both fields', () => {
    expect(lastUsedLabel({ lastAccessed: 0, firstSeenAt: 0 }, now)).toBe('');
  });
});

describe('summarizeSwaps statistics', () => {
  const s = (ms: number, cold = false): SwapSample => ({ ms, cold, at: 0 });
  it('empty input yields nulls and zero counts', () => {
    expect(summarizeSwaps([])).toEqual({
      count: 0,
      coldCount: 0,
      warmCount: 0,
      medianMs: null,
      p95Ms: null,
    });
  });

  it('odd and even medians; p95 index clamps at the top sample', () => {
    expect(summarizeSwaps([s(30), s(10), s(20)]).medianMs).toBe(20);
    expect(summarizeSwaps([s(40), s(10), s(20), s(30)]).medianMs).toBe(25);
    const many = Array.from({ length: 20 }, (_, i) => s((i + 1) * 10));
    expect(summarizeSwaps(many).p95Ms).toBe(190);
    expect(summarizeSwaps([s(5)]).p95Ms).toBe(5);
  });

  it('does not mutate or reorder the caller’s array', () => {
    const input = [s(30), s(10), s(20)];
    summarizeSwaps(input);
    expect(input.map((x) => x.ms)).toEqual([30, 10, 20]);
  });

  it('cold/warm counts split on the flag', () => {
    const out = summarizeSwaps([s(1, true), s(2), s(3, true)]);
    expect(out.coldCount).toBe(2);
    expect(out.warmCount).toBe(1);
  });
});
