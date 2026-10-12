/**
 * Generated URL corpus for canonicalizer parity / property tests.
 *
 * The generator builds URL strings across every canonicalizer
 * rule family — generic pages, Google Workspace / Drive, Notion,
 * GitHub, Figma, YouTube — with the messy variations real tabs
 * carry: tracking params in mixed case, duplicated params, odd
 * percent-encoding, Unicode hosts and values, ports, userinfo,
 * fragments, path case, trailing slashes. Everything is driven by
 * the seeded PRNG in ./prng, so the corpus is a fixed fixture.
 */

import { rng } from './prng';

const DOC_ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const HEX = '0123456789abcdef';
const TRACKING = [
  'utm_source',
  'UTM_MEDIUM',
  'Utm_Campaign',
  'fbclid',
  'gclid',
  'mc_cid',
  'ref_src',
  'igshid',
  'si',
  'spm',
  '_hsenc',
];
const BENIGN_PARAMS: Array<[string, string]> = [
  ['q', 'sourdough'],
  ['q', 'cats & dogs'],
  ['page', '2'],
  ['sort', 'new'],
  ['lang', 'en'],
  ['theme', 'dark'],
  ['filter', 'a/b'],
  ['note', 'café ☕'],
  ['emoji', '🚀launch'],
  ['empty', ''],
  ['flag', ''],
];

function docId(r: ReturnType<typeof rng>): string {
  return r.chars(DOC_ID_ALPHABET, r.range(18, 44));
}

function pairs(r: ReturnType<typeof rng>): string {
  const chosen = r.subset([...TRACKING, ...BENIGN_PARAMS.map(([n]) => n)]);
  const parts: string[] = [];
  for (const name of chosen) {
    const benign = BENIGN_PARAMS.find(([n]) => n === name);
    const value = benign ? benign[1] : r.chars('abcXYZ019', r.range(3, 10));
    parts.push(
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    );
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function genericUrl(r: ReturnType<typeof rng>): string {
  const hosts = [
    'example.com',
    'www.example.com',
    'm.example.com',
    'mobile.example.com',
    'amp.example.com',
    'blog.testsite.org',
    'EXAMPLE.com',
    'sub.deep.example.co.uk',
    'xn--fa-hia.de',
    'faß.de',
    '127.0.0.1',
    '[::1]',
  ];
  const host = r.pick(hosts);
  const port = r.pick(['', '', '', ':8080', ':443', ':80', ':0', ':65535']);
  const scheme = r.pick(['https', 'https', 'http', 'HTTPS']);
  const auth = r.pick(['', '', 'user@', 'user:secret@']);
  const path = r.pick([
    '/',
    '',
    '/article/2026/10/post',
    '/Article/Case-Sensitive',
    '/a/b/c/',
    '/caf%C3%A9/menu',
    '/search/results',
    '/amp',
    '/story/amp',
    '/a//double//slash',
    '/trailing.',
    '/under_score-dash~tilde',
  ]);
  const frag = r.pick(['', '', '#section-2', '#', '#a=1&b=2']);
  return `${scheme}://${auth}${host}${port}${path}${pairs(r)}${frag}`;
}

function googleUrl(r: ReturnType<typeof rng>): string {
  const app = r.pick(['document', 'spreadsheets', 'presentation']);
  const id = docId(r);
  const shapes = [
    `https://docs.google.com/${app}/d/${id}/edit`,
    `https://docs.google.com/${app}/d/${id}/view`,
    `https://docs.google.com/${app}/d/${id}/preview`,
    `https://docs.google.com/${app}/u/0/d/${id}/edit`,
    `https://docs.google.com/${app}/d/${id}/edit?usp=sharing`,
    `https://docs.google.com/${app}/d/${id}/mobilebasic`,
    `https://docs.google.com/${app}/d/${id}/export?format=pdf`,
    `https://docs.google.com/${app}/d/${id}/comment`,
    `https://www.docs.google.com/${app}/d/${id}/edit`,
  ];
  let url = r.pick(shapes);
  if (app === 'spreadsheets') {
    const gid = r.range(0, 2000000000);
    url += r.pick([
      `#gid=${gid}`,
      `#gid=${gid}&range=A1%3AB2`,
      `?gid=${gid}`,
      `#range=A1&gid=${gid}`,
      '',
    ]);
  } else {
    url += r.pick([
      '',
      '#heading=h.abc123',
      '#slide=id.p7',
      '#bookmark=id.xyz',
    ]);
  }
  return url;
}

function driveUrl(r: ReturnType<typeof rng>): string {
  const id = docId(r);
  return r.pick([
    `https://drive.google.com/file/d/${id}/view?usp=sharing`,
    `https://drive.google.com/file/d/${id}/preview`,
    `https://drive.google.com/open?id=${id}`,
    `https://drive.google.com/drive/folders/${id}`,
    `https://drive.google.com/file/d/${id}/view?usp=drivesdk&ouid=123`,
  ]);
}

function notionUrl(r: ReturnType<typeof rng>): string {
  const hexId = r.chars(HEX, 32);
  const dashed = `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20)}`;
  const host = r.pick([
    'www.notion.so',
    'notion.so',
    'acme.notion.so',
    'acme.notion.site',
    'www.notion.site',
  ]);
  const slug = r.pick([
    `Project-Plan-${hexId}`,
    hexId,
    `Meeting-Notes-${dashed}`,
    `仕様書-${hexId}`,
    `🚀-Launch-${hexId}`,
    hexId.toUpperCase(),
    'plain-title-without-id',
    `Almost-${hexId.slice(0, 31)}`,
  ]);
  return `https://${host}/${slug}${r.pick(['', '?pvs=4', '#anchor', '?p=abc123'])}`;
}

function githubUrl(r: ReturnType<typeof rng>): string {
  const user = r.pick(['prasanna2502', 'octocat', 'Some-User']);
  const repo = r.pick(['tabsense', 'Hello-World', 'repo.with.dots']);
  return r.pick([
    `https://github.com/${user}/${repo}`,
    `https://github.com/${user}/${repo}.git`,
    `https://github.com/${user}/${repo}/issues/42`,
    `https://github.com/${user}/${repo}/pull/7?plain=1#diff-abc`,
    `https://github.com/${user}/${repo}/blob/main/src/lib.rs#L12-L20`,
    `https://github.com/${user}/${repo}?tab=readme-ov-file`,
    `https://github.com/${user}/${repo}/tree/main?plain=1&ts=4`,
  ]);
}

function figmaUrl(r: ReturnType<typeof rng>): string {
  const key = r.chars(DOC_ID_ALPHABET, 22);
  const mode = r.pick(['design', 'file', 'proto', 'board', 'slides']);
  const node = `${r.range(1, 999)}-${r.range(1, 999)}`;
  return r.pick([
    `https://www.figma.com/${mode}/${key}/My-File?node-id=${node}&t=xyz`,
    `https://www.figma.com/${mode}/${key}?page-id=0%3A1&node-id=${node}`,
    `https://figma.com/${mode}/${key}`,
  ]);
}

function youtubeUrl(r: ReturnType<typeof rng>): string {
  const vid = r.chars(DOC_ID_ALPHABET, 11);
  const list = r.chars(DOC_ID_ALPHABET, 18);
  const t = r.pick([
    '',
    '&t=90',
    '&t=1m30s',
    '&t=1h2m3s',
    '&t=090',
    '&t=45s',
    '&start=120',
    '&t=2m',
  ]);
  return r.pick([
    `https://www.youtube.com/watch?v=${vid}${t}`,
    `https://www.youtube.com/watch?v=${vid}&list=PL${list}${t}`,
    `https://youtu.be/${vid}?si=shareid${t}`,
    `https://www.youtube.com/shorts/${vid}`,
    `https://www.youtube.com/live/${vid}`,
    `https://www.youtube.com/embed/${vid}`,
    `https://www.youtube.com/playlist?list=PL${list}`,
    `https://music.youtube.com/watch?v=${vid}`,
    `https://m.youtube.com/watch?v=${vid}`,
  ]);
}

/** The full generated corpus (deterministic, ~fixed content). */
export function generateUrlCorpus(count = 1200, seed = 20261011): string[] {
  const r = rng(seed);
  const gens = [
    genericUrl,
    genericUrl,
    googleUrl,
    driveUrl,
    notionUrl,
    githubUrl,
    figmaUrl,
    youtubeUrl,
  ];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(r.pick(gens)(r));
  }
  return out;
}

/** Hand-aimed probes for the sharp edges: parser differentials,
 * encoding extremes, structural near-misses. */
export const EDGE_PROBES: string[] = [
  // Whitespace / identity handling
  '  https://example.com/padded  ',
  '\uFEFFhttps://example.com/bom-prefixed',
  ' https://example.com/nbsp-wrapped ',
  'not a url at all',
  'http://',
  'https://',
  '://missing-scheme',
  'http:example.com',
  'https:example.com/path',
  // Ports and auth
  'https://example.com:443/',
  'http://example.com:80/',
  'https://example.com:08080/',
  'https://example.com:0/',
  'https://user@example.com/',
  'https://user:pa:ss@example.com/',
  'https://:pass@example.com/',
  'https://user:@example.com/',
  // Hosts
  'https://EXAMPLE.COM/Case/Path',
  'https://www.www.example.com/',
  'https://faß.de/path',
  'https://💩.la/emoji-host',
  'https://example.com./trailing-dot-host',
  'https://127.0.0.1:8080/ipv4',
  'https://[2001:db8::1]/ipv6',
  'https://[::1]:8080/ipv6-port',
  // Paths and encoding
  'https://example.com',
  'https://example.com/',
  'https://example.com//',
  'https://example.com/a%2fb',
  'https://example.com/a%2FB',
  'https://example.com/a b',
  'https://example.com/café',
  'https://example.com/%zz%invalid',
  'https://example.com/a/../b',
  'https://example.com/./a',
  // Query torture
  'https://example.com/?a=1&a=2&a=10',
  'https://example.com/?b=2&a=1',
  'https://example.com/?a',
  'https://example.com/?=value',
  'https://example.com/?',
  'https://example.com/?a=%',
  'https://example.com/?a=1&&b=2',
  'https://example.com/?utm=1&utm_=2&utm_x=3&UTM_SOURCE=x',
  'https://example.com/?q=a+b',
  'https://example.com/?q=a%20b',
  'https://example.com/?x=%FF%FE',
  // Google shapes near-misses
  'https://docs.google.com/document/d/SHORT/edit',
  'https://docs.google.com/document/d//edit',
  'https://docs.google.com/document/d/ABC123/edit/extra/deep',
  'https://docs.google.com/forms/d/ABC123/viewform',
  'https://docs.google.com/spreadsheets/d/ABC123/edit#gid=',
  'https://docs.google.com/spreadsheets/d/ABC123/edit?gid=',
  'https://docs.google.com/spreadsheets/d/ABC123/edit#gid=0&gid=9',
  'https://docs.google.com/spreadsheets/d/ABC123/edit?gid=7#gid=3',
  'https://docs.google.com/document/d/ABC123/edit#heading=',
  'https://docs.google.com/document/u/2/d/ABC123/edit#heading=h.1',
  // Drive near-misses
  'https://drive.google.com/file/d//view',
  'https://drive.google.com/open?id=',
  'https://drive.google.com/open/?id=ABC123',
  'https://drive.google.com/file/d/ABC123',
  // Notion near-misses
  'https://www.notion.so/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
  'https://www.notion.so/x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
  'https://www.notion.so/-1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
  'https://www.notion.so/workspace/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d',
  'https://notion.so.evil.com/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d',
  // GitHub near-misses
  'https://github.com/user/repo.git/',
  'https://github.com/user/.git',
  'https://github.com/user/repo#',
  'https://github.com/user/repo?plain=1&ts=2&utm_source=x',
  'https://www.github.com/user/repo',
  // Figma near-misses
  'https://www.figma.com/design//NoKey',
  'https://www.figma.com/community/file/ABC123',
  'https://www.figma.com/design/KEY123?node-id=1-2&node-id=3-4',
  // YouTube near-misses
  'https://www.youtube.com/watch?v=',
  'https://www.youtube.com/watch',
  'https://youtu.be/',
  'https://youtu.be/VID123/extra',
  'https://www.youtube.com/shorts/',
  'https://www.youtube.com/watch?v=VID&t=0',
  'https://www.youtube.com/watch?v=VID&t=0s',
  'https://www.youtube.com/watch?v=VID&t=00090',
  'https://www.youtube.com/watch?v=VID&list=',
  'https://www.youtube.com/watch?v=VID&t=1x',
  'https://www.youtube.com/watch?v=VID&t=h30',
  'https://www.youtube.com/watch?v=VID&t=1h30',
];
