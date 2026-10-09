/**
 * Sensitive-domain blocklist (M2). Tabs on blocklisted hosts are
 * never suggested or grouped — not clustered, not assigned, not
 * shown as suggestion members. Matching is host-based: an entry
 * covers the host itself and all its subdomains.
 *
 * The default list is deliberately small and conservative: sign-in,
 * banking/payments, health portals, and password-manager vaults —
 * places where "organizing" tabs could also mean exposing them.
 * Users can replace it wholesale in Settings (an empty user list is
 * a legitimate choice and is honored as-is).
 */

import { hostOf } from './scorer';

export const DEFAULT_BLOCKLIST: readonly string[] = [
  'accounts.google.com',
  'myaccount.google.com',
  'americanexpress.com',
  'bankofamerica.com',
  'capitalone.com',
  'chase.com',
  'citi.com',
  'coinbase.com',
  'venmo.com',
  'paypal.com',
  'wellsfargo.com',
  'mychart.com',
  'kp.org',
  '1password.com',
  'bitwarden.com',
  'lastpass.com',
];

/** Normalize one user-entered entry: accept full URLs, bare hosts,
 * and sloppy whitespace; return a bare lowercase host or "". */
export function normalizeBlocklistEntry(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s === '') return '';
  if (s.includes('://')) {
    const host = hostOf(s);
    if (host) return host;
    s = s.split('://')[1] ?? '';
  }
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  while (s.startsWith('www.')) s = s.slice(4);
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s) && s.includes('.')
    ? s
    : '';
}

/** Parse the settings textarea (one entry per line; commas also
 * work) into a clean, deduped, sorted list. */
export function parseBlocklist(text: string): string[] {
  const out = new Set<string>();
  for (const piece of text.split(/[\n,]/)) {
    const entry = normalizeBlocklistEntry(piece);
    if (entry) out.add(entry);
  }
  return [...out].sort();
}

/** True when the URL's host is a blocklist entry or its subdomain. */
export function isBlocklisted(
  url: string,
  blocklist: readonly string[],
): boolean {
  const host = hostOf(url);
  if (host === '') return false;
  return blocklist.some(
    (entry) => host === entry || host.endsWith(`.${entry}`),
  );
}
