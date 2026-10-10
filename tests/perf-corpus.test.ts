/**
 * M3 unit-level perf suite — corpus benchmarks (per-PR gate).
 *
 * Budgets (perf-budgets.json):
 *  - canonical-key-and-lookup-p95 < 5 ms: canonical-key compute +
 *    duplicate-index lookup per tab event, p95 over the corpus.
 *  - duplicate-index-rebuild-500 < 100 ms: rebuilding the duplicate
 *    index from scratch for a 500-tab session.
 *
 * The canonicalizer path is the worker's own: entrypoints/
 * background.ts imports `canonicalKeys` from src/wasm/load, which
 * answers with the Wasm core in production and with the pure-TS
 * mirror (src/lib/canonicalize.ts `canonicalKeysFallback`) until
 * the core is ready. Tests never instantiate the core, so the TS
 * mirror is what is measured here — that is deliberate: the two
 * implementations are bit-parity-identical (golden corpus), and the
 * TS path is the per-PR gate.
 *
 * The index manipulation mirrors the worker's exactly: a
 * Map<string, Set<number>> (`exactIndex` in background.ts) with
 * get-or-create + add per tab.
 */

import { describe, expect, it } from 'vitest';
import {
  findExactDuplicateSets,
  type KeyedTab,
} from '../src/lib/duplicates';
import { canonicalKeys } from '../src/wasm/load';
import { CORPUS_SIZE, corpusStats, generateCorpus } from './corpus-urls';

const corpus = generateCorpus();

function percentile(sortedAsc: number[], p: number): number {
  return sortedAsc[
    Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1)
  ];
}

describe('perf corpus — shape and determinism', () => {
  it('generates exactly 10,000 URLs, identically on every run', () => {
    expect(corpus).toHaveLength(CORPUS_SIZE);
    expect(generateCorpus()).toEqual(corpus);
    // Every base document's URL string is distinct; variants may
    // repeat a string only when the same base is drawn twice.
    expect(new Set(corpus).size).toBeGreaterThanOrEqual(8_200);
  });

  it('corpus sanity: duplicate rate stays in the intended 15–25% band', () => {
    const stats = corpusStats(corpus);
    expect(stats.total).toBe(CORPUS_SIZE);
    expect(stats.uniqueExactKeys).toBe(
      stats.total - stats.duplicateUrls,
    );
    expect(stats.duplicateRate).toBeGreaterThanOrEqual(0.15);
    expect(stats.duplicateRate).toBeLessThanOrEqual(0.25);
  }, 60_000);
});

describe('perf — canonical-key compute + index lookup (budget: p95 < 5 ms)', () => {
  it('p95 over the 10,000-URL corpus is under the 5 ms budget', () => {
    // Warm-up so the measurement is steady-state JIT, not first-run
    // compilation of the canonicalizer.
    for (let i = 0; i < 500; i++) canonicalKeys(corpus[i]);

    const exactIndex = new Map<string, Set<number>>();
    const timings = new Array<number>(corpus.length);
    let duplicateUrls = 0;
    for (let i = 0; i < corpus.length; i++) {
      const t0 = performance.now();
      const { keys } = canonicalKeys(corpus[i]);
      // The worker's indexAdd + duplicate probe (background.ts):
      // get-or-create the key's set, add this tab, and know whether
      // the key was already present.
      const alreadyIndexed = exactIndex.has(keys.exactKey);
      let set = exactIndex.get(keys.exactKey);
      if (!set) {
        set = new Set<number>();
        exactIndex.set(keys.exactKey, set);
      }
      set.add(i);
      timings[i] = performance.now() - t0;
      if (alreadyIndexed) duplicateUrls++;
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const duplicateRate = duplicateUrls / corpus.length;
    console.log(
      `[perf] canonical+lookup n=${corpus.length} median=${median.toFixed(4)} ms ` +
        `p95=${p95.toFixed(4)} ms max=${sorted[sorted.length - 1].toFixed(4)} ms ` +
        `duplicateRate=${duplicateRate.toFixed(3)}`,
    );

    expect(p95).toBeLessThan(5);
    // Sanity (task 2c): the benchmarked stream really contained the
    // intended share of exact duplicates — it cannot silently
    // degenerate to all-unique URLs.
    expect(duplicateRate).toBeGreaterThanOrEqual(0.15);
    expect(duplicateRate).toBeLessThanOrEqual(0.25);
    expect(exactIndex.size).toBe(corpus.length - duplicateUrls);
  }, 60_000);
});

describe('perf — duplicate index rebuild, 500 tabs (budget: < 100 ms)', () => {
  /** Rebuild from raw URLs exactly as worker start does:
   * canonicalize every tab, fill the exactKey Map, and derive the
   * exact duplicate sets. */
  function rebuild(urls: readonly string[]): {
    index: Map<string, Set<number>>;
    sets: ReturnType<typeof findExactDuplicateSets>;
  } {
    const keyed: KeyedTab[] = urls.map((url, i) => {
      const { keys } = canonicalKeys(url);
      return {
        id: i + 1,
        exactKey: keys.exactKey,
        fuzzyKey: keys.fuzzyKey,
        firstSeenAt: i,
      };
    });
    const index = new Map<string, Set<number>>();
    for (const tab of keyed) {
      if (tab.exactKey === null) continue;
      let set = index.get(tab.exactKey);
      if (!set) {
        set = new Set<number>();
        index.set(tab.exactKey, set);
      }
      set.add(tab.id);
    }
    return { index, sets: findExactDuplicateSets(keyed) };
  }

  it('rebuilds the index for 500 tabs in under 100 ms', () => {
    rebuild(corpus.slice(500, 1000)); // warm-up pass, untimed
    const urls = corpus.slice(0, 500);
    const t0 = performance.now();
    const { index, sets } = rebuild(urls);
    const elapsed = performance.now() - t0;
    console.log(
      `[perf] rebuild-500 elapsed=${elapsed.toFixed(2)} ms ` +
        `uniqueKeys=${index.size} duplicateSets=${sets.length}`,
    );
    expect(index.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  }, 60_000);
});
