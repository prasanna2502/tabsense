import { describe, expect, it } from 'vitest';
import {
  capDismissals,
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

function tab(
  id: number,
  url: string,
  keys: { exactKey?: string | null; fuzzyKey?: string | null } = {},
): ScorerTabInput {
  return {
    id,
    title: '',
    url,
    exactKey: keys.exactKey ?? null,
    fuzzyKey: keys.fuzzyKey ?? null,
  };
}

describe('group identity = name + exemplar signature', () => {
  it('is stable for the same name and exemplar keys', () => {
    const members = [
      tab(1, 'https://docs.google.com/document/d/abc/edit', { fuzzyKey: 'gdoc:document:abc' }),
      tab(2, 'https://example.com/post', { exactKey: 'https://example.com/post' }),
    ];
    expect(computeGroupSignature('Recipes', members)).toBe(
      computeGroupSignature('  recipes ', [...members].reverse()),
    );
  });

  it('changes with the name and with the exemplars', () => {
    const a = [tab(1, 'https://example.com/a', { exactKey: 'k:a' })];
    const b = [tab(1, 'https://example.com/b', { exactKey: 'k:b' })];
    expect(computeGroupSignature('Trips', a)).not.toBe(
      computeGroupSignature('Trips', b),
    );
    expect(computeGroupSignature('Trips', a)).not.toBe(
      computeGroupSignature('Travel', a),
    );
  });

  it('signatureFromKeys caps at 5 exemplar keys, sorted', () => {
    const sig = signatureFromKeys('G', ['k6', 'k1', 'k3', 'k2', 'k5', 'k4']);
    expect(sig).toBe('v1|g|k1,k2,k3,k4,k5');
  });

  it('never contains a Chrome group ID — identity survives sessions', () => {
    const rec: TabSenseGroupRecord = {
      localId: 'g1',
      name: 'Recipes',
      signature: computeGroupSignature('Recipes', [
        tab(1, 'https://example.com/a', { exactKey: 'k:a' }),
      ]),
      exemplarKeys: ['k:a'],
      windowId: 1,
      chromeGroupId: 12345, // session-scoped decoration only
      memberTabIds: [1],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(rec.signature).not.toContain('12345');
    expect(groupKeyOf(rec)).toBe('ts:g1');
    expect(localIdFromGroupKey('ts:g1')).toBe('g1');
    expect(localIdFromGroupKey('manual:7')).toBeNull();
  });

  it('local IDs are unique per (time, counter)', () => {
    expect(groupLocalId(1000, 0)).not.toBe(groupLocalId(1000, 1));
  });
});

describe('dismissals', () => {
  it('signature is order-insensitive over the tab set', () => {
    expect(dismissalSignature('new-group', [3, 1, 2], 'name:x')).toBe(
      dismissalSignature('new-group', [1, 2, 3], 'name:x'),
    );
    expect(dismissalSignature('new-group', [1, 2], 'name:x')).not.toBe(
      dismissalSignature('add-to-group', [1, 2], 'name:x'),
    );
  });

  it('cap keeps the most recent 200', () => {
    const records = Array.from({ length: 250 }, (_, i) => ({
      signature: `s${i}`,
      at: i,
    }));
    const capped = capDismissals(records);
    expect(capped).toHaveLength(200);
    expect(capped[0].signature).toBe('s249');
  });
});

describe('isPlatformGroupName (Phase 3)', () => {
  it('bans platform and brand names outright', () => {
    for (const name of [
      'Google',
      'Google Docs',
      'google sheets',
      'Notion',
      'Figma',
      'Google Drive',
    ]) {
      expect(isPlatformGroupName(name)).toBe(true);
    }
  });

  it('bans bare domain shapes', () => {
    expect(isPlatformGroupName('docs.google.com')).toBe(true);
    expect(isPlatformGroupName('notion.so')).toBe(true);
    expect(isPlatformGroupName('example.com')).toBe(true);
  });

  it('bans the shared multi-doc host labels', () => {
    expect(isPlatformGroupName('Docs', 'docs.google.com')).toBe(true);
    expect(isPlatformGroupName('google.com', 'docs.google.com')).toBe(true);
    expect(isPlatformGroupName('Google', 'docs.google.com')).toBe(true);
    expect(isPlatformGroupName('Notion', 'www.notion.so')).toBe(true);
  });

  it('allows genuine topic names, incl. names that merely mention a platform', () => {
    expect(isPlatformGroupName('Costa Rica')).toBe(false);
    expect(isPlatformGroupName('Chicken')).toBe(false);
    expect(isPlatformGroupName('Google I/O Talks')).toBe(false);
    expect(isPlatformGroupName('Node.js')).toBe(false);
    // A single-document site label is not a platform name.
    expect(isPlatformGroupName('Example', 'example.com')).toBe(false);
    expect(isPlatformGroupName('Docs', 'example.com')).toBe(false);
  });
});
