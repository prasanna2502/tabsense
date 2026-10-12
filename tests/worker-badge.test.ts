/**
 * Toolbar badge behavior at the worker level (test-hardening
 * commission, method 3). Separate file on purpose: the badge is
 * written through the ambient chrome APIs by whichever worker
 * refreshes last, and this suite boots several workers in one
 * process — so each test lets earlier workers' timers fully
 * expire (the grouping debounce is 1.5 s), then drives a fresh
 * snapshot through THIS worker via the panel's own message and
 * reads the badge it leaves behind.
 *
 * What is pinned here:
 *  - the count is EXTRA copies (sets of 2/2/3 restored tabs → 4),
 *  - pinned duplicates never count (excluded from the live
 *    index the badge derives from),
 *  - the text caps at '99+' while the title keeps the true
 *    count (120),
 *  - the D2 fix: the badge moves when tabs change after init,
 *    not only when the panel asks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalKeysFallback } from '../src/lib/canonicalize';
import { normalizeUrlFallback } from '../src/lib/normalize';
import { tsScorer } from '../src/lib/scorer';
import {
  fakeTab,
  makeFakeChrome,
  until,
  type FakeChromeEnv,
  type FakeTab,
} from './helpers/fake-chrome';

vi.mock('../src/wasm/load', () => ({
  getCoreState: () => 'ready',
  isCoreReady: () => true,
  ensureCoreReady: () => Promise.resolve(true),
  canonicalKeys: (url: string) => ({
    keys: canonicalKeysFallback(url),
    engine: 'fallback' as const,
  }),
  normalizeUrl: (url: string) => ({
    normalized: normalizeUrlFallback(url),
    engine: 'fallback' as const,
  }),
  getScorer: () => tsScorer,
}));

async function bootAndSettle(
  env: FakeChromeEnv,
  initialTabs: FakeTab[],
): Promise<void> {
  env.tabsData.push(...initialTabs);
  vi.stubGlobal('chrome', env.chrome);
  const startedAt = Date.now();
  const mod = await import('../entrypoints/background');
  (mod.default as { main: () => void }).main();
  const wantIds = initialTabs.map((t) => t.id).sort((a, b) => a - b);
  await until(() => {
    const snap = env.storedSnapshot() as
      | { updatedAt?: number; tabs?: Array<{ id: number }> }
      | undefined;
    if (!snap || typeof snap.updatedAt !== 'number') return false;
    if (snap.updatedAt < startedAt) return false;
    const ids = (snap.tabs ?? []).map((t) => t.id).sort((a, b) => a - b);
    return (
      ids.length === wantIds.length && ids.every((id, i) => id === wantIds[i])
    );
  }, 'init snapshot');
  // Let every earlier worker's timers expire, then have THIS
  // worker refresh through the panel's snapshot message — the
  // badge state it leaves is unambiguously its own.
  await new Promise((r) => setTimeout(r, 1800));
  await env.sendMessage({ type: 'tabs:get-snapshot' });
}

beforeEach(() => {
  vi.resetModules();
});

describe('toolbar badge', () => {
  it('counts extra copies across restored duplicate sets', async () => {
    const env = makeFakeChrome();
    const initial: FakeTab[] = [];
    for (let i = 0; i < 20; i++) {
      initial.push(fakeTab(100 + i, `https://site${i}.example/page`));
    }
    initial.push(fakeTab(200, 'https://a.example/x'), fakeTab(201, 'https://a.example/x'));
    initial.push(fakeTab(202, 'https://b.example/y'), fakeTab(203, 'https://b.example/y'));
    initial.push(
      fakeTab(204, 'https://c.example/z'),
      fakeTab(205, 'https://c.example/z'),
      fakeTab(206, 'https://c.example/z'),
    );
    await bootAndSettle(env, initial);
    expect(env.removed).toEqual([]);
    expect(env.badgeTexts[env.badgeTexts.length - 1]).toBe('4');
    expect(env.badgeTitles[env.badgeTitles.length - 1]).toContain(
      '4 duplicate tabs',
    );
  }, 15_000);

  it('pinned duplicates never count toward the badge', async () => {
    const env = makeFakeChrome();
    await bootAndSettle(env, [
      fakeTab(1, 'https://example.com/pinned', { pinned: true }),
      fakeTab(2, 'https://example.com/pinned', { pinned: true }),
      fakeTab(3, 'https://example.com/pinned', { pinned: true }),
    ]);
    expect(env.badgeTexts[env.badgeTexts.length - 1]).toBe('');
  }, 15_000);

  it('caps the text at 99+ while the title keeps the true count', async () => {
    const env = makeFakeChrome();
    const initial: FakeTab[] = [];
    for (let i = 0; i < 120; i++) {
      initial.push(fakeTab(1000 + i * 2, `https://s${i}.example/p`));
      initial.push(fakeTab(1000 + i * 2 + 1, `https://s${i}.example/p`));
    }
    await bootAndSettle(env, initial);
    expect(env.badgeTexts[env.badgeTexts.length - 1]).toBe('99+');
    expect(env.badgeTitles[env.badgeTitles.length - 1]).toContain(
      '120 duplicate tabs',
    );
  }, 15_000);

  it('D2 regression: the badge moves when duplicates change after init, with no panel request', async () => {
    const env = makeFakeChrome();
    await bootAndSettle(env, [
      fakeTab(1, 'https://example.com/one'),
      fakeTab(2, 'https://example.com/one'),
      fakeTab(3, 'https://example.com/other'),
    ]);
    expect(env.badgeTexts[env.badgeTexts.length - 1]).toBe('1');
    const writesBefore = env.badgeTexts.length;
    // The user closes the extra copy by hand. The only path that
    // can clear the badge is the event-driven coalesced refresh
    // (before the D2 fix it re-armed itself forever and the badge
    // stayed at '1' for the rest of the session).
    const tabsApi = env.chrome.tabs as {
      remove: (id: number) => Promise<void>;
    };
    await tabsApi.remove(2);
    await until(
      () => env.badgeTexts[env.badgeTexts.length - 1] === '',
      'badge clears from the tab event alone',
    );
    expect(env.badgeTexts.length).toBeGreaterThan(writesBefore);
  }, 15_000);
});
