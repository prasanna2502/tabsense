import { describe, expect, it } from 'vitest';
import {
  faviconFallbackLetter,
  hostLabel,
  hostPathLabel,
  pluralize,
} from '../src/lib/panel-model';

describe('hostLabel', () => {
  it('extracts the host and drops a leading www.', () => {
    expect(hostLabel('https://www.example.com/some/page?x=1')).toBe(
      'example.com',
    );
    expect(hostLabel('https://docs.google.com/document/d/abc')).toBe(
      'docs.google.com',
    );
  });

  it('drops ports and credentials', () => {
    expect(hostLabel('https://user:pw@sub.example.com:8443/a')).toBe(
      'sub.example.com',
    );
  });

  it('handles empty and unparseable input without throwing', () => {
    expect(hostLabel('')).toBe('');
    expect(hostLabel('not a url')).toBe('not a url');
  });
});

describe('hostPathLabel', () => {
  it('joins host and path, dropping query and fragment', () => {
    expect(
      hostPathLabel('https://www.example.com/a/b/?q=1#frag'),
    ).toBe('example.com/a/b');
  });

  it('shows just the host for a root path', () => {
    expect(hostPathLabel('https://example.com/')).toBe('example.com');
    expect(hostPathLabel('https://example.com')).toBe('example.com');
  });
});

describe('pluralize', () => {
  it('singularizes at exactly 1', () => {
    expect(pluralize(1, 'tab')).toBe('1 tab');
    expect(pluralize(0, 'tab')).toBe('0 tabs');
    expect(pluralize(4, 'copy', 'copies')).toBe('4 copies');
  });
});

describe('faviconFallbackLetter', () => {
  it('prefers the title’s first alphanumeric character, uppercased', () => {
    expect(faviconFallbackLetter('quarterly report', 'https://x.com/')).toBe(
      'Q',
    );
    expect(faviconFallbackLetter('  — Draft', 'https://x.com/')).toBe('D');
  });

  it('falls back to the host, then to a bullet', () => {
    expect(faviconFallbackLetter('', 'https://news.example.com/')).toBe('N');
    expect(faviconFallbackLetter('', '')).toBe('•');
  });
});
