import { describe, expect, it } from 'vitest';
import {
  DurationRing,
  formatBytes,
  formatMs,
  summarizeDurations,
  type DiagnosticsView,
} from '../src/lib/diagnostics';
import { diagnosticsLines } from '../src/lib/panel-model';

describe('summarizeDurations', () => {
  it('is all-null for no samples', () => {
    expect(summarizeDurations([])).toEqual({
      count: 0,
      medianMs: null,
      p95Ms: null,
      lastMs: null,
    });
  });

  it('computes median, p95, and last over insertion order', () => {
    const stats = summarizeDurations([10, 1, 4, 2, 3]);
    expect(stats.count).toBe(5);
    expect(stats.medianMs).toBe(3);
    expect(stats.p95Ms).toBe(10);
    expect(stats.lastMs).toBe(3);
  });

  it('averages the middle pair for even counts', () => {
    expect(summarizeDurations([1, 2, 3, 4]).medianMs).toBe(2.5);
  });
});

describe('DurationRing', () => {
  it('never grows past its cap, keeping the newest samples', () => {
    const ring = new DurationRing(5);
    for (let i = 0; i < 50; i++) ring.push(i);
    expect(ring.values).toEqual([45, 46, 47, 48, 49]);
    expect(ring.stats().count).toBe(5);
    expect(ring.stats().lastMs).toBe(49);
  });
});

describe('formatters', () => {
  it('formats durations at display precision', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(0.042)).toBe('0.04 ms');
    expect(formatMs(42.25)).toBe('42.3 ms');
    expect(formatMs(123.6)).toBe('124 ms');
  });

  it('formats byte counts', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });
});

function view(overrides: Partial<DiagnosticsView> = {}): DiagnosticsView {
  return {
    workerStartedAt: 1_000,
    rebuildMs: 12.5,
    coreReindexMs: 9.1,
    indexSize: 34,
    trackedTabs: 40,
    dedupeCheck: { count: 120, medianMs: 0.42, p95Ms: 1.85, lastMs: 0.5 },
    swaps: {
      count: 3,
      coldCount: 1,
      warmCount: 2,
      medianMs: 41,
      p95Ms: 88,
      lastMs: 37,
    },
    autoCloseCount: 3,
    storageBytes: 182_000,
    heapUsedMb: 9.4,
    ...overrides,
  };
}

describe('diagnosticsLines', () => {
  it('renders plain-language overhead lines from a measured view', () => {
    const lines = diagnosticsLines(view());
    expect(lines[0]).toContain('Duplicate check: 0.42 ms typical');
    expect(lines[0]).toContain('1.85 ms at worst');
    expect(lines[1]).toContain('Last duplicate swap: 37.0 ms');
    expect(lines[2]).toContain('Index rebuild at startup: 12.5 ms');
    expect(lines[2]).toContain('for 40 tabs');
    expect(lines[3]).toContain('34 pages tracked');
    expect(lines[3]).toContain('177.7 KB');
  });

  it('handles a fresh worker with no samples yet', () => {
    const lines = diagnosticsLines(
      view({
        dedupeCheck: { count: 0, medianMs: null, p95Ms: null, lastMs: null },
        swaps: {
          count: 0,
          coldCount: 0,
          warmCount: 0,
          medianMs: null,
          p95Ms: null,
          lastMs: null,
        },
        rebuildMs: null,
      }),
    );
    expect(lines[0]).toContain('no checks measured yet');
    expect(lines).toHaveLength(2);
  });
});
