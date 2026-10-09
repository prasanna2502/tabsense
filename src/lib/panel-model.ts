/**
 * Pure display helpers for the side panel (M1.1 UX reset).
 *
 * The panel shows hosts and paths, never full URLs, in its default
 * rows — these helpers own that formatting so it is unit-testable
 * and consistent across duplicate cards, the activity log, and the
 * All tabs list.
 */

/** Host for display: "docs.google.com" — scheme, port, credentials,
 * and a leading "www." are dropped. Unparseable input is returned
 * trimmed (or "" when there is nothing to show). */
export function hostLabel(url: string): string {
  if (!url) return '';
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./, '');
  } catch {
    return url.trim();
  }
}

/** Host + path for display: "docs.google.com/spreadsheets/d/…".
 * The query string and fragment are dropped; a bare "/" path shows
 * as just the host. */
export function hostPathLabel(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return path ? host + path : host;
  } catch {
    return url.trim();
  }
}

/** "1 tab" / "4 tabs" — count-aware pluralization for panel copy. */
export function pluralize(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Letter for the fallback favicon tile when a tab has no favicon
 * (or it fails to load): the title's first letter, else the host's,
 * else a bullet. Always uppercase, always a single character. */
export function faviconFallbackLetter(title: string, url: string): string {
  const fromTitle = title.trim().match(/[\p{L}\p{N}]/u)?.[0];
  if (fromTitle) return fromTitle.toUpperCase();
  const fromHost = hostLabel(url).match(/[\p{L}\p{N}]/u)?.[0];
  if (fromHost) return fromHost.toUpperCase();
  return '•';
}
