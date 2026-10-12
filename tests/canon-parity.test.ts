/**
 * Canonicalizer hardening (test-hardening commission, method 2).
 *
 * The canonicalizer exists twice — the Rust core (Wasm) and the TS
 * fallback — and the product contract is BIT-FOR-BIT parity: the
 * worker canonicalizes with whichever engine answered, and a key
 * that differs by engine is a duplicate missed or, worse, a tab
 * matched against the wrong set. The golden corpus (95 pairs)
 * proves parity on hand-picked cases; this suite proves it on a
 * generated corpus of 1,200 URLs plus hand-aimed edge probes, and
 * adds the algebraic properties the engine silently relies on:
 *
 *  - Idempotence: canonicalizing a canonical exact key returns
 *    the same key pair (the worker re-canonicalizes stored keys
 *    on core-ready reindex and in snapshot refreshes).
 *  - Classification stability: variant pairs that must classify
 *    exact / fuzzy / distinct do so under BOTH engines — the
 *    precision bar (never exact unless truly the same view) is
 *    the wrong-close guard.
 *
 * Known parity defects are pinned as `it.fails` repros with
 * defect IDs (see the hardening report): they assert the CORRECT
 * behavior, fail today, and will turn red the day the fix lands
 * and the marker can come off. Both defective spots live in
 * src/lib/canonicalize.ts, which a parallel branch is editing —
 * no fixes here, per the defect protocol.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalKeysFallback,
  type CanonKeys,
} from '../src/lib/canonicalize';
import { canonicalKeys, ensureCoreReady } from '../src/wasm/load';
import { EDGE_PROBES, generateUrlCorpus } from './helpers/url-corpus';

beforeAll(async () => {
  // The REAL Wasm core — parity against the shipped artifact, not
  // a reimplementation.
  expect(await ensureCoreReady()).toBe(true);
});

function wasmKeys(url: string): CanonKeys {
  const { keys, engine } = canonicalKeys(url);
  expect(engine).toBe('wasm');
  return keys;
}

function classify(
  ka: CanonKeys,
  kb: CanonKeys,
): 'exact' | 'fuzzy' | 'distinct' {
  if (ka.exactKey === kb.exactKey) return 'exact';
  if (ka.fuzzyKey === kb.fuzzyKey) return 'fuzzy';
  return 'distinct';
}

const corpus = generateUrlCorpus();
const allUrls = [...corpus, ...EDGE_PROBES];

/** Inputs whose parity divergence is a filed defect with a
 * dedicated `it.fails` repro below — excluded from the bulk
 * parity assertion so an UNKNOWN mismatch still fails loudly. */
const KNOWN_DEFECT_INPUTS = new Set([
  '\uFEFFhttps://example.com/bom-prefixed', // D5
]);

describe('generated corpus — TS ↔ Wasm parity', () => {
  it('agrees bit-for-bit on every generated URL', () => {
    const mismatches: string[] = [];
    for (const url of allUrls) {
      if (KNOWN_DEFECT_INPUTS.has(url)) continue;
      const ts = canonicalKeysFallback(url);
      const rs = wasmKeys(url);
      if (ts.exactKey !== rs.exactKey || ts.fuzzyKey !== rs.fuzzyKey) {
        mismatches.push(
          `${JSON.stringify(url)}\n  TS:   ${JSON.stringify(ts)}\n  Wasm: ${JSON.stringify(rs)}`,
        );
      }
    }
    expect(
      mismatches,
      `${mismatches.length} parity mismatch(es):\n${mismatches.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });

  it('is deterministic across repeated calls (both engines)', () => {
    for (const url of allUrls.slice(0, 200)) {
      expect(canonicalKeysFallback(url)).toEqual(canonicalKeysFallback(url));
      expect(wasmKeys(url)).toEqual(wasmKeys(url));
    }
  });
});

describe('idempotence — a canonical exact key is a fixed point', () => {
  // The engine re-derives keys from URLs, never from stored keys,
  // so the load-bearing property is the exact tier: feeding an
  // exact key back must reproduce that exact key. When the exact
  // key is still a URL (generic / GitHub), the whole pair must
  // reproduce; app keys (gdoc:, yt:, …) are not URLs and return
  // as identity, which pins the exact tier only.
  it('exactKey is a fixed point (TS)', () => {
    for (const url of allUrls) {
      if (url.includes('drive.google.com/open/?')) continue; // D10
      // Degenerate: a repo segment of exactly '.git' strips to an
      // empty segment, leaving a trailing slash the next pass
      // collapses. Both engines agree (parity holds); no real
      // repository can be named '.git', so this is a probe
      // artifact, not a filed defect.
      if (url === 'https://github.com/user/.git') continue;
      const k = canonicalKeysFallback(url);
      const again = canonicalKeysFallback(k.exactKey);
      expect(again.exactKey, `not idempotent for ${url} → ${k.exactKey}`).toBe(
        k.exactKey,
      );
      if (k.exactKey.startsWith('http')) {
        expect(again, `pair drift for ${url}`).toEqual(k);
      }
    }
  });

  it('exactKey is a fixed point (Wasm)', () => {
    for (const url of allUrls) {
      if (url.includes('drive.google.com/open/?')) continue; // D10
      if (url === 'https://github.com/user/.git') continue; // see TS loop
      const k = wasmKeys(url);
      const again = wasmKeys(k.exactKey);
      expect(again.exactKey, `not idempotent for ${url}`).toBe(k.exactKey);
      if (k.exactKey.startsWith('http')) {
        expect(again, `pair drift for ${url}`).toEqual(k);
      }
    }
  });
});

describe('classification of systematic variant pairs (both engines)', () => {
  const ID = 'AbC123xYz_-9QwErTyUiOp';
  const pairs: Array<{
    name: string;
    a: string;
    b: string;
    expect: 'exact' | 'fuzzy' | 'distinct';
  }> = [
    // ---- exact: same document, same view, cosmetic differences
    {
      name: 'tracking param added',
      a: `https://example.com/post?id=7`,
      b: `https://example.com/post?id=7&utm_source=news&fbclid=zzz`,
      expect: 'exact',
    },
    {
      name: 'utm case variants are all tracking',
      a: `https://example.com/post?id=7`,
      b: `https://example.com/post?id=7&UTM_SOURCE=x&Utm_Medium=y`,
      expect: 'exact',
    },
    {
      name: 'query order is irrelevant',
      a: `https://example.com/s?b=2&a=1&c=3`,
      b: `https://example.com/s?c=3&a=1&b=2`,
      expect: 'exact',
    },
    {
      name: 'duplicate params keep multiplicity and sort',
      a: `https://example.com/s?tag=a&tag=b`,
      b: `https://example.com/s?tag=b&tag=a`,
      expect: 'exact',
    },
    {
      name: 'docs sharing params never enter the key',
      a: `https://docs.google.com/document/d/${ID}/edit`,
      b: `https://docs.google.com/document/d/${ID}/edit?usp=sharing&ouid=42`,
      expect: 'exact',
    },
    {
      name: 'youtube t=90 vs t=1m30s',
      a: `https://www.youtube.com/watch?v=VID123&t=90`,
      b: `https://www.youtube.com/watch?v=VID123&t=1m30s`,
      expect: 'exact',
    },
    {
      name: 'youtube t=090 vs t=90 (leading zeros)',
      a: `https://www.youtube.com/watch?v=VID123&t=090`,
      b: `https://www.youtube.com/watch?v=VID123&t=90`,
      expect: 'exact',
    },
    {
      name: 'youtube t=1h30 (trailing bare seconds) vs t=3630',
      a: `https://www.youtube.com/watch?v=VID123&t=1h30`,
      b: `https://www.youtube.com/watch?v=VID123&t=3630`,
      expect: 'exact',
    },
    {
      name: 'drive /file/d/ vs /open?id=',
      a: `https://drive.google.com/file/d/${ID}/view`,
      b: `https://drive.google.com/open?id=${ID}`,
      expect: 'exact',
    },
    {
      name: 'figma share-timestamp param is not state',
      a: `https://www.figma.com/design/${ID}?node-id=1-2&t=aaa`,
      b: `https://www.figma.com/design/${ID}?node-id=1-2&t=bbb`,
      expect: 'exact',
    },
    {
      name: 'github .git suffix normalized away',
      a: `https://github.com/someuser/somerepo`,
      b: `https://github.com/someuser/somerepo.git`,
      expect: 'exact',
    },
    {
      name: 'notion slug rewrite, same page id',
      a: `https://www.notion.so/Old-Title-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`,
      b: `https://www.notion.so/New-Title-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d?pvs=4`,
      expect: 'exact',
    },
    {
      name: 'notion dashed UUID and bare hex agree',
      a: `https://www.notion.so/Page-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d`,
      b: `https://www.notion.so/Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`,
      expect: 'exact',
    },
    // ---- fuzzy: same document, different view/state
    {
      name: 'www variant is the same document (fuzzy)',
      a: `https://example.com/post?id=7`,
      b: `https://www.example.com/post?id=7`,
      expect: 'fuzzy',
    },
    {
      // Anchor fold (PR #5): Docs heading fragments are folded out
      // of the exact key, so an anchored open is the same document,
      // not another view. (Was 'fuzzy' before the fold; updated on
      // the PR #6 rebase — behavior change, not a regression.)
      name: 'docs heading anchor folds into the document',
      a: `https://docs.google.com/document/d/${ID}/edit`,
      b: `https://docs.google.com/document/d/${ID}/edit#heading=h.zz`,
      expect: 'exact',
    },
    {
      name: 'sheets gid is another view',
      a: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`,
      b: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=99`,
      expect: 'fuzzy',
    },
    {
      name: 'docs edit vs view mode',
      a: `https://docs.google.com/document/d/${ID}/edit`,
      b: `https://docs.google.com/document/d/${ID}/view`,
      expect: 'fuzzy',
    },
    {
      name: 'figma node selection is another view',
      a: `https://www.figma.com/design/${ID}?node-id=1-2`,
      b: `https://www.figma.com/design/${ID}?node-id=9-9`,
      expect: 'fuzzy',
    },
    {
      name: 'github line anchor is another view',
      a: `https://github.com/u/r/blob/main/a.ts#L10`,
      b: `https://github.com/u/r/blob/main/a.ts#L99`,
      expect: 'fuzzy',
    },
    {
      name: 'youtube watch vs shorts, same video',
      a: `https://www.youtube.com/watch?v=VID123`,
      b: `https://www.youtube.com/shorts/VID123`,
      expect: 'fuzzy',
    },
    {
      // youtu.be canonicalizes onto the watch form, so with no
      // view state on either side the pair is exact, not fuzzy.
      name: 'youtube watch vs youtu.be, same video',
      a: `https://www.youtube.com/watch?v=VID123`,
      b: `https://youtu.be/VID123`,
      expect: 'exact',
    },
    {
      name: 'youtube watch with t vs plain youtu.be, same video',
      a: `https://www.youtube.com/watch?v=VID123&t=90`,
      b: `https://youtu.be/VID123`,
      expect: 'fuzzy',
    },
    {
      name: 'generic /amp path variant',
      a: `https://example.com/story`,
      b: `https://example.com/story/amp`,
      expect: 'fuzzy',
    },
    // ---- distinct: different documents — NEVER exact or fuzzy
    {
      name: 'different doc ids',
      a: `https://docs.google.com/document/d/${ID}/edit`,
      b: `https://docs.google.com/document/d/OTHER999/edit`,
      expect: 'distinct',
    },
    {
      name: 'different search queries',
      a: `https://example.com/s?q=cats`,
      b: `https://example.com/s?q=dogs`,
      expect: 'distinct',
    },
    {
      name: 'path case differs (paths are case-sensitive)',
      a: `https://example.com/Article`,
      b: `https://example.com/article`,
      expect: 'distinct',
    },
    {
      name: 'scheme differs',
      a: `http://example.com/post?id=7`,
      b: `https://example.com/post?id=7`,
      expect: 'distinct',
    },
    {
      name: 'different youtube videos',
      a: `https://www.youtube.com/watch?v=VID123`,
      b: `https://www.youtube.com/watch?v=VID999`,
      expect: 'distinct',
    },
    {
      name: 'different notion page ids',
      a: `https://www.notion.so/A-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`,
      b: `https://www.notion.so/A-9a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6e`,
      expect: 'distinct',
    },
    {
      name: 'sheets gid param vs fragment gid are both views of one doc',
      a: `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=5`,
      b: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=6`,
      expect: 'fuzzy',
    },
  ];

  for (const p of pairs) {
    it(`${p.name} → ${p.expect}`, () => {
      expect(
        classify(canonicalKeysFallback(p.a), canonicalKeysFallback(p.b)),
        'TS fallback',
      ).toBe(p.expect);
      expect(classify(wasmKeys(p.a), wasmKeys(p.b)), 'Wasm core').toBe(
        p.expect,
      );
    });
  }
});

describe('absolute key expectations on sharp edges (both engines)', () => {
  const ID = 'AbC123xYz_-9QwErTyUiOp';
  const cases: Array<{ name: string; url: string; exact: string; fuzzy?: string }> = [
    {
      name: 'empty fragment gid on sheets adds no gid state',
      url: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=`,
      exact: `gdoc:spreadsheets:${ID}/edit`,
    },
    {
      name: 'fragment gid wins over query gid',
      url: `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=7#gid=3`,
      exact: `gdoc:spreadsheets:${ID}/edit#gid=3`,
    },
    {
      name: 'first fragment gid wins when repeated',
      url: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0&gid=9`,
      exact: `gdoc:spreadsheets:${ID}/edit#gid=0`,
    },
    {
      name: 'doc rest path after the id is preserved verbatim',
      url: `https://docs.google.com/document/d/${ID}/edit/extra/deep`,
      exact: `gdoc:document:${ID}/edit/extra/deep`,
      fuzzy: `gdoc:document:${ID}`,
    },
    {
      // googleDrive matches the literal path '/open' BEFORE the
      // generic tier's slash normalization, so the trailing-slash
      // form falls to generic (slash normalized away there) and
      // does NOT key as the file — see defect D10 below.
      name: 'drive /open/ (trailing slash) misses the open form — generic key',
      url: `https://drive.google.com/open/?id=${ID}`,
      exact: `https://drive.google.com/open?id=${ID}`,
    },
    {
      name: 'empty watch?v= falls back to generic',
      url: `https://www.youtube.com/watch?v=`,
      exact: `https://www.youtube.com/watch?v=`,
    },
    {
      name: 'non-doc google app (forms) is generic, not gdoc',
      url: `https://docs.google.com/forms/d/${ID}/viewform`,
      exact: `https://docs.google.com/forms/d/${ID}/viewform`,
    },
    {
      name: '31-hex notion slug is not a page id — generic',
      url: `https://www.notion.so/Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`,
      exact: `https://www.notion.so/Page-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`,
    },
    {
      name: 'hex tail not preceded by a dash is not a page id',
      url: `https://www.notion.so/PageX1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`,
      exact: `https://www.notion.so/PageX1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`,
    },
    {
      name: 'uppercase notion id normalizes to lowercase',
      url: `https://www.notion.so/Page-1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D`,
      exact: `notion:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d`,
    },
    {
      name: 'youtube unparseable t passes through unchanged',
      url: `https://www.youtube.com/watch?v=VID&t=1x`,
      exact: `yt:watch:VID?t=1x`,
    },
    {
      name: 'youtube t=0 and t=0s agree at zero',
      url: `https://www.youtube.com/watch?v=VID&t=0s`,
      exact: `yt:watch:VID?t=0`,
    },
    {
      name: 'non-http input is its own key',
      url: `chrome://extensions/`,
      exact: `chrome://extensions/`,
      fuzzy: `chrome://extensions/`,
    },
    {
      name: 'surrounding whitespace is trimmed before keying',
      url: `  https://example.com/a  `,
      exact: `https://example.com/a`,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      for (const [label, keys] of [
        ['TS', canonicalKeysFallback(c.url)],
        ['Wasm', wasmKeys(c.url)],
      ] as const) {
        expect(keys.exactKey, label).toBe(c.exact);
        if (c.fuzzy !== undefined) expect(keys.fuzzyKey, label).toBe(c.fuzzy);
      }
    });
  }

  it('characterization: an empty ?gid= still marks the exact key (both engines agree)', () => {
    // Not a parity bug — both implementations append the empty gid
    // marker for the query form while the fragment form adds none.
    // Precision-safe (never merges different views), recorded here
    // so the asymmetry is a decision, not an accident.
    const url = `https://docs.google.com/spreadsheets/d/${ID}/edit?gid=`;
    expect(canonicalKeysFallback(url).exactKey).toBe(
      `gdoc:spreadsheets:${ID}/edit#gid=`,
    );
    expect(wasmKeys(url).exactKey).toBe(`gdoc:spreadsheets:${ID}/edit#gid=`);
  });
});

// -------------------------------------------------------------------
// Known parity defects (hot file: src/lib/canonicalize.ts — fixes
// intentionally NOT made on this branch; see hardening report).
// Each asserts the contract (both engines agree) and fails today.
// -------------------------------------------------------------------

describe('known defects — canonicalizer parity', () => {
  it.fails(
    'D3: duplicate param values sort identically for astral vs U+FFFD values',
    () => {
      // TS cmpPairs compares UTF-16 code units (an astral char's
      // lead surrogate 0xD800 sorts before U+FFFD); the Rust core
      // compares UTF-8 bytes (= code-point order, U+FFFD first).
      // Same URL, two different exact keys by engine.
      const url = 'https://example.com/?b=\uFFFD&b=\u{10000}';
      expect(canonicalKeysFallback(url)).toEqual(wasmKeys(url));
    },
  );

  it.fails(
    'D4: youtube unit timestamps beyond f64 precision normalize identically',
    () => {
      // TS normalizeTimestamp accumulates in an f64 (rounds /
      // switches to exponent form); the Rust core saturates a u64.
      const huge = 'https://www.youtube.com/watch?v=VID&t=99999999999999999999h';
      expect(canonicalKeysFallback(huge)).toEqual(wasmKeys(huge));
      const precise = 'https://www.youtube.com/watch?v=VID&t=9007199254740993s';
      expect(canonicalKeysFallback(precise)).toEqual(wasmKeys(precise));
    },
  );

  it.fails(
    'D5: a U+FEFF-prefixed URL keys identically in both engines',
    () => {
      // JS trim() removes U+FEFF, so the TS fallback parses the
      // URL; Rust char::is_whitespace excludes U+FEFF, so the core
      // treats the input as unparseable identity.
      const url = '\uFEFFhttps://example.com/a';
      expect(canonicalKeysFallback(url)).toEqual(wasmKeys(url));
    },
  );

  it.fails(
    'D10: drive /open/ with a trailing slash keys as the same file as /file/d/',
    () => {
      // Both engines match the literal path '/open' before slash
      // normalization, so the trailing-slash form — which Drive
      // itself serves — falls through to generic and the same
      // file open in both forms is never recognized as a
      // duplicate. Precision-safe (a recall miss), shared by both
      // implementations; the fix (normalize the path before the
      // /open check) lives in the hot files.
      const a = canonicalKeysFallback(
        'https://drive.google.com/file/d/SOMEFILEID/view',
      );
      const b = canonicalKeysFallback(
        'https://drive.google.com/open/?id=SOMEFILEID',
      );
      expect(classify(a, b)).toBe('exact');
      expect(
        classify(
          wasmKeys('https://drive.google.com/file/d/SOMEFILEID/view'),
          wasmKeys('https://drive.google.com/open/?id=SOMEFILEID'),
        ),
      ).toBe('exact');
      // Second face of the same defect: the generic key minted
      // for the trailing-slash form is not a fixed point — fed
      // back in, it is claimed by the /open rule after all.
      const first = canonicalKeysFallback(
        'https://drive.google.com/open/?id=SOMEFILEID',
      );
      expect(canonicalKeysFallback(first.exactKey).exactKey).toBe(
        first.exactKey,
      );
    },
  );
});
