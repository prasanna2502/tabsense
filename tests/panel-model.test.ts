import { describe, expect, it } from 'vitest';
import {
  describeMembers,
  faviconFallbackLetter,
  hostLabel,
  hostPathLabel,
  lastUsedLabel,
  pickDefaultKeepTabId,
  pluralize,
  viewDescriptor,
} from '../src/lib/panel-model';

describe('hostLabel', () => {
  it('extracts the host and drops a leading www.', () => {
    expect(hostLabel('https://www.example.com/some/page?x=1')).toBe(
      'example.com',
    );
    expect(hostLabel('https://docs.google.com/document/d/abc')).toBe(
      'docs.google.com',
    );
  });

  it('drops ports and credentials', () => {
    expect(hostLabel('https://user:pw@sub.example.com:8443/a')).toBe(
      'sub.example.com',
    );
  });

  it('handles empty and unparseable input without throwing', () => {
    expect(hostLabel('')).toBe('');
    expect(hostLabel('not a url')).toBe('not a url');
  });
});

describe('hostPathLabel', () => {
  it('joins host and path, dropping query and fragment', () => {
    expect(
      hostPathLabel('https://www.example.com/a/b/?q=1#frag'),
    ).toBe('example.com/a/b');
  });

  it('shows just the host for a root path', () => {
    expect(hostPathLabel('https://example.com/')).toBe('example.com');
    expect(hostPathLabel('https://example.com')).toBe('example.com');
  });
});

describe('pluralize', () => {
  it('singularizes at exactly 1', () => {
    expect(pluralize(1, 'tab')).toBe('1 tab');
    expect(pluralize(0, 'tab')).toBe('0 tabs');
    expect(pluralize(4, 'copy', 'copies')).toBe('4 copies');
  });
});

describe('faviconFallbackLetter', () => {
  it('prefers the title’s first alphanumeric character, uppercased', () => {
    expect(faviconFallbackLetter('quarterly report', 'https://x.com/')).toBe(
      'Q',
    );
    expect(faviconFallbackLetter('  — Draft', 'https://x.com/')).toBe('D');
  });

  it('falls back to the host, then to a bullet', () => {
    expect(faviconFallbackLetter('', 'https://news.example.com/')).toBe('N');
    expect(faviconFallbackLetter('', '')).toBe('•');
  });
});

describe('viewDescriptor — Google Workspace', () => {
  it('names the sheet tab from a fragment gid', () => {
    expect(
      viewDescriptor(
        'https://docs.google.com/spreadsheets/d/SHEETID/edit#gid=123456',
      ),
    ).toBe('Sheet tab 123456');
  });

  it('names the sheet tab from a query gid', () => {
    expect(
      viewDescriptor(
        'https://docs.google.com/spreadsheets/d/SHEETID/edit?gid=42#range=A1',
      ),
    ).toBe('Sheet tab 42');
  });

  it('names Docs modes from the path segment after the ID', () => {
    const base = 'https://docs.google.com/document/d/DOCID';
    expect(viewDescriptor(`${base}/edit`)).toBe('Edit view');
    expect(viewDescriptor(`${base}/view`)).toBe('Read view');
    expect(viewDescriptor(`${base}/preview`)).toBe('Preview');
    expect(viewDescriptor(`${base}/comment`)).toBe('Comment view');
  });

  it('appends a heading fragment as a linked section', () => {
    expect(
      viewDescriptor(
        'https://docs.google.com/document/d/DOCID/edit#heading=h.abc123',
      ),
    ).toBe('Edit view · linked section');
    expect(
      viewDescriptor('https://docs.google.com/document/d/DOCID#heading=h.x'),
    ).toBe('Linked section');
  });

  it('treats other Docs fragments as a linked position', () => {
    expect(
      viewDescriptor(
        'https://docs.google.com/document/d/DOCID/view#bookmark=id.kix.1',
      ),
    ).toBe('Read view · linked position');
  });

  it('names a linked slide on Slides, with the mode', () => {
    expect(
      viewDescriptor(
        'https://docs.google.com/presentation/d/DECKID/edit#slide=id.g123',
      ),
    ).toBe('Edit view · Linked slide');
    expect(
      viewDescriptor(
        'https://docs.google.com/presentation/d/DECKID/present#slide=id.g1',
      ),
    ).toBe('Linked slide');
  });
});

describe('viewDescriptor — Figma, YouTube, GitHub', () => {
  it('names a Figma selected element and a page view', () => {
    expect(
      viewDescriptor(
        'https://www.figma.com/design/FILEKEY/Name?node-id=12-34&t=xyz',
      ),
    ).toBe('Selected element');
    expect(
      viewDescriptor('https://www.figma.com/design/FILEKEY/Name?page-id=0%3A1'),
    ).toBe('Page view');
  });

  it('formats a YouTube start time as m:ss and h:mm:ss', () => {
    expect(viewDescriptor('https://www.youtube.com/watch?v=VID&t=90')).toBe(
      'Starts at 1:30',
    );
    expect(viewDescriptor('https://www.youtube.com/watch?v=VID&t=1m30s')).toBe(
      'Starts at 1:30',
    );
    expect(
      viewDescriptor('https://www.youtube.com/watch?v=VID&t=3661'),
    ).toBe('Starts at 1:01:01');
    expect(viewDescriptor('https://youtu.be/VID?t=45')).toBe('Starts at 0:45');
  });

  it('names playlist, shorts, live, and embed views', () => {
    expect(
      viewDescriptor('https://www.youtube.com/watch?v=VID&list=PL123'),
    ).toBe('Playlist view');
    expect(viewDescriptor('https://www.youtube.com/shorts/VID')).toBe(
      'Shorts view',
    );
    expect(viewDescriptor('https://www.youtube.com/live/VID')).toBe(
      'Live view',
    );
    expect(viewDescriptor('https://www.youtube.com/embed/VID')).toBe(
      'Embed view',
    );
  });

  it('names a GitHub line anchor', () => {
    expect(
      viewDescriptor('https://github.com/o/r/blob/main/src/a.ts#L42'),
    ).toBe('Code line link');
    expect(
      viewDescriptor('https://github.com/o/r/blob/main/src/a.ts#L42-L50'),
    ).toBe('Code line link');
    expect(viewDescriptor('https://github.com/o/r/blob/main/src/a.ts')).toBe(
      null,
    );
  });
});

describe('describeMembers', () => {
  it('falls back generically within the group: fragment, query, path', () => {
    expect(
      describeMembers([
        'https://example.com/report',
        'https://example.com/report#details',
      ]),
    ).toEqual(['Another view', 'Linked section']);
    expect(
      describeMembers([
        'https://example.com/list?sort=asc',
        'https://example.com/list?sort=desc',
      ]),
    ).toEqual(['Different page options', 'Different page options · View 2']);
    expect(
      describeMembers([
        'https://example.com/a/item',
        'https://example.com/b/item',
      ]),
    ).toEqual(['Different page view', 'Different page view · View 2']);
  });

  it('makes repeated descriptors unique with ordinals', () => {
    const base = 'https://docs.google.com/document/d/DOCID/edit';
    expect(describeMembers([base, base, base])).toEqual([
      'Edit view',
      'Edit view · View 2',
      'Edit view · View 3',
    ]);
  });

  it('never leaks a document ID into a descriptor', () => {
    const docId = '1tpVYi9o9MZAEbXrgSECRETID0001';
    const outputs = describeMembers([
      `https://docs.google.com/document/d/${docId}/edit#heading=h.abc`,
      `https://docs.google.com/document/d/${docId}/view`,
      `https://docs.google.com/spreadsheets/d/${docId}/edit#gid=7`,
    ]);
    for (const out of outputs) {
      expect(out).not.toContain(docId);
      expect(out).not.toContain('docs.google.com');
    }
  });

  it('handles unparseable URLs without throwing', () => {
    expect(describeMembers(['not a url', 'also not a url'])).toEqual([
      'Another view',
      'Another view · View 2',
    ]);
  });
});

describe('lastUsedLabel', () => {
  const now = new Date('2026-10-08T15:00:00');
  it('shows just the time for today, date + time otherwise', () => {
    expect(
      lastUsedLabel(
        { lastAccessed: new Date('2026-10-08T09:30:00').getTime(), firstSeenAt: null },
        now,
      ),
    ).toMatch(/^Last used \d{1,2}:\d{2}\s[AP]M$/);
    expect(
      lastUsedLabel(
        { lastAccessed: new Date('2026-10-07T09:30:00').getTime(), firstSeenAt: null },
        now,
      ),
    ).toMatch(/^Last used Oct 7, \d{1,2}:\d{2}\s[AP]M$/);
  });

  it('falls back to firstSeenAt, then to empty', () => {
    expect(
      lastUsedLabel(
        { lastAccessed: null, firstSeenAt: new Date('2026-10-08T08:00:00').getTime() },
        now,
      ),
    ).toMatch(/^Opened \d{1,2}:\d{2}\s[AP]M$/);
    expect(lastUsedLabel({ lastAccessed: null, firstSeenAt: null }, now)).toBe(
      '',
    );
  });
});

describe('pickDefaultKeepTabId', () => {
  it('prefers the active member', () => {
    expect(
      pickDefaultKeepTabId([
        { id: 1, active: false, lastAccessed: 900 },
        { id: 2, active: true, lastAccessed: 100 },
      ]),
    ).toBe(2);
  });

  it('otherwise picks the most recently accessed member', () => {
    expect(
      pickDefaultKeepTabId([
        { id: 1, active: false, lastAccessed: 100 },
        { id: 2, active: false, lastAccessed: 900 },
        { id: 3, active: false, lastAccessed: 500 },
      ]),
    ).toBe(2);
  });

  it('falls back to the given (newest-first) order on ties/unknowns', () => {
    expect(
      pickDefaultKeepTabId([
        { id: 5, active: false, lastAccessed: null },
        { id: 6, active: false, lastAccessed: null },
      ]),
    ).toBe(5);
    expect(pickDefaultKeepTabId([])).toBe(null);
  });
});
