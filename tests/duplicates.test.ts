import { describe, expect, it } from 'vitest';
import {
  DuplicateExemptions,
  fragmentTransferTarget,
  isIntentionalDuplicate,
  shouldKeepIntentionalDuplicate,
  summarizeDuplicates,
  type IntentionalDuplicateEvidence,
} from '../src/lib/duplicates';

describe('summarizeDuplicates', () => {
  it('reports zero duplicates for all-unique URLs', () => {
    const summary = summarizeDuplicates([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ]);
    expect(summary.totalTabs).toBe(3);
    expect(summary.uniqueUrls).toBe(3);
    expect(summary.duplicateTabs).toBe(0);
    expect(summary.groups).toEqual([]);
  });

  it('counts extra copies beyond the first as duplicates', () => {
    const summary = summarizeDuplicates([
      'https://docs.example/abc',
      'https://news.example/story',
      'https://docs.example/abc',
      'https://docs.example/abc',
      'https://news.example/story',
    ]);
    expect(summary.totalTabs).toBe(5);
    expect(summary.uniqueUrls).toBe(2);
    // 2 extra copies of the doc + 1 extra copy of the story.
    expect(summary.duplicateTabs).toBe(3);
    expect(summary.groups).toEqual([
      { url: 'https://docs.example/abc', count: 3 },
      { url: 'https://news.example/story', count: 2 },
    ]);
  });

  it('is exact: near-identical URLs are not duplicates at M0', () => {
    const summary = summarizeDuplicates([
      'https://example.com/page?utm_source=x',
      'https://example.com/page',
      'https://example.com/page#section',
    ]);
    expect(summary.duplicateTabs).toBe(0);
    expect(summary.uniqueUrls).toBe(3);
  });

  it('ignores empty URLs (tabs without a committed URL)', () => {
    const summary = summarizeDuplicates(['', 'https://a.example/', '']);
    expect(summary.totalTabs).toBe(1);
    expect(summary.uniqueUrls).toBe(1);
  });

  it('handles an empty tab list', () => {
    const summary = summarizeDuplicates([]);
    expect(summary).toEqual({
      totalTabs: 0,
      uniqueUrls: 0,
      duplicateTabs: 0,
      groups: [],
    });
  });
});

describe('intentional-duplicate fingerprint (Phase 2)', () => {
  // A Duplicate-command creation as the worker observes it: the
  // active tab 10 (index 3) spawns a copy of the same canonical page
  // at index 4, with openerTabId pointing back at tab 10.
  const duplicateCommand: IntentionalDuplicateEvidence = {
    newExactKey: 'https://example.com/page',
    sourceExactKey: 'https://example.com/page',
    openerTabId: 10,
    sourceTabId: 10,
    newIndex: 4,
    sourceIndex: 3,
    sameWindow: true,
    sourceWasActive: true,
  };

  it('a simulated Duplicate-command creation is kept (never auto-closed)', () => {
    expect(isIntentionalDuplicate(duplicateCommand)).toBe(true);
    expect(shouldKeepIntentionalDuplicate(duplicateCommand, true)).toBe(true);
  });

  it('an omnibox-style re-open (no opener) still auto-closes', () => {
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, openerTabId: null }),
    ).toBe(false);
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, openerTabId: undefined }),
    ).toBe(false);
  });

  it('an opener that is not the source tab still auto-closes', () => {
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, openerTabId: 99 }),
    ).toBe(false);
  });

  it('a non-adjacent copy still auto-closes', () => {
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, newIndex: 7 }),
    ).toBe(false);
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, newIndex: 3 }),
    ).toBe(false);
  });

  it('duplicating a background (inactive) tab still auto-closes', () => {
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, sourceWasActive: false }),
    ).toBe(false);
  });

  it('a copy in another window, or of a different page, still auto-closes', () => {
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, sameWindow: false }),
    ).toBe(false);
    expect(
      isIntentionalDuplicate({
        ...duplicateCommand,
        newExactKey: 'https://example.com/other',
      }),
    ).toBe(false);
    expect(
      isIntentionalDuplicate({ ...duplicateCommand, newExactKey: null }),
    ).toBe(false);
  });

  it('toggle OFF restores closing even for a perfect fingerprint', () => {
    expect(shouldKeepIntentionalDuplicate(duplicateCommand, false)).toBe(false);
  });
});

describe('DuplicateExemptions lifecycle', () => {
  it('exempts only the marked tab, only at the marked canonical URL', () => {
    const ex = new DuplicateExemptions();
    ex.mark(11, 'https://example.com/page');
    expect(ex.retain(11, 'https://example.com/page')).toBe(true);
    // Not a per-URL blanket exemption: another tab at the same URL
    // follows the normal rules.
    expect(ex.retain(12, 'https://example.com/page')).toBe(false);
    expect(ex.has(11)).toBe(true);
  });

  it('the exemption ends when the tab navigates to a different canonical URL', () => {
    const ex = new DuplicateExemptions();
    ex.mark(11, 'https://example.com/page');
    expect(ex.retain(11, 'https://example.com/elsewhere')).toBe(false);
    // …and it stays ended: navigating back does not revive it.
    expect(ex.retain(11, 'https://example.com/page')).toBe(false);
    expect(ex.has(11)).toBe(false);
  });

  it('forget drops the exemption (tab closed)', () => {
    const ex = new DuplicateExemptions();
    ex.mark(11, 'https://example.com/page');
    ex.forget(11);
    expect(ex.retain(11, 'https://example.com/page')).toBe(false);
  });
});

describe('fragmentTransferTarget', () => {
  it('moves a Docs heading anchor onto the kept tab', () => {
    expect(
      fragmentTransferTarget(
        'https://docs.google.com/document/d/DOCID/edit',
        'https://docs.google.com/document/d/DOCID/edit#heading=h.abc123',
      ),
    ).toBe('https://docs.google.com/document/d/DOCID/edit#heading=h.abc123');
  });

  it('replaces a different fragment on the kept tab (newest intent wins)', () => {
    expect(
      fragmentTransferTarget(
        'https://example.com/article#intro',
        'https://example.com/article#methods',
      ),
    ).toBe('https://example.com/article#methods');
  });

  it('carries a scroll-to-text fragment', () => {
    expect(
      fragmentTransferTarget(
        'https://example.com/story',
        'https://example.com/story#:~:text=hello%20world',
      ),
    ).toBe('https://example.com/story#:~:text=hello%20world');
  });

  it('returns null when the duplicate has no fragment', () => {
    expect(
      fragmentTransferTarget(
        'https://example.com/article#intro',
        'https://example.com/article',
      ),
    ).toBeNull();
  });

  it('returns null when the kept tab already sits at that fragment', () => {
    expect(
      fragmentTransferTarget(
        'https://example.com/article#methods',
        'https://example.com/article#methods',
      ),
    ).toBeNull();
  });

  it('preserves the kept tab’s own path and query, not the duplicate’s', () => {
    expect(
      fragmentTransferTarget(
        'https://example.com/p?x=1',
        'https://example.com/p?utm_source=share#part-2',
      ),
    ).toBe('https://example.com/p?x=1#part-2');
  });

  it('returns null for unparseable URLs instead of throwing', () => {
    expect(fragmentTransferTarget('not a url', 'https://e.com/a#b')).toBeNull();
    expect(fragmentTransferTarget('https://e.com/a', 'also not a url')).toBeNull();
  });
});
