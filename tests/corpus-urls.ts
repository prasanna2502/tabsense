/**
 * Deterministic benchmark corpus for the M3 unit-level perf suite.
 *
 * `generateCorpus()` returns exactly 10,000 real-world-shaped URLs:
 * Google Docs / Sheets / Slides + Drive, Notion, GitHub (repos, blob
 * files with line anchors, issues / PRs), Figma, YouTube (watch,
 * shorts, youtu.be, `t=` params), news / blog articles carrying
 * utm_* and other tracking params, search URLs with `q=`, and
 * generic sites in www. / m. / amp variants, with sorted and
 * unsorted query params and fragments.
 *
 * Duplicate design: 8,200 of the URLs are distinct base documents;
 * the remaining 1,800 are canonical-neutral variants of bases (a
 * tracking param added, query pairs reordered, a Docs gid moved
 * between query and fragment, a Drive /file/ link rewritten as
 * /open?id=, a YouTube watch link rewritten as youtu.be, …). Every
 * variant canonicalizes to the SAME exactKey as its base, so the
 * in-order duplicate rate is exactly 1,800 / 10,000 = 18% — inside
 * the intended 15–25% band — regardless of the final shuffle.
 *
 * Determinism: a single mulberry32 PRNG with a fixed seed drives
 * every choice, in a fixed order. No Math.random, no Date, no
 * environment input: two calls always produce identical arrays.
 */

import { canonicalKeysFallback } from '../src/lib/canonicalize';

const SEED = 20261010;
export const CORPUS_SIZE = 10_000;
const DUPLICATE_VARIANTS = 1_800;

// -------------------------------------------------------------------
// Seeded PRNG (mulberry32) + small builders
// -------------------------------------------------------------------

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

const ALPHA =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const YT_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function chars(rng: Rng, alphabet: string, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

const WORDS = [
  'quarterly', 'budget', 'travel', 'recipe', 'design', 'research',
  'marketing', 'product', 'engineering', 'hiring', 'wedding', 'garden',
  'fitness', 'finance', 'music', 'photo', 'cooking', 'science',
  'history', 'language', 'climate', 'transit', 'housing', 'school',
] as const;

function words(rng: Rng, n: number, joiner = '-'): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pick(rng, WORDS));
  return out.join(joiner);
}

/** Doc/file IDs: random body + the sequence number, so uniqueness
 * never depends on the PRNG not colliding. */
function docId(rng: Rng, n: number): string {
  return `${chars(rng, ALPHA, 10)}${n.toString(36)}${chars(rng, ALPHA, 10)}`;
}

// -------------------------------------------------------------------
// Base-document builders (one record per distinct canonical document)
// -------------------------------------------------------------------

type Category =
  | 'gdoc-document'
  | 'gdoc-sheets'
  | 'gdoc-slides'
  | 'gdrive'
  | 'notion'
  | 'github'
  | 'figma'
  | 'youtube-watch'
  | 'youtube-shorts'
  | 'youtube-shortlink'
  | 'news'
  | 'search'
  | 'generic';

interface CorpusRecord {
  url: string;
  cat: Category;
}

function ytVideoId(rng: Rng, n: number): string {
  // 11 chars; the last three encode n in base-64 → unique per n.
  const tail =
    YT_ALPHABET[n % 64] +
    YT_ALPHABET[Math.floor(n / 64) % 64] +
    YT_ALPHABET[Math.floor(n / 4096) % 64];
  return chars(rng, YT_ALPHABET, 8) + tail;
}

function buildBases(rng: Rng): CorpusRecord[] {
  const bases: CorpusRecord[] = [];
  const push = (url: string, cat: Category) => bases.push({ url, cat });

  // Google Docs — documents (500)
  for (let i = 0; i < 500; i++) {
    let url = `https://docs.google.com/document/d/${docId(rng, i)}/edit`;
    if (i % 3 === 0) url += '?usp=sharing';
    if (i % 5 === 0) url += `#heading=h.${chars(rng, 'abcdefghijklmnopqrstuvwxyz0123456789', 8)}`;
    push(url, 'gdoc-document');
  }
  // Google Sheets (400) — gid in the fragment, or in the query
  for (let i = 0; i < 400; i++) {
    const id = docId(rng, 10_000 + i);
    const gid = i % 8;
    push(
      i % 4 === 0
        ? `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${gid}`
        : `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`,
      'gdoc-sheets',
    );
  }
  // Google Slides (300)
  for (let i = 0; i < 300; i++) {
    let url = `https://docs.google.com/presentation/d/${docId(rng, 20_000 + i)}/edit`;
    if (i % 3 === 0) url += `#slide=id.p${i + 1}`;
    if (i % 4 === 0) url += (url.includes('#') ? '' : '?usp=sharing');
    push(url, 'gdoc-slides');
  }
  // Google Drive files (300) — /file/d/ and /open?id= spellings
  for (let i = 0; i < 300; i++) {
    const id = docId(rng, 30_000 + i);
    push(
      i % 2 === 0
        ? `https://drive.google.com/file/d/${id}/view?usp=sharing`
        : `https://drive.google.com/open?id=${id}`,
      'gdrive',
    );
  }
  // Notion (900) — slug + 32-hex page ID (counter in the tail)
  const notionHosts = ['www.notion.so', 'notion.so', 'acme.notion.site', 'team-wiki.notion.site'];
  for (let i = 0; i < 900; i++) {
    const hexId = chars(rng, HEX, 24) + i.toString(16).padStart(8, '0');
    const slug = `${words(rng, 2, '-')}-${words(rng, 1, '')}`;
    let url = `https://${notionHosts[i % notionHosts.length]}/${slug}-${hexId}`;
    if (i % 4 === 0) url += '?pvs=4';
    push(url, 'notion');
  }
  // GitHub (1,400) — repo roots, blob files with line anchors, issues/PRs
  const owners = ['octocat', 'hubot', 'monalisa', 'defunkt', 'mojombo', 'pjhyett', 'kamilogorek', 'gaearon', 'yyx990803', 'sindresorhus'];
  const repos: string[] = [];
  for (let j = 0; j < 400; j++) {
    repos.push(`${owners[j % owners.length]}/${pick(rng, WORDS)}-${pick(rng, WORDS)}-${j}`);
  }
  for (let i = 0; i < 400; i++) {
    push(`https://github.com/${repos[i % repos.length]}`, 'github');
  }
  for (let i = 0; i < 700; i++) {
    const repo = repos[i % repos.length];
    const line = int(rng, 1, 900);
    const anchor = i % 3 === 0 ? `#L${line}-L${line + int(rng, 1, 40)}` : `#L${line}`;
    push(
      `https://github.com/${repo}/blob/main/src/${pick(rng, WORDS)}/file-${i}.ts${anchor}`,
      'github',
    );
  }
  for (let i = 0; i < 300; i++) {
    const repo = repos[(i * 7) % repos.length];
    push(
      `https://github.com/${repo}/${i % 2 === 0 ? 'issues' : 'pull'}/${1000 + i}`,
      'github',
    );
  }
  // Figma (600)
  const figmaModes = ['design', 'file', 'proto', 'board', 'slides'];
  for (let i = 0; i < 600; i++) {
    const key = docId(rng, 40_000 + i);
    push(
      `https://www.figma.com/${figmaModes[i % figmaModes.length]}/${key}/${words(rng, 2, '-')}-design?node-id=${int(rng, 1, 400)}-${int(rng, 1, 4000)}`,
      'figma',
    );
  }
  // YouTube watch (550) — some with t= (all three spellings) / list=
  for (let i = 0; i < 550; i++) {
    const vid = ytVideoId(rng, i);
    let url = `https://www.youtube.com/watch?v=${vid}`;
    if (i % 4 === 0) {
      const secs = int(rng, 30, 3600);
      const t =
        i % 12 === 0
          ? `${Math.floor(secs / 60)}m${secs % 60}s`
          : i % 8 === 0
            ? `${secs}s`
            : `${secs}`;
      url += `&t=${t}`;
    }
    if (i % 7 === 0) url += `&list=PL${chars(rng, ALPHA, 16)}`;
    push(url, 'youtube-watch');
  }
  // YouTube shorts (250)
  for (let i = 0; i < 250; i++) {
    const vid = ytVideoId(rng, 10_000 + i);
    let url = `https://www.youtube.com/shorts/${vid}`;
    if (i % 3 === 0) url += '?feature=share';
    push(url, 'youtube-shorts');
  }
  // YouTube short links (100)
  for (let i = 0; i < 100; i++) {
    const vid = ytVideoId(rng, 20_000 + i);
    let url = `https://youtu.be/${vid}`;
    if (i % 2 === 0) url += `?si=${chars(rng, ALPHA, 10)}`;
    push(url, 'youtube-shortlink');
  }
  // News / blog articles (1,200) — tracking params on many
  const newsHosts = [
    'www.nytimes.com', 'www.theverge.com', 'www.bbc.com',
    'arstechnica.com', 'www.wired.com', 'medium.com',
    'blog.google', 'www.theguardian.com',
  ];
  for (let i = 0; i < 1200; i++) {
    const host = newsHosts[i % newsHosts.length];
    let url = `https://${host}/2026/${String((i % 9) + 1).padStart(2, '0')}/${words(rng, 3)}-${i}`;
    if (i % 3 === 0) url += `?utm_source=${pick(rng, ['twitter', 'newsletter', 'rss'])}&utm_medium=${pick(rng, ['social', 'email', 'cpc'])}`;
    else if (i % 5 === 0) url += `?fbclid=IwAR${chars(rng, ALPHA, 12)}`;
    else if (i % 7 === 0) url += `?output=1&ref=homepage`;
    push(url, 'news');
  }
  // Search URLs (700) — unique q= by combinatorial enumeration
  const subjects = ['typescript', 'rust', 'chrome extension', 'sourdough', 'espresso', 'trail running', 'home renovation', 'index funds', 'japanese maple', 'piano practice', 'visa renewal', 'standing desk', 'meal prep', 'bike fitting', 'sleep training', 'photo backup'];
  const modifiers = ['best', 'beginner', 'advanced', 'cheap', 'review', 'tutorial', 'checklist', 'comparison', 'troubleshooting', 'setup', 'ideas', 'guide', 'tips', 'examples'];
  const contexts = ['2026', 'for families', 'at home', 'step by step', 'near seattle', 'explained', 'pros and cons', 'with examples'];
  for (let i = 0; i < 700; i++) {
    const q = `${subjects[i % subjects.length]} ${modifiers[Math.floor(i / subjects.length) % modifiers.length]} ${contexts[Math.floor(i / (subjects.length * modifiers.length)) % contexts.length]}`;
    const encoded = encodeURIComponent(q).replace(/%20/g, '+');
    let url: string;
    if (i % 3 === 0) url = `https://www.google.com/search?q=${encoded}`;
    else if (i % 3 === 1) url = `https://www.bing.com/search?q=${encoded}&form=QBLH`;
    else url = `https://duckduckgo.com/?q=${encoded}`;
    if (i % 4 === 0) url += '&utm_medium=organic';
    push(url, 'search');
  }
  // Generic sites (1,000) — product / Q&A / wiki / www·m.·amp variants
  for (let i = 0; i < 250; i++) {
    let url = `https://www.amazon.com/${words(rng, 2)}/dp/B0${(7_000_000 + i).toString()}`;
    if (i % 4 === 0) url += '?th=1&psc=1';
    push(url, 'generic');
  }
  for (let i = 0; i < 250; i++) {
    push(
      `https://stackoverflow.com/questions/${60_000_000 + i}/${words(rng, 4)}`,
      'generic',
    );
  }
  const wikiNouns = ['overview', 'history', 'guide', 'basics', 'methods', 'examples', 'timeline', 'reference'];
  for (let i = 0; i < 250; i++) {
    // 16 subjects × 8 contexts × 8 nouns = 1,024 unique titles.
    const title = `${subjects[i % subjects.length]} ${contexts[Math.floor(i / subjects.length) % contexts.length]} ${wikiNouns[Math.floor(i / (subjects.length * contexts.length)) % wikiNouns.length]}`
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/ /g, '_');
    push(`https://en.wikipedia.org/wiki/${title}`, 'generic');
  }
  for (let i = 0; i < 250; i++) {
    const prefix = ['', 'www.', 'm.', 'www.'][i % 4];
    const amp = i % 5 === 0 ? '/amp' : '';
    let url = `https://${prefix}dailytech.example/articles/${words(rng, 3)}-${i}${amp}`;
    if (i % 6 === 0) url += `?utm_campaign=${pick(rng, WORDS)}`;
    push(url, 'generic');
  }

  return bases;
}

// -------------------------------------------------------------------
// Canonical-neutral duplicate variants
// -------------------------------------------------------------------

/** Insert `extra` (a=1&b=2) into the query, ahead of any fragment. */
function withExtraQuery(url: string, extra: string): string {
  const hash = url.indexOf('#');
  const head = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : '';
  return head + (head.includes('?') ? '&' : '?') + extra + frag;
}

/** Reverse the query-pair order (canonicalization sorts pairs, so
 * this cannot change the exact key of a generic/GitHub URL). */
function reorderQuery(url: string): string {
  const hash = url.indexOf('#');
  const head = hash >= 0 ? url.slice(0, hash) : url;
  const frag = hash >= 0 ? url.slice(hash) : '';
  const q = head.indexOf('?');
  if (q < 0) return url;
  const pairs = head.slice(q + 1).split('&');
  if (pairs.length < 2) return url;
  return head.slice(0, q + 1) + [...pairs].reverse().join('&') + frag;
}

function trackingToken(rng: Rng, k: number): string {
  return k % 2 === 0
    ? `utm_source=bench${k}&utm_medium=dup`
    : `fbclid=Dup${k}${chars(rng, ALPHA, 8)}`;
}

/** h/m/s-or-digits timestamp → total seconds (mirrors the
 * canonicalizer's normalizeTimestamp for the shapes we generate). */
function timestampSeconds(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    return null;
  }
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function duplicateVariant(rec: CorpusRecord, rng: Rng, k: number): string {
  const { url, cat } = rec;
  let out = url;
  switch (cat) {
    case 'gdoc-document':
    case 'gdoc-slides':
      // Docs/Slides identity ignores the query entirely (gid aside,
      // and these have none) — any extra param is neutral.
      out = withExtraQuery(url, `utm_source=dup${k}`);
      break;
    case 'gdoc-sheets': {
      // Move the gid between fragment and query: same exact key.
      const gid = /gid=(\d+)/.exec(url)?.[1] ?? '0';
      const id = /\/d\/([^/]+)/.exec(url)?.[1] ?? '';
      out = url.includes('#gid=')
        ? `https://docs.google.com/spreadsheets/d/${id}/edit?gid=${gid}`
        : `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`;
      break;
    }
    case 'gdrive': {
      const fileId = /\/file\/d\/([^/]+)/.exec(url)?.[1];
      const openId = /[?&]id=([^&]+)/.exec(url)?.[1];
      out = fileId
        ? `https://drive.google.com/open?id=${fileId}`
        : `https://drive.google.com/file/d/${openId ?? ''}/view?usp=drivesdk`;
      break;
    }
    case 'notion': {
      // Same 32-hex page ID under a different slug (and no query):
      // Notion identity is the ID alone.
      const hexId = url.match(/[0-9a-f]{32}/)?.[0] ?? '';
      const host = new URL(url).hostname;
      out = `https://${host}/${words(rng, 3)}-${hexId}`;
      break;
    }
    case 'github': {
      const segs = new URL(url).pathname.split('/').filter(Boolean);
      if (segs.length === 2 && k % 3 === 0) out = `${url}.git`;
      else if (segs.length === 2 && k % 3 === 1) out = `${url}/`;
      else out = withExtraQuery(url, `utm_source=dup${k}`);
      break;
    }
    case 'figma':
      // Figma identity reads only node-id/page-id; extras are ignored.
      out = withExtraQuery(url, `utm_campaign=dup${k}`);
      break;
    case 'youtube-watch': {
      const parsed = new URL(url);
      const vid = parsed.searchParams.get('v') ?? '';
      const list = parsed.searchParams.get('list');
      const t = parsed.searchParams.get('t');
      const secs = t ? timestampSeconds(t) : null;
      if (k % 2 === 0 && !list && (t === null || secs !== null)) {
        // youtu.be spelling of the same watch key (timestamp
        // rewritten in plain seconds, which normalizes identically).
        out = `https://youtu.be/${vid}` + (secs !== null ? `?t=${secs}` : '');
      } else {
        // si= is dropped for YouTube hosts; pair order is irrelevant.
        const pairs = [...parsed.searchParams.entries()]
          .reverse()
          .map(([n, v]) => `${n}=${v}`)
          .join('&');
        out = `https://www.youtube.com/watch?si=dup${k}${pairs ? `&${pairs}` : ''}`;
      }
      break;
    }
    case 'youtube-shorts':
      out = withExtraQuery(url, `si=dup${k}${chars(rng, ALPHA, 6)}`);
      break;
    case 'youtube-shortlink': {
      const vid = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
      out = `https://www.youtube.com/watch?v=${vid}`;
      break;
    }
    case 'news':
    case 'search':
    case 'generic': {
      // Generic canonicalization strips trackers, drops fragments,
      // sorts pairs, and normalizes one trailing slash.
      if (k % 4 === 0) out = withExtraQuery(url, trackingToken(rng, k));
      else if (k % 4 === 1) out = reorderQuery(url);
      else if (k % 4 === 2) out = `${url}#section-${k}`;
      else {
        const bare = url.split('#')[0];
        out = !bare.includes('?') && !bare.endsWith('/')
          ? `${bare}/`
          : withExtraQuery(url, trackingToken(rng, k));
      }
      break;
    }
  }
  // A transform that happens to be a no-op for this shape falls back
  // to a tracker param (neutral for every category above except the
  // ones that already changed form) — never return the base itself.
  if (out === url) out = withExtraQuery(url, `utm_source=dup${k}`);
  return out;
}

// -------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------

/**
 * The 10,000-URL benchmark corpus: 8,200 base documents plus 1,800
 * canonical-neutral duplicate variants, deterministically shuffled.
 */
export function generateCorpus(): string[] {
  const rng = mulberry32(SEED);
  const bases = buildBases(rng);
  const urls = bases.map((b) => b.url);
  for (let k = 0; k < DUPLICATE_VARIANTS; k++) {
    const src = bases[Math.floor(rng() * bases.length)];
    urls.push(duplicateVariant(src, rng, k));
  }
  // Deterministic Fisher–Yates shuffle.
  for (let i = urls.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [urls[i], urls[j]] = [urls[j], urls[i]];
  }
  return urls;
}

export interface CorpusStats {
  total: number;
  uniqueExactKeys: number;
  /** URLs whose exact key was already produced by an earlier URL. */
  duplicateUrls: number;
  duplicateRate: number;
}

/** Corpus shape summary, computed with the real TS canonicalizer. */
export function corpusStats(urls: readonly string[]): CorpusStats {
  const seen = new Set<string>();
  let duplicateUrls = 0;
  for (const url of urls) {
    const { exactKey } = canonicalKeysFallback(url);
    if (seen.has(exactKey)) duplicateUrls++;
    else seen.add(exactKey);
  }
  return {
    total: urls.length,
    uniqueExactKeys: seen.size,
    duplicateUrls,
    duplicateRate: urls.length === 0 ? 0 : duplicateUrls / urls.length,
  };
}
