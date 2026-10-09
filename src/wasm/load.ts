import initWasm, { canonicalize_url, normalize_url } from './pkg/tabsense_core';
import { CORE_WASM_BASE64 } from './core-bytes';
import { normalizeUrlFallback } from '../lib/normalize';
import {
  canonicalKeysFallback,
  type CanonKeys,
} from '../lib/canonicalize';

/**
 * Async loader for the Rust core compiled to WebAssembly.
 *
 * Design rules (proposal §5, §10.1):
 *  - Instantiation is async and happens off the tab-open path, during
 *    worker warm-up.
 *  - Nothing blocks on it: until the core is ready — or if it fails —
 *    callers use the pure-TS fallback and the extension keeps working.
 */

let ready = false;
let failed = false;
let initPromise: Promise<boolean> | null = null;

/**
 * Core lifecycle state. The duplicate engine gates auto-close on this:
 * decisions are only taken in `ready`; in `pending` events queue, and
 * in `failed` the engine stays in no-auto-close mode (M1 spec).
 */
export type CoreState = 'pending' | 'ready' | 'failed';

export function getCoreState(): CoreState {
  if (ready) return 'ready';
  if (failed) return 'failed';
  return 'pending';
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Start (or reuse) core instantiation. Never rejects. */
export function ensureCoreReady(): Promise<boolean> {
  if (ready) return Promise.resolve(true);
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await initWasm({ module_or_path: decodeBase64(CORE_WASM_BASE64) });
        ready = true;
        return true;
      } catch (err) {
        failed = true;
        console.warn('[tabsense] Wasm core unavailable, using TS fallback:', err);
        return false;
      }
    })();
  }
  return initPromise;
}

export function isCoreReady(): boolean {
  return ready;
}

/**
 * Normalize a URL with the Wasm core when ready, otherwise the TS
 * fallback. Returns which engine produced the result so callers can
 * surface it for diagnostics.
 */
export function normalizeUrl(url: string): { normalized: string; engine: 'wasm' | 'fallback' } {
  if (ready) {
    try {
      return { normalized: normalize_url(url), engine: 'wasm' };
    } catch (err) {
      console.warn('[tabsense] Wasm normalize_url failed, using fallback:', err);
    }
  }
  return { normalized: normalizeUrlFallback(url), engine: 'fallback' };
}

/**
 * Canonicalize a URL to its M1 exact/fuzzy dedupe keys, with the same
 * engine selection as normalizeUrl. The two implementations are held
 * to bit-for-bit parity by the golden corpus, so keys are identical
 * whichever engine answers — the engine gate matters only for the
 * auto-close *decision* (see getCoreState), never for the keys.
 */
export function canonicalKeys(
  url: string,
): { keys: CanonKeys; engine: 'wasm' | 'fallback' } {
  if (ready) {
    try {
      const parsed = JSON.parse(canonicalize_url(url)) as {
        exact: string;
        fuzzy: string;
      };
      return {
        keys: { exactKey: parsed.exact, fuzzyKey: parsed.fuzzy },
        engine: 'wasm',
      };
    } catch (err) {
      console.warn('[tabsense] Wasm canonicalize_url failed, using fallback:', err);
    }
  }
  return { keys: canonicalKeysFallback(url), engine: 'fallback' };
}
