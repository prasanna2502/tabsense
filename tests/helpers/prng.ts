/**
 * Deterministic PRNG + small random helpers for the hardening
 * suites. Same mulberry32 family as tests/corpus-urls.ts: a fixed
 * seed drives every choice, so generated corpora are identical on
 * every run and a failure is reproducible forever.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(private readonly next: () => number) {}

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [min, max] inclusive. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }

  /** A shuffled copy (Fisher–Yates on the seeded stream). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** A random subset (possibly empty), in original order. */
  subset<T>(items: readonly T[]): T[] {
    return items.filter(() => this.bool());
  }

  /** `len` chars from `alphabet`. */
  chars(alphabet: string, len: number): string {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += alphabet[this.int(alphabet.length)];
    }
    return out;
  }
}

export function rng(seed: number): Rng {
  return new Rng(mulberry32(seed));
}
