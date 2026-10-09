/**
 * Canonicalizer v1 — pure-TypeScript mirror of the Rust core's
 * `canonicalize_url` (core/src/canon.rs). The two implementations MUST
 * agree bit-for-bit; both are held to the golden corpus in
 * tests/corpus/canonical-cases.json (consumed by vitest here and by
 * `cargo test` on the Rust side).
 *
 * Returns two keys per URL:
 *   exactKey — same document, same view/state (auto-close eligible)
 *   fuzzyKey — same document, possibly different view/state
 *              (suggestion tier only, NEVER auto-closed)
 *
 * See core/src/canon.rs for the full rule documentation; comments here
 * only flag mirror-specific mechanics.
 */

export interface CanonKeys {
  exactKey: string;
  fuzzyKey: string;
}

function identity(trimmed: string): CanonKeys {
  return { exactKey: trimmed, fuzzyKey: trimmed };
}

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'gclsrc',
  'gad_source',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
  'igshid',
  'twclid',
  'li_fat_id',
  's_cid',
  'spm',
  'scm',
  'vero_id',
  'yclid',
  'rb_clickid',
  's_kwcid',
  '_hsenc',
  '_hsmi',
  'hsa_acc',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
  'hsa_src',
  'hsa_tgt',
  'hsa_kw',
  'hsa_mt',
  'hsa_net',
  'hsa_ver',
]);

function isYouTubeHost(host: string): boolean {
  return (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be'
  );
}

function isTracking(name: string, host: string): boolean {
  if (name.length >= 4 && name.slice(0, 4).toLowerCase() === 'utm_') {
    return true;
  }
  if (TRACKING_PARAMS.has(name)) return true;
  if (name === 'ref' && host !== 'github.com') return true;
  if (name === 'si' && isYouTubeHost(host)) return true;
  return false;
}

type Pair = [string, string];

function cmpPairs(a: Pair, b: Pair): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

function cleanPairs(pairs: readonly Pair[], host: string): Pair[] {
  return pairs.filter(([name]) => !isTracking(name, host)).sort(cmpPairs);
}

function encodePairs(pairs: readonly Pair[]): string {
  return new URLSearchParams([...pairs]).toString();
}

function normPath(path: string): string {
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  if (path === '') return '/';
  return path;
}

function buildUrl(
  scheme: string,
  auth: string,
  host: string,
  port: number | null,
  path: string,
  pairs: readonly Pair[],
  fragment: string | null,
): string {
  let out = `${scheme}://${auth}${host}`;
  if (port !== null) out += `:${port}`;
  out += path;
  if (pairs.length > 0) out += `?${encodePairs(pairs)}`;
  if (fragment !== null && fragment !== '') out += `#${fragment}`;
  return out;
}

function fuzzyHost(host: string): string {
  for (const label of ['www.', 'mobile.', 'amp.', 'm.']) {
    if (host.startsWith(label) && host.length > label.length) {
      return host.slice(label.length);
    }
  }
  return host;
}

function fuzzyPath(path: string): string {
  if (path.endsWith('/amp')) {
    const rest = path.slice(0, -4);
    return rest === '' ? '/' : rest;
  }
  return path;
}

function fuzzyPairs(pairs: readonly Pair[]): Pair[] {
  return pairs.filter(
    ([name, value]) => name !== 'amp' && !(name === 'output' && value === 'amp'),
  );
}

interface Parts {
  scheme: string;
  auth: string;
  host: string;
  port: number | null;
  path: string;
  pairs: Pair[];
  /** Fragment without the leading '#'; '' when absent or empty. */
  fragment: string;
}

function segmentsOf(parts: Parts): string[] {
  return parts.path.split('/').filter((s) => s !== '');
}

function paramOf(parts: Parts, name: string): string | null {
  const found = parts.pairs.find(([n]) => n === name);
  return found ? found[1] : null;
}

/**
 * Canonicalize a URL into its exact and fuzzy dedupe keys.
 * Mirrors `canonical_keys` in core/src/canon.rs.
 */
export function canonicalKeysFallback(raw: string): CanonKeys {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) return identity(trimmed);
  const schemeProbe = trimmed.slice(0, colon).toLowerCase();
  if (schemeProbe !== 'http' && schemeProbe !== 'https') {
    return identity(trimmed);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return identity(trimmed);
  }
  const auth = url.username
    ? `${url.username}${url.password ? `:${url.password}` : ''}@`
    : '';
  const parts: Parts = {
    scheme: url.protocol.replace(/:$/, '').toLowerCase(),
    auth,
    host: url.hostname,
    port: url.port === '' ? null : Number(url.port),
    path: url.pathname,
    pairs: Array.from(url.searchParams.entries()),
    fragment: url.hash.startsWith('#') ? url.hash.slice(1) : '',
  };

  const bareHost = parts.host.startsWith('www.')
    ? parts.host.slice(4)
    : parts.host;

  if (bareHost === 'docs.google.com') {
    const keys = googleDocs(parts);
    if (keys) return keys;
  } else if (bareHost === 'drive.google.com') {
    const keys = googleDrive(parts);
    if (keys) return keys;
  } else if (isNotionHost(parts.host)) {
    const keys = notion(parts);
    if (keys) return keys;
  } else if (bareHost === 'github.com') {
    return github(parts);
  } else if (bareHost === 'figma.com') {
    const keys = figma(parts);
    if (keys) return keys;
  } else if (isYouTubeHost(parts.host)) {
    const keys = youtube(parts);
    if (keys) return keys;
  }
  return generic(parts);
}

function generic(parts: Parts): CanonKeys {
  const pairs = cleanPairs(parts.pairs, parts.host);
  const path = normPath(parts.path);
  const exactKey = buildUrl(
    parts.scheme,
    parts.auth,
    parts.host,
    parts.port,
    path,
    pairs,
    null,
  );
  const fuzzyKey = buildUrl(
    parts.scheme,
    parts.auth,
    fuzzyHost(parts.host),
    parts.port,
    fuzzyPath(path),
    fuzzyPairs(pairs),
    null,
  );
  return { exactKey, fuzzyKey };
}

function github(parts: Parts): CanonKeys {
  const pairs = cleanPairs(parts.pairs, 'github.com');
  let path = normPath(parts.path);
  const segs = path.split('/');
  if (segs.length > 2 && segs[2].endsWith('.git')) {
    segs[2] = segs[2].slice(0, -4);
    path = segs.join('/');
  }
  const exactKey = buildUrl(
    parts.scheme,
    parts.auth,
    'github.com',
    parts.port,
    path,
    pairs,
    parts.fragment,
  );
  const fuzzy = buildUrl(
    parts.scheme,
    parts.auth,
    'github.com',
    parts.port,
    path,
    pairs.filter(([n]) => n !== 'plain' && n !== 'ts'),
    null,
  );
  return { exactKey, fuzzyKey: fuzzy };
}

function googleDocs(parts: Parts): CanonKeys | null {
  const segs = segmentsOf(parts);
  const app = segs[0];
  if (app !== 'document' && app !== 'spreadsheets' && app !== 'presentation') {
    return null;
  }
  const dIdx = segs.indexOf('d');
  if (dIdx <= 0) return null;
  const id = segs[dIdx + 1];
  if (!id) return null;
  const rest = segs.slice(dIdx + 2);
  let exactKey = `gdoc:${app}:${id}`;
  if (rest.length > 0) exactKey += `/${rest.join('/')}`;
  if (app === 'spreadsheets') {
    const gid = sheetsGid(parts);
    if (gid !== null) exactKey += `#gid=${gid}`;
  } else if (parts.fragment !== '') {
    exactKey += `#${parts.fragment}`;
  }
  return { exactKey, fuzzyKey: `gdoc:${app}:${id}` };
}

function sheetsGid(parts: Parts): string | null {
  if (parts.fragment !== '') {
    for (const pair of parts.fragment.split('&')) {
      if (pair.startsWith('gid=')) {
        const value = pair.slice(4);
        if (value !== '') return value;
      }
    }
  }
  return paramOf(parts, 'gid');
}

function googleDrive(parts: Parts): CanonKeys | null {
  const segs = segmentsOf(parts);
  if (segs.length >= 3 && segs[0] === 'file' && segs[1] === 'd' && segs[2] !== '') {
    const key = `gdrive:file:${segs[2]}`;
    return { exactKey: key, fuzzyKey: key };
  }
  if (parts.path === '/open') {
    const id = paramOf(parts, 'id');
    if (id !== null && id !== '') {
      const key = `gdrive:file:${id}`;
      return { exactKey: key, fuzzyKey: key };
    }
  }
  return null;
}

function isNotionHost(host: string): boolean {
  return (
    host === 'notion.so' ||
    host.endsWith('.notion.so') ||
    host === 'notion.site' ||
    host.endsWith('.notion.site')
  );
}

function notion(parts: Parts): CanonKeys | null {
  const segs = segmentsOf(parts);
  const last = segs[segs.length - 1];
  if (last === undefined) return null;
  const id = extractNotionId(last);
  if (id === null) return null;
  const key = `notion:${id}`;
  return { exactKey: key, fuzzyKey: key };
}

function extractNotionId(segment: string): string | null {
  const dashed = segment.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
  if (dashed) return dashed[0].replace(/-/g, '').toLowerCase();
  if (segment.length >= 32) {
    const tail = segment.slice(-32);
    if (/^[0-9a-fA-F]{32}$/.test(tail)) {
      if (segment.length === 32 || segment[segment.length - 33] === '-') {
        return tail.toLowerCase();
      }
    }
  }
  return null;
}

function figma(parts: Parts): CanonKeys | null {
  const segs = segmentsOf(parts);
  const mode = segs[0];
  if (
    mode !== 'design' &&
    mode !== 'file' &&
    mode !== 'proto' &&
    mode !== 'board' &&
    mode !== 'slides'
  ) {
    return null;
  }
  const key = segs[1];
  if (!key) return null;
  const state: Pair[] = [];
  for (const name of ['node-id', 'page-id']) {
    const value = paramOf(parts, name);
    if (value !== null) state.push([name, value]);
  }
  state.sort(cmpPairs);
  let exactKey = `figma:${mode}:${key}`;
  if (state.length > 0) exactKey += `?${encodePairs(state)}`;
  return { exactKey, fuzzyKey: `figma:${key}` };
}

function youtube(parts: Parts): CanonKeys | null {
  if (parts.host === 'youtu.be') {
    const segs = segmentsOf(parts);
    if (segs.length === 1 && segs[0] !== '') {
      return youtubeWatch(segs[0], parts);
    }
    return null;
  }
  const segs = segmentsOf(parts);
  const first = segs[0];
  if (first === 'watch' && segs.length === 1) {
    const vid = paramOf(parts, 'v');
    if (vid === null || vid === '') return null;
    return youtubeWatch(vid, parts);
  }
  if (
    (first === 'shorts' || first === 'live' || first === 'embed') &&
    segs.length === 2 &&
    segs[1] !== ''
  ) {
    return {
      exactKey: `yt:${first}:${segs[1]}`,
      fuzzyKey: `yt:video:${segs[1]}`,
    };
  }
  if (first === 'playlist' && segs.length === 1) {
    const list = paramOf(parts, 'list');
    if (list === null || list === '') return null;
    const key = `yt:playlist:${list}`;
    return { exactKey: key, fuzzyKey: key };
  }
  return null;
}

function youtubeWatch(vid: string, parts: Parts): CanonKeys {
  const state: Pair[] = [];
  const list = paramOf(parts, 'list');
  if (list !== null && list !== '') state.push(['list', list]);
  for (const name of ['start', 't']) {
    const value = paramOf(parts, name);
    if (value !== null && value !== '') {
      state.push([name, normalizeTimestamp(value)]);
    }
  }
  state.sort(cmpPairs);
  let exactKey = `yt:watch:${vid}`;
  if (state.length > 0) exactKey += `?${encodePairs(state)}`;
  return { exactKey, fuzzyKey: `yt:video:${vid}` };
}

/** Mirror of `normalize_timestamp` in core/src/canon.rs. */
function normalizeTimestamp(raw: string): string {
  if (raw !== '' && /^[0-9]+$/.test(raw)) {
    const t = raw.replace(/^0+/, '');
    return t === '' ? '0' : t;
  }
  let total = 0;
  let num = 0;
  let seenNum = false;
  let seenUnit = false;
  for (const c of raw) {
    if (c >= '0' && c <= '9') {
      num = num * 10 + (c.charCodeAt(0) - 48);
      seenNum = true;
    } else {
      const mult =
        c === 'h' ? 3600 : c === 'm' ? 60 : c === 's' ? 1 : null;
      if (mult === null || !seenNum) return raw;
      total += num * mult;
      num = 0;
      seenNum = false;
      seenUnit = true;
    }
  }
  if (!seenUnit) return raw;
  if (seenNum) total += num;
  return String(total);
}
