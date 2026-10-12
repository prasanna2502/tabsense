/**
 * Worker-level dedupe hardening (test-hardening commission,
 * method 3) — the duplicate engine as it actually runs in
 * entrypoints/background.ts, driven through a fake chrome surface
 * (tests/helpers/fake-chrome.ts). The Wasm bridge is mocked with a
 * controllable core state; canonical keys come from the real TS
 * fallback (parity with the core is proven separately in
 * canon-parity.test.ts), so what is under test here is the
 * WORKER's state machine: event ordering, the observed gate, the
 * cold-core queue, the exemption lifecycle, the badge, the logs.
 *
 * Two defects were found by this suite and fixed on this branch:
 *  - D1 (P0): two duplicates evaluated concurrently could each
 *    pick the other as "the existing tab" and BOTH be closed —
 *    the user lost every copy of the page. Fixed with key-arrival
 *    seniority: a tab only ever closes in favor of a tab that held
 *    the same canonical key before it did.
 *  - D2 (P1): the coalesced snapshot refresh re-armed its own
 *    timer instead of refreshing, so event-driven snapshot/badge
 *    updates never landed after init. Fixed to call
 *    refreshSnapshot() on the trailing edge.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalKeysFallback } from '../src/lib/canonicalize';
import { normalizeUrlFallback } from '../src/lib/normalize';
import { tsScorer } from '../src/lib/scorer';
import {
  fakeTab,
  flush,
  makeFakeChrome,
  until,
  type FakeChromeEnv,
  type FakeTab,
} from './helpers/fake-chrome';

const core = vi.hoisted(() => ({
  state: 'pending' as 'pending' | 'ready' | 'failed',
  resolvers: [] as Array<(ok: boolean) => void>,
}));

vi.mock('../src/wasm/load', () => ({
  getCoreState: () => core.state,
  isCoreReady: () => core.state === 'ready',
  ensureCoreReady: () =>
    core.state === 'pending'
      ? new Promise<boolean>((res) => {
          core.resolvers.push(res);
        })
      : Promise.resolve(core.state === 'ready'),
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

async function boot(
  env: FakeChromeEnv,
  initialTabs: FakeTab[],
): Promise<void> {
  env.tabsData.push(...initialTabs);
  // Grouping passes are not under test in this file, and a
  // previous boot's debounced pass (1.5 s) would otherwise fire
  // mid-test and write its snapshot/badge into this env through
  // the ambient chrome global. Pausing grouping keeps each
  // boot's worker quiet once its own events settle. (Badge
  // behavior has its own file: worker-badge.test.ts.)
  const gs = (env.store.get('groupingSettings') as Record<string, unknown>) ?? {};
  env.store.set('groupingSettings', { groupingPaused: true, ...gs });
  vi.stubGlobal('chrome', env.chrome);
  // Exhaust the PREVIOUS boot's pending timers before this
  // worker starts: a stray coalesced refresh from that worker
  // re-queries the ambient chrome (this env) and can produce a
  // snapshot indistinguishable from this worker's init snapshot,
  // fooling the gate below into firing events before init has
  // marked tabs observed. 300 ms outlives the 250 ms coalesce;
  // grouping is paused in this file, so nothing longer exists.
  await new Promise((r) => setTimeout(r, 300));
  const startedAt = Date.now();
  const mod = await import('../entrypoints/background');
  (mod.default as { main: () => void }).main();
  // Wait for THIS worker's init snapshot: fresh timestamp and
  // exactly the initial tab set. (Earlier boots' workers share
  // the process; their stray timers resolve the ambient `chrome`
  // global — the current stub — and can write THEIR snapshot
  // into this env's store. Content + freshness together identify
  // the real one.)
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
  }, 'init snapshot of this worker');
}

function landCore(): void {
  core.state = 'ready';
  for (const res of core.resolvers.splice(0)) res(true);
}

beforeEach(() => {
  vi.resetModules();
  core.state = 'pending';
  core.resolvers = [];
});

describe('cold-core queue and the observed gate', () => {
  it('D1 regression: a duplicate pair created while the core is pending loses exactly ONE tab on drain', async () => {
    const env = makeFakeChrome();
    await boot(env, [fakeTab(1, 'https://example.com/home')]);
    const t2 = fakeTab(2, 'https://example.com/dup');
    const t3 = fakeTab(3, 'https://example.com/dup');
    env.tabsData.push(t2, t3);
    env.fire('tabs.onCreated', t2);
    env.fire('tabs.onCreated', t3);
    await flush();
    expect(env.removed).toEqual([]);
    landCore();
    await until(() => env.removed.length >= 1, 'first drain close');
    await flush();
    // Exactly one of the pair is closed; the other survives as
    // the existing tab. Before the fix, BOTH were removed.
    expect(env.removed).toHaveLength(1);
    expect(env.tabsData.map((t) => t.id).sort()).toEqual([1, 2]);
    // A focus swap went to the survivor.
    expect(env.focusCalls.map((c) => c.id)).toEqual([2]);
  });

  it('D1 regression, ready core: two same-URL tabs created in one event batch still lose exactly one', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [fakeTab(1, 'https://example.com/home')]);
    const t2 = fakeTab(2, 'https://example.com/dup');
    const t3 = fakeTab(3, 'https://example.com/dup');
    env.tabsData.push(t2, t3);
    env.fire('tabs.onCreated', t2);
    env.fire('tabs.onCreated', t3);
    await until(() => env.removed.length >= 1, 'close');
    await flush();
    expect(env.removed).toHaveLength(1);
    expect(env.tabsData).toHaveLength(2);
  });

  it('a triple created in one batch loses exactly two, keeping one', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, []);
    const tabs = [1, 2, 3].map((id) => fakeTab(id, 'https://example.com/same'));
    env.tabsData.push(...tabs);
    for (const t of tabs) env.fire('tabs.onCreated', t);
    await until(() => env.removed.length >= 2, 'two closes');
    await flush();
    expect(env.removed).toHaveLength(2);
    expect(env.tabsData).toHaveLength(1);
  });

  it('session-restore storm: pre-existing duplicates are indexed, never auto-closed', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    const initial: FakeTab[] = [];
    for (let i = 0; i < 20; i++) {
      initial.push(fakeTab(100 + i, `https://site${i}.example/page`));
    }
    // Three duplicate pairs and one triple among the restored set.
    initial.push(fakeTab(200, 'https://a.example/x'), fakeTab(201, 'https://a.example/x'));
    initial.push(fakeTab(202, 'https://b.example/y'), fakeTab(203, 'https://b.example/y'));
    initial.push(
      fakeTab(204, 'https://c.example/z'),
      fakeTab(205, 'https://c.example/z'),
      fakeTab(206, 'https://c.example/z'),
    );
    await boot(env, initial);
    await flush();
    expect(env.removed).toEqual([]);
  });

  it('a new duplicate of a pre-existing tab closes the NEW tab and focuses the old one', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [fakeTab(1, 'https://example.com/doc', { active: true })]);
    const t2 = fakeTab(2, 'https://example.com/doc');
    env.tabsData.push(t2);
    env.fire('tabs.onCreated', t2);
    await until(() => env.removed.length === 1, 'close');
    expect(env.removed).toEqual([2]);
    expect(env.focusCalls.map((c) => c.id)).toEqual([1]);
  });

  it('core failed: queued events are dropped and nothing ever auto-closes', async () => {
    const env = makeFakeChrome();
    await boot(env, [fakeTab(1, 'https://example.com/doc')]);
    const t2 = fakeTab(2, 'https://example.com/doc');
    env.tabsData.push(t2);
    env.fire('tabs.onCreated', t2);
    core.state = 'failed';
    for (const res of core.resolvers.splice(0)) res(false);
    await flush();
    expect(env.removed).toEqual([]);
    // Even after the failure, later duplicates are left alone.
    const t3 = fakeTab(3, 'https://example.com/doc');
    env.tabsData.push(t3);
    env.fire('tabs.onCreated', t3);
    await flush();
    expect(env.removed).toEqual([]);
    // The failure lands in the snapshot via the coalesced
    // refresh (250 ms trailing edge) — poll for it.
    await until(
      () => env.storedSnapshot()?.coreState === 'failed',
      'snapshot records the failed core',
    );
  });
});

describe('snapshot coalescing (D2)', () => {
  it('D2 regression: tab events after init refresh the stored snapshot', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [fakeTab(1, 'https://example.com/one')]);
    const before = env.storedSnapshot();
    expect((before?.tabs as unknown[]).length).toBe(1);
    // Open two more (distinct) tabs WITHOUT any panel snapshot
    // request — the event-driven coalesced refresh is the only
    // path that can update the stored snapshot. Before the fix
    // the coalesce timer re-armed itself forever and this
    // snapshot stayed at one tab for the whole session.
    const t2 = fakeTab(2, 'https://example.com/two');
    const t3 = fakeTab(3, 'https://example.com/three');
    env.tabsData.push(t2, t3);
    env.fire('tabs.onCreated', t2);
    env.fire('tabs.onCreated', t3);
    await until(
      () => ((env.storedSnapshot()?.tabs as unknown[]) ?? []).length === 3,
      'snapshot refresh after tab events',
    );
    // And a close is reflected too.
    const tabsApi = env.chrome.tabs as {
      remove: (id: number) => Promise<void>;
    };
    await tabsApi.remove(3);
    await until(
      () => ((env.storedSnapshot()?.tabs as unknown[]) ?? []).length === 2,
      'snapshot refresh after close',
    );
  }, 10_000);
});

describe('intentional-duplicate fingerprint at the event level', () => {
  const SOURCE = fakeTab(10, 'https://docs.example.com/report', {
    index: 3,
    active: true,
  });

  async function bootWithSource(): Promise<FakeChromeEnv> {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [{ ...SOURCE }]);
    return env;
  }

  it('keeps a Duplicate-command copy: same URL, opener = source, adjacent, source active', async () => {
    const env = await bootWithSource();
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 4,
      openerTabId: 10,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await flush();
    expect(env.removed).toEqual([]);
    const kept = env
      .storedActivity()
      .find((a) => a.reason === 'kept-intentional');
    expect(kept).toBeDefined();
    expect(kept?.closedTabId).toBe(11);
  });

  it('closes the copy when it lands two positions away (not adjacent)', async () => {
    const env = await bootWithSource();
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 5,
      openerTabId: 10,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await until(() => env.removed.length === 1, 'close');
    expect(env.removed).toEqual([11]);
  });

  it('closes the copy when the opener is a different tab', async () => {
    const env = await bootWithSource();
    const other = fakeTab(12, 'https://other.example/page', { index: 4 });
    env.tabsData.push(other);
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 5,
      openerTabId: 12,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await until(() => env.removed.length === 1, 'close');
    expect(env.removed).toEqual([11]);
  });

  it('closes the copy when the source was not the active tab', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [{ ...SOURCE, active: false }]);
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 4,
      openerTabId: 10,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await until(() => env.removed.length === 1, 'close');
    expect(env.removed).toEqual([11]);
  });

  it('the exemption ends when the kept tab navigates onto another duplicated URL', async () => {
    const env = await bootWithSource();
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 4,
      openerTabId: 10,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await flush();
    expect(env.removed).toEqual([]);
    // Another tab already shows the target page.
    const target = fakeTab(12, 'https://example.com/target');
    env.tabsData.push(target);
    env.fire('tabs.onCreated', target);
    await flush();
    // The exempt tab navigates there: normal rules apply again.
    const navigated = { ...dup, url: 'https://example.com/target' };
    const idx = env.tabsData.findIndex((t) => t.id === 11);
    env.tabsData[idx] = navigated;
    env.fire('tabs.onUpdated', 11, { status: 'complete' }, navigated);
    await until(() => env.removed.length === 1, 'close after navigation');
    expect(env.removed).toEqual([11]);
    expect(env.focusCalls.map((c) => c.id)).toContain(12);
  });

  it('the exemption is per-tab: a third copy of the same URL still closes', async () => {
    const env = await bootWithSource();
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 4,
      openerTabId: 10,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await flush();
    const third = fakeTab(12, 'https://docs.example.com/report', { index: 6 });
    env.tabsData.push(third);
    env.fire('tabs.onCreated', third);
    await until(() => env.removed.length === 1, 'third closes');
    expect(env.removed).toEqual([12]);
  });

  it('with the setting off, even a perfect fingerprint copy closes', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    env.store.set('groupingSettings', { keepIntentionalDuplicates: false });
    await boot(env, [{ ...SOURCE }]);
    const dup = fakeTab(11, 'https://docs.example.com/report', {
      index: 4,
      openerTabId: 10,
    });
    env.tabsData.push(dup);
    env.fire('tabs.onCreated', dup);
    await until(() => env.removed.length === 1, 'close');
    expect(env.removed).toEqual([11]);
  });
});

describe('exclusions and settings gates', () => {
  it('pinned duplicates are never closed and never counted', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://example.com/pinned', { pinned: true }),
      fakeTab(2, 'https://example.com/pinned', { pinned: true }),
    ]);
    const t3 = fakeTab(3, 'https://example.com/pinned', { pinned: true });
    env.tabsData.push(t3);
    env.fire('tabs.onCreated', t3);
    await flush();
    expect(env.removed).toEqual([]);
  });

  it('browser pages and the extension’s own pages are out of scope', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'chrome://extensions/'),
      fakeTab(2, 'chrome://extensions/'),
      fakeTab(3, 'chrome-extension://fake-extension-id/sidepanel.html'),
      fakeTab(4, 'chrome-extension://fake-extension-id/sidepanel.html'),
    ]);
    await flush();
    expect(env.removed).toEqual([]);
  });

  it('auto-close disabled in settings: duplicates are left alone', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    env.store.set('autoCloseEnabled', false);
    await boot(env, [fakeTab(1, 'https://example.com/doc')]);
    const t2 = fakeTab(2, 'https://example.com/doc');
    env.tabsData.push(t2);
    env.fire('tabs.onCreated', t2);
    await flush();
    expect(env.removed).toEqual([]);
  });
});

describe('navigation and cross-window behavior', () => {
  it('a tab that navigates onto an open URL is the one closed', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://example.com/stays'),
      fakeTab(2, 'https://example.com/elsewhere'),
    ]);
    const navigated = fakeTab(2, 'https://example.com/stays');
    env.tabsData[1] = navigated;
    env.fire('tabs.onUpdated', 2, { status: 'complete' }, navigated);
    await until(() => env.removed.length === 1, 'navigator closed');
    expect(env.removed).toEqual([2]);
    expect(env.focusCalls.map((c) => c.id)).toEqual([1]);
  });

  it('an intermediate (non-settled) update never closes', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://example.com/stays'),
      fakeTab(2, 'https://example.com/elsewhere'),
    ]);
    const passing = fakeTab(2, 'https://example.com/stays');
    env.fire('tabs.onUpdated', 2, { status: 'loading', url: 'https://example.com/stays' }, passing);
    await flush();
    expect(env.removed).toEqual([]);
  });

  it('closing focuses the existing tab’s window when the duplicate is elsewhere', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://example.com/doc', { windowId: 7 }),
    ]);
    const t2 = fakeTab(2, 'https://example.com/doc', { windowId: 9 });
    env.tabsData.push(t2);
    env.fire('tabs.onCreated', t2);
    await until(() => env.removed.length === 1, 'close');
    expect(env.removed).toEqual([2]);
    expect(env.windowFocusCalls).toEqual([7]);
  });
});

describe('panel-initiated closes re-validate against live state', () => {
  it('close-all-duplicates keeps each set’s newest tab', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://a.example/x'),
      fakeTab(2, 'https://a.example/x'),
      fakeTab(3, 'https://a.example/x'),
      fakeTab(4, 'https://b.example/y'),
      fakeTab(5, 'https://b.example/y'),
      fakeTab(6, 'https://c.example/z'),
    ]);
    const res = (await env.sendMessage({
      type: 'tabs:close-all-duplicates',
    })) as { closed: number };
    expect(res.closed).toBe(3);
    expect(env.removed.sort()).toEqual([1, 2, 4]);
    expect(env.tabsData.map((t) => t.id).sort()).toEqual([3, 5, 6]);
  });

  it('close-similar-set closes the other views and spares the chosen one', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://docs.google.com/document/d/DOC1/edit'),
      fakeTab(2, 'https://docs.google.com/document/d/DOC1/view'),
      fakeTab(3, 'https://docs.google.com/document/d/DOC1/edit#heading=h.x'),
    ]);
    const res = (await env.sendMessage({
      type: 'tabs:close-similar-set',
      fuzzyKey: 'gdoc:document:DOC1',
      keepTabId: 2,
    })) as { closed: number };
    expect(res.closed).toBe(2);
    expect(env.tabsData.map((t) => t.id)).toEqual([2]);
  });

  it('close-similar-set with a keep tab outside the set closes nothing', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [
      fakeTab(1, 'https://docs.google.com/document/d/DOC1/edit'),
      fakeTab(2, 'https://docs.google.com/document/d/DOC1/view'),
      fakeTab(9, 'https://example.com/unrelated'),
    ]);
    const res = (await env.sendMessage({
      type: 'tabs:close-similar-set',
      fuzzyKey: 'gdoc:document:DOC1',
      keepTabId: 9,
    })) as { closed: number };
    expect(res.closed).toBe(0);
    expect(env.removed).toEqual([]);
  });
});

describe('activity log at scale', () => {
  it('the activity log caps at 100 entries, newest first', async () => {
    core.state = 'ready';
    const env = makeFakeChrome();
    await boot(env, [fakeTab(1, 'https://example.com/loop')]);
    for (let i = 0; i < 105; i++) {
      const t = fakeTab(100 + i, 'https://example.com/loop');
      env.tabsData.push(t);
      env.fire('tabs.onCreated', t);
      const want = i + 1;
      await until(() => env.removed.length >= want, `close #${want}`);
    }
    await until(
      () => env.storedActivity().length >= 100,
      'activity persisted',
    );
    const log = env.storedActivity();
    expect(log).toHaveLength(100);
    expect(log[0].closedTabId).toBe(100 + 104);
    expect(log[log.length - 1].closedTabId).toBe(100 + 5);
  }, 30_000);
});
