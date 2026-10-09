import { describe, expect, it } from 'vitest';
import { normalizeUrlFallback } from '../src/lib/normalize';

/**
 * These cases also run against the Rust core (core/src/lib.rs, `cargo test`)
 * — the TS fallback and the Wasm implementation must agree bit-for-bit.
 */
describe('normalizeUrlFallback', () => {
  it('lowercases scheme and host but preserves path case', () => {
    expect(normalizeUrlFallback('HTTPS://Docs.Example.COM/Some/Path')).toBe(
      'https://docs.example.com/Some/Path',
    );
  });

  it('drops default ports and keeps non-default ones', () => {
    expect(normalizeUrlFallback('https://example.com:443/a')).toBe(
      'https://example.com/a',
    );
    expect(normalizeUrlFallback('http://example.com:80/a')).toBe(
      'http://example.com/a',
    );
    expect(normalizeUrlFallback('http://example.com:8080/a')).toBe(
      'http://example.com:8080/a',
    );
  });

  it('uses "/" for an empty path', () => {
    expect(normalizeUrlFallback('https://example.com')).toBe(
      'https://example.com/',
    );
    expect(normalizeUrlFallback('https://example.com?q=1')).toBe(
      'https://example.com/?q=1',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeUrlFallback('  https://example.com/a  ')).toBe(
      'https://example.com/a',
    );
  });

  it('preserves query string and fragment', () => {
    expect(normalizeUrlFallback('https://example.com/a?b=2&a=1#frag')).toBe(
      'https://example.com/a?b=2&a=1#frag',
    );
  });

  it('returns unparseable input unchanged (trimmed)', () => {
    expect(normalizeUrlFallback('not a url')).toBe('not a url');
  });
});
