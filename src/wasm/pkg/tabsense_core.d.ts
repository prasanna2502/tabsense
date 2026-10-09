/* tslint:disable */
/* eslint-disable */

/**
 * Canonicalize a URL to its two M1 dedupe keys, returned as a JSON
 * string `{"exact":"...","fuzzy":"..."}`:
 *
 * - `exact` — same document, same view/state (auto-close eligible)
 * - `fuzzy` — same document, possibly different view/state
 *   (suggestion tier only, never auto-closed)
 */
export function canonicalize_url(raw: string): string;

/**
 * Cluster ungrouped tabs (M2 heuristic router). Payload: a JSON
 * array of TabInput; returns a JSON array of
 * `{tabIds, nameSeed, cohesion}` clusters of 2+ tabs.
 */
export function cluster_tabs(payload: string): string;

/**
 * Normalize a URL string:
 *
 * - trims surrounding whitespace
 * - lowercases the scheme and host
 * - drops the default port (80 for http, 443 for https)
 * - uses "/" when the path is empty
 * - preserves path case, query string, and fragment
 * - returns the trimmed input unchanged when it does not parse as a URL
 */
export function normalize_url(raw: string): string;

/**
 * Score one tab against existing groups (M2 heuristic router).
 * Payload: `{"tab": TabInput, "groups": [GroupInput]}`; returns a
 * JSON array of up to 5 `{groupKey, score}` candidates.
 */
export function score_candidates(payload: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly canonicalize_url: (a: number, b: number) => [number, number];
    readonly cluster_tabs: (a: number, b: number) => [number, number];
    readonly normalize_url: (a: number, b: number) => [number, number];
    readonly score_candidates: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
