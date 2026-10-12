/**
 * Group-memory adversarial tests (test-hardening commission,
 * method 8) plus the platform-name validator matrix (method 4's
 * naming guard). The 200-record cap was itself an M3 fix for
 * unbounded growth; these tests pin its eviction semantics —
 * live records are never dropped, dormant ones go oldest-first,
 * and survivor order is stable — and the signature math that
 * recognizes a returning group across sessions.
 *
 * Defect D7 (P2) was found here: the bare-domain check in
 * isPlatformGroupName could be evaded with a trailing dot
 * ('google.com.') or a fullwidth dot ('google．com', U+FF0E) —
 * the two shapes a judge model plausibly emits. The validator now
 * also tests a normalized form. The D7 tests below are the
 * regression pair.
 */

import { describe, expect, it } from 'vitest';
import {
  capDismissals,
  capGroupRecords,
  computeGroupSignature,
  dismissalSignature,
  groupKeyOf,
  groupLocalId,
  isPlatformGroupName,
  localIdFromGroupKey,
  signatureFromKeys,
  type TabSenseGroupRecord,
} from '../src/lib/groups';
import type { ScorerTabInput } from '../src/lib/scorer';

function record(
  localId: string,
  updatedAt: number,
  chromeGroupId: number | null = null,
): TabSenseGroupRecord {
  return {
    localId,
    name: `Group ${localId}`,
    signature: `v1|group ${localId}|`,
    exemplarKeys: [],
    windowId: 1,
    chromeGroupId,
    memberTabIds: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('capGroupRecords — the 200-record memory bound', () => {
  it('at or under the cap, everything is kept, order untouched', () => {
    const records = Array.from({ length: 200 }, (_, i) => record(`g${i}`, i));
    const out = capGroupRecords(records);
    expect(out).toHaveLength(200);
    expect(out.map((r) => r.localId)).toEqual(records.map((r) => r.localId));
  });

  it('one over the cap evicts exactly the oldest dormant record', () => {
    const records = Array.from({ length: 201 }, (_, i) => record(`g${i}`, i));
    const out = capGroupRecords(records);
    expect(out).toHaveLength(200);
    expect(out.map((r) => r.localId)).not.toContain('g0');
    expect(out.map((r) => r.localId)).toContain('g200');
  });

  it('live records are never evicted, even when older than every dormant one', () => {
    const records: TabSenseGroupRecord[] = [record('live-old', 1, 42)];
    for (let i = 0; i < 250; i++) records.push(record(`d${i}`, 100 + i));
    const out = capGroupRecords(records);
    expect(out.map((r) => r.localId)).toContain('live-old');
    expect(out).toHaveLength(200);
  });

  it('when live records alone exceed the cap, the cap yields — all live kept', () => {
    const records = Array.from({ length: 250 }, (_, i) =>
      record(`g${i}`, i, 1000 + i),
    );
    const out = capGroupRecords(records);
    expect(out).toHaveLength(250);
  });

  it('survivor order matches input order (no reshuffle on eviction)', () => {
    const records: TabSenseGroupRecord[] = [];
    for (let i = 0; i < 210; i++) {
      records.push(record(`g${i}`, (i * 37) % 211)); // scrambled ages
    }
    const out = capGroupRecords(records);
    const inputOrder = records.map((r) => r.localId);
    const outOrder = out.map((r) => r.localId);
    expect(outOrder).toEqual(
      inputOrder.filter((id) => outOrder.includes(id)),
    );
    // The 10 evicted are the 10 oldest by updatedAt.
    const byAge = [...records].sort((a, b) => a.updatedAt - b.updatedAt);
    const evicted = byAge.slice(0, 10).map((r) => r.localId);
    for (const id of evicted) expect(outOrder).not.toContain(id);
  });
});

describe('capDismissals — the 200-dismissal bound', () => {
  it('keeps the 200 newest, newest first', () => {
    const records = Array.from({ length: 250 }, (_, i) => ({
      signature: `s${i}`,
      at: i,
    }));
    const out = capDismissals(records);
    expect(out).toHaveLength(200);
    expect(out[0].signature).toBe('s249');
    expect(out[199].signature).toBe('s50');
  });

  it('under the cap, still returns newest-first order', () => {
    const out = capDismissals([
      { signature: 'a', at: 1 },
      { signature: 'b', at: 3 },
      { signature: 'c', at: 2 },
    ]);
    expect(out.map((r) => r.signature)).toEqual(['b', 'c', 'a']);
  });
});

describe('group identity — signatures and local ids', () => {
  const t = (partial: Partial<ScorerTabInput>): ScorerTabInput => ({
    id: 1,
    title: 't',
    url: 'https://example.com/',
    host: 'example.com',
    exactKey: null,
    fuzzyKey: null,
    groupId: -1,
    ...partial,
  });

  it('signature normalizes the name (case + whitespace) and sorts keys', () => {
    expect(signatureFromKeys('  My   Group ', ['b', 'a'])).toBe(
      'v1|my group|a,b',
    );
    expect(signatureFromKeys('My Group', ['a', 'b'])).toBe('v1|my group|a,b');
  });

  it('signature uses at most 5 exemplar keys and ignores empty keys', () => {
    expect(signatureFromKeys('G', ['', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6'])).toBe(
      'v1|g|k1,k2,k3,k4,k5',
    );
  });

  it('identity drift: a key that sorts into the exemplar window changes the signature; one outside it does not', () => {
    const before = signatureFromKeys('G', ['k2', 'k3', 'k4', 'k5', 'k6']);
    const driftIn = signatureFromKeys('G', ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    const driftOut = signatureFromKeys('G', ['k2', 'k3', 'k4', 'k5', 'k6', 'k9']);
    expect(driftIn).not.toBe(before);
    expect(driftOut).toBe(before);
  });

  it('computeGroupSignature prefers fuzzy over exact over host', () => {
    expect(
      computeGroupSignature('G', [
        t({ fuzzyKey: 'fz', exactKey: 'ex', url: 'https://h.example/x' }),
        t({ fuzzyKey: null, exactKey: 'ex2', url: 'https://h.example/y' }),
        t({ fuzzyKey: null, exactKey: null, url: 'https://other.example/z' }),
      ]),
    ).toBe('v1|g|ex2,fz,other.example');
  });

  it('groupLocalId differs within the same millisecond via the counter', () => {
    expect(groupLocalId(1000, 1)).not.toBe(groupLocalId(1000, 2));
    expect(groupLocalId(1000, 1)).toBe(groupLocalId(1000, 1));
  });

  it('groupKeyOf / localIdFromGroupKey round-trip; foreign keys yield null', () => {
    const rec = record('g123-4', 0);
    expect(groupKeyOf(rec)).toBe('ts:g123-4');
    expect(localIdFromGroupKey('ts:g123-4')).toBe('g123-4');
    expect(localIdFromGroupKey('g123-4')).toBeNull();
    expect(localIdFromGroupKey('')).toBeNull();
    // Edge: the bare prefix yields the empty id, not null.
    expect(localIdFromGroupKey('ts:')).toBe('');
  });

  it('dismissalSignature is order-independent over tab ids and kind/target-scoped', () => {
    expect(dismissalSignature('new-group', [3, 1, 2], 'name:x')).toBe(
      dismissalSignature('new-group', [1, 2, 3], 'name:x'),
    );
    expect(dismissalSignature('new-group', [1, 2, 3], 'name:x')).not.toBe(
      dismissalSignature('add-to-group', [1, 2, 3], 'name:x'),
    );
    expect(dismissalSignature('new-group', [1, 2, 3], 'name:x')).not.toBe(
      dismissalSignature('new-group', [1, 2, 4], 'name:x'),
    );
  });
});

describe('isPlatformGroupName — the judge-name guard matrix', () => {
  it.each([
    ['Google', true],
    ['google', true],
    ['Google Docs', true],
    ['Notion', true],
    ['figma', true],
    ['google.com', true],
    ['docs.google.com', true],
    ['example.org', true], // any bare domain shape with a known TLD
    ['Quarterly planning', false],
    ['Research', false],
    ['', false],
    ['   ', false],
    ['my.notes', false], // unknown TLD suffix — not a bare known domain
    ['192.168.1.1', false], // numeric tail is not a TLD
    ['google.com.evil', false], // unknown final label
    ['docs', false], // bare app label needs the shared-host context
  ] as Array<[string, boolean]>)('name %j → %s', (name, expected) => {
    expect(isPlatformGroupName(name)).toBe(expected);
  });

  it('with a shared multi-doc host, its labels and domain count as platform names', () => {
    expect(isPlatformGroupName('docs', 'docs.google.com')).toBe(true);
    expect(isPlatformGroupName('google.com', 'docs.google.com')).toBe(true);
    expect(isPlatformGroupName('docs.google.com', 'docs.google.com')).toBe(true);
    expect(isPlatformGroupName('drive', 'drive.google.com')).toBe(true);
    // But the same word is a legitimate topic on an unrelated host.
    expect(isPlatformGroupName('docs', 'blog.example.com')).toBe(false);
  });

  it('D7 regression: a trailing dot does not evade the domain check', () => {
    expect(isPlatformGroupName('google.com.')).toBe(true);
    expect(isPlatformGroupName('docs.google.com.')).toBe(true);
  });

  it('D7 regression: a fullwidth dot (U+FF0E) does not evade the domain check', () => {
    expect(isPlatformGroupName('google．com')).toBe(true);
  });

  it('normalization does not over-reach: lookalikes that are not domains stay allowed', () => {
    expect(isPlatformGroupName('planning.com notes')).toBe(false);
    expect(isPlatformGroupName('my.com／docs')).toBe(false);
  });
});
