import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  canonicalKeysFallback,
  type CanonKeys,
} from '../src/lib/canonicalize';

/**
 * Golden-corpus parity test for the TS fallback canonicalizer (M1).
 * Consumes the SAME corpus as the Rust core's test
 * (core/tests/corpus.rs): tests/corpus/canonical-cases.json.
 * Classification of a pair: exact (same exactKey) / fuzzy (different
 * exactKey, same fuzzyKey) / distinct (both differ). The precision
 * bar is 100% on the exact tier: no fuzzy or distinct case may be
 * classified exact.
 */

interface CorpusCase {
  id: string;
  a: string;
  b: string;
  expect: 'exact' | 'fuzzy' | 'distinct';
  note: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(here, 'corpus/canonical-cases.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
  version: number;
  cases: CorpusCase[];
};

function classify(ka: CanonKeys, kb: CanonKeys): 'exact' | 'fuzzy' | 'distinct' {
  if (ka.exactKey === kb.exactKey) return 'exact';
  if (ka.fuzzyKey === kb.fuzzyKey) return 'fuzzy';
  return 'distinct';
}

describe('golden corpus (TS fallback)', () => {
  it('has at least 80 cases', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(80);
  });

  for (const c of corpus.cases) {
    it(`${c.id}: ${c.expect}`, () => {
      const ka = canonicalKeysFallback(c.a);
      const kb = canonicalKeysFallback(c.b);
      expect(classify(ka, kb), `${c.a} vs ${c.b} (${c.note})`).toBe(c.expect);
      if (c.expect === 'exact') {
        expect(ka.fuzzyKey).toBe(kb.fuzzyKey);
      }
    });
  }
});

describe('canonicalizer key shapes (TS fallback)', () => {
  it('keys Google Docs on the file ID', () => {
    expect(
      canonicalKeysFallback(
        'https://docs.google.com/document/d/DOCAAA111/edit?usp=sharing',
      ),
    ).toEqual({
      exactKey: 'gdoc:document:DOCAAA111/edit',
      fuzzyKey: 'gdoc:document:DOCAAA111',
    });
  });

  it('keys Notion on the 32-hex page ID', () => {
    expect(
      canonicalKeysFallback(
        'https://www.notion.so/My-Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=4',
      ),
    ).toEqual({
      exactKey: 'notion:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
      fuzzyKey: 'notion:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
    });
  });

  it('normalizes YouTube timestamps to seconds', () => {
    expect(
      canonicalKeysFallback('https://www.youtube.com/watch?v=V1&t=1m30s'),
    ).toEqual({ exactKey: 'yt:watch:V1?t=90', fuzzyKey: 'yt:video:V1' });
  });

  it('leaves non-http(s) input as its own key', () => {
    expect(canonicalKeysFallback('chrome://extensions/')).toEqual({
      exactKey: 'chrome://extensions/',
      fuzzyKey: 'chrome://extensions/',
    });
  });
});
