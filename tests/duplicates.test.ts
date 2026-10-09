import { describe, expect, it } from 'vitest';
import { summarizeDuplicates } from '../src/lib/duplicates';

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
