/**
 * Pure-TypeScript URL normalization fallback.
 *
 * Mirrors the Rust core's `normalize_url` (core/src/lib.rs) exactly for the
 * M0 stub behavior:
 *   - trims surrounding whitespace
 *   - lowercases the scheme and host
 *   - drops the default port (80 for http, 443 for https)
 *   - uses "/" when the path is empty
 *
 * This is deliberately NOT the M1 canonicalizer: no tracking-parameter
 * stripping, no anchor normalization, no per-app document IDs yet.
 * It exists so the extension keeps working while the Wasm module is
 * still instantiating (or if instantiation fails) — see src/wasm/load.ts.
 */
export function normalizeUrlFallback(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  // `new URL()` already lowercases scheme/host and drops default ports in
  // most engines, but do it explicitly so behavior matches the Rust core
  // bit-for-bit regardless of runtime quirks.
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  const isDefaultPort =
    (scheme === 'http' && url.port === '80') ||
    (scheme === 'https' && url.port === '443');
  const port = url.port && !isDefaultPort ? `:${url.port}` : '';
  const path = url.pathname === '' ? '/' : url.pathname;
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : '';
  return `${scheme}://${auth}${host}${port}${path}${url.search}${url.hash}`;
}
