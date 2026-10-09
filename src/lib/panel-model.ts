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

// -------------------------------------------------------------------
// View descriptors (M1.2)
//
// Member rows inside a duplicate/similar card must never repeat the
// document title or show a raw URL — the reader cannot tell five
// identical rows apart, and document IDs are meaningless noise.
// Instead each member gets a short descriptor of *which view* of the
// document it is, derived only from structural URL signals (path
// mode, fragment kind, presence of a parameter). Descriptors never
// include document IDs or raw query values — the only values shown
// are a sheet's gid and a video's start time, which are exactly the
// state the user is choosing between.
// -------------------------------------------------------------------

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function bareHost(u: URL): string {
  return u.hostname.replace(/^www\./, '');
}

/** Fragment "#a=1&b=2" → ["a=1", "b=2"] (the "#x" form → ["x"]). */
function fragmentPairs(u: URL): string[] {
  const frag = u.hash.replace(/^#/, '');
  return frag === '' ? [] : frag.split('&');
}

function fragmentParam(u: URL, name: string): string | null {
  for (const pair of fragmentPairs(u)) {
    if (pair.startsWith(`${name}=`)) {
      const value = pair.slice(name.length + 1);
      if (value !== '') return value;
    }
  }
  return null;
}

const GOOGLE_MODE_LABELS: Record<string, string> = {
  edit: 'Edit view',
  view: 'Read view',
  preview: 'Preview',
  comment: 'Comment view',
};

function googleWorkspaceDescriptor(u: URL): string | null {
  const segs = u.pathname.split('/').filter(Boolean);
  const app = segs[0];
  if (app !== 'document' && app !== 'spreadsheets' && app !== 'presentation') {
    return null;
  }
  const dIdx = segs.indexOf('d');
  if (dIdx < 0 || !segs[dIdx + 1]) return null;
  const modeLabel = GOOGLE_MODE_LABELS[segs[dIdx + 2]] ?? null;

  if (app === 'spreadsheets') {
    const gid = fragmentParam(u, 'gid') ?? u.searchParams.get('gid');
    if (gid) return `Sheet tab ${gid}`;
  }
  if (app === 'presentation') {
    const parts: string[] = [];
    if (modeLabel) parts.push(modeLabel);
    if (fragmentParam(u, 'slide') !== null) parts.push('Linked slide');
    return parts.length > 0 ? parts.join(' · ') : null;
  }
  // Docs (and Sheets without a gid): mode, plus a fragment suffix.
  const frag = u.hash.replace(/^#/, '');
  let suffix: string | null = null;
  if (frag !== '') {
    suffix = frag.startsWith('heading=') ? 'linked section' : 'linked position';
  }
  if (modeLabel && suffix) return `${modeLabel} · ${suffix}`;
  if (modeLabel) return modeLabel;
  if (suffix === 'linked section') return 'Linked section';
  if (suffix === 'linked position') return 'Linked position';
  return null;
}

function figmaDescriptor(u: URL): string | null {
  if (bareHost(u) !== 'figma.com') return null;
  if (u.searchParams.has('node-id')) return 'Selected element';
  if (u.searchParams.has('page-id')) return 'Page view';
  return null;
}

/** "90" / "90s" / "1m30s" / "1h2m3s" → total seconds, or null. */
function parseTimestamp(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    return null;
  }
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Seconds → "1:30" (m:ss) or "1:01:01" (h:mm:ss). */
function formatTimestamp(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

function youtubeDescriptor(u: URL): string | null {
  const host = bareHost(u);
  const isShort = host === 'youtu.be';
  if (!isShort && host !== 'youtube.com' && !host.endsWith('.youtube.com')) {
    return null;
  }
  if (u.pathname.startsWith('/shorts/')) return 'Shorts view';
  if (u.pathname.startsWith('/live/')) return 'Live view';
  if (u.pathname.startsWith('/embed/')) return 'Embed view';
  if (isShort || u.pathname === '/watch') {
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    if (t !== null) {
      const seconds = parseTimestamp(t);
      if (seconds !== null && seconds > 0) {
        return `Starts at ${formatTimestamp(seconds)}`;
      }
    }
    if (u.searchParams.has('list')) return 'Playlist view';
  }
  return null;
}

function githubDescriptor(u: URL): string | null {
  if (bareHost(u) !== 'github.com') return null;
  const frag = u.hash.replace(/^#/, '');
  if (/^L\d/.test(frag)) return 'Code line link';
  return null;
}

/** A site-specific descriptor for one URL, or null when no known
 * pattern applies (the group-level fallback takes over). */
export function viewDescriptor(url: string): string | null {
  const u = parseUrl(url);
  if (!u) return null;
  const host = bareHost(u);
  if (host === 'docs.google.com') return googleWorkspaceDescriptor(u);
  return (
    figmaDescriptor(u) ?? youtubeDescriptor(u) ?? githubDescriptor(u)
  );
}

/** Generic fallback, decided by comparing the member against the
 * rest of its group: what is the first thing that makes it differ? */
function genericDescriptor(
  u: URL | null,
  group: readonly (URL | null)[],
): string {
  if (!u) return 'Another view';
  const others = group.filter((o): o is URL => o !== null && o !== u);
  if (u.hash !== '' && others.some((o) => o.hash !== u.hash)) {
    return 'Linked section';
  }
  if (others.some((o) => o.search !== u.search)) {
    return 'Different page options';
  }
  if (others.some((o) => o.pathname !== u.pathname)) {
    return 'Different page view';
  }
  return 'Another view';
}

/**
 * One short, unique descriptor per member of a group, in input
 * order. Site-specific patterns win; members with no pattern fall
 * back to a within-group comparison. When several members still land
 * on the same text, later occurrences get an ordinal suffix
 * (" · View 2", " · View 3", …) so every row in a group reads
 * differently.
 */
export function describeMembers(urls: readonly string[]): string[] {
  const parsed = urls.map(parseUrl);
  const base = urls.map(
    (url, i) => viewDescriptor(url) ?? genericDescriptor(parsed[i], parsed),
  );
  const seen = new Map<string, number>();
  return base.map((descriptor) => {
    const occurrence = (seen.get(descriptor) ?? 0) + 1;
    seen.set(descriptor, occurrence);
    return occurrence === 1 ? descriptor : `${descriptor} · View ${occurrence}`;
  });
}

// -------------------------------------------------------------------
// Recency labels + similar-set keep choice (M1.2)
// -------------------------------------------------------------------

/** "3:42 PM" today, "Oct 7, 3:42 PM" on other days (year added when
 * it differs). */
function formatWhen(ts: number, now: Date): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
  return `${date}, ${time}`;
}

/** The recency line for a member row: "Last used {time}" from the
 * tab's lastAccessed, falling back to "Opened {time}" from when the
 * engine first saw it, and to "" when neither is known. */
export function lastUsedLabel(
  tab: { lastAccessed: number | null; firstSeenAt: number | null },
  now: Date = new Date(),
): string {
  if (tab.lastAccessed) return `Last used ${formatWhen(tab.lastAccessed, now)}`;
  if (tab.firstSeenAt) return `Opened ${formatWhen(tab.firstSeenAt, now)}`;
  return '';
}

export interface KeepCandidate {
  id: number;
  active: boolean;
  lastAccessed: number | null;
}

/**
 * Default "view to keep" for a similar-document group: the active
 * tab when it is a member, otherwise the most recently accessed
 * member. `members` must be in the set's newest-first order — ties
 * (and all-unknown recency) resolve to the earliest in that order.
 */
export function pickDefaultKeepTabId(
  members: readonly KeepCandidate[],
): number | null {
  if (members.length === 0) return null;
  const active = members.find((m) => m.active);
  if (active) return active.id;
  let best = members[0];
  for (const m of members) {
    if ((m.lastAccessed ?? -1) > (best.lastAccessed ?? -1)) best = m;
  }
  return best.id;
}
