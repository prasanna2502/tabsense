/**
 * Fake `chrome` surface for worker-level tests: just enough of
 * the extension APIs entrypoints/background.ts touches, with
 * event registries the test can fire and call logs it can assert
 * on. Storage is an in-memory Map with the real key/value shape;
 * tab removal fires onRemoved synchronously, like Chrome's
 * ordering (the removal is recorded before listeners run is NOT
 * guaranteed in Chrome — the fake records first, then fires, and
 * worker code must not depend on either order).
 */

export interface FakeTab {
  id: number;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  url: string;
  pendingUrl?: string;
  title: string;
  groupId: number;
  favIconUrl: string;
  lastAccessed: number;
  openerTabId?: number;
}

export function fakeTab(
  id: number,
  url: string,
  extra: Partial<FakeTab> = {},
): FakeTab {
  return {
    id,
    windowId: 1,
    index: id,
    active: false,
    pinned: false,
    url,
    title: `Tab ${id}`,
    groupId: -1,
    favIconUrl: '',
    lastAccessed: 1_000 + id,
    ...extra,
  };
}

type Listener = (...args: never[]) => unknown;

export interface FakeChromeEnv {
  chrome: Record<string, unknown>;
  fire: (name: string, ...args: unknown[]) => void;
  store: Map<string, unknown>;
  tabsData: FakeTab[];
  removed: number[];
  focusCalls: Array<{ id: number; props: Record<string, unknown> }>;
  windowFocusCalls: number[];
  badgeTexts: string[];
  badgeTitles: string[];
  sendMessage: (message: Record<string, unknown>) => Promise<unknown>;
  storedSnapshot: () => Record<string, unknown> | undefined;
  storedActivity: () => Array<Record<string, unknown>>;
}

export function makeFakeChrome(): FakeChromeEnv {
  const listeners = new Map<string, Listener[]>();
  const on = (name: string) => ({
    addListener: (fn: Listener) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
  });
  const fire = (name: string, ...args: unknown[]) => {
    for (const fn of listeners.get(name) ?? []) {
      (fn as (...a: unknown[]) => unknown)(...args);
    }
  };
  const store = new Map<string, unknown>();
  const tabsData: FakeTab[] = [];
  const removed: number[] = [];
  const focusCalls: FakeChromeEnv['focusCalls'] = [];
  const windowFocusCalls: number[] = [];
  const badgeTexts: string[] = [];
  const badgeTitles: string[] = [];

  const chrome = {
    runtime: {
      id: 'fake-extension-id',
      onMessage: on('runtime.onMessage'),
      sendMessage: async () => undefined,
    },
    sidePanel: { setPanelBehavior: async () => undefined },
    action: {
      setBadgeText: async ({ text }: { text: string }) => {
        badgeTexts.push(text);
      },
      setBadgeBackgroundColor: async () => undefined,
      setTitle: async ({ title }: { title: string }) => {
        badgeTitles.push(title);
      },
    },
    windows: {
      update: async (windowId: number) => {
        windowFocusCalls.push(windowId);
        return {};
      },
    },
    tabs: {
      onCreated: on('tabs.onCreated'),
      onUpdated: on('tabs.onUpdated'),
      onRemoved: on('tabs.onRemoved'),
      onActivated: on('tabs.onActivated'),
      onMoved: on('tabs.onMoved'),
      onAttached: on('tabs.onAttached'),
      onDetached: on('tabs.onDetached'),
      onReplaced: on('tabs.onReplaced'),
      query: async () => [...tabsData],
      get: async (id: number) => {
        const t = tabsData.find((x) => x.id === id);
        if (!t) throw new Error(`no tab ${id}`);
        return t;
      },
      update: async (id: number, props: Record<string, unknown>) => {
        focusCalls.push({ id, props });
        return {};
      },
      remove: async (id: number | number[]) => {
        for (const one of Array.isArray(id) ? id : [id]) {
          removed.push(one);
          const idx = tabsData.findIndex((x) => x.id === one);
          if (idx >= 0) tabsData.splice(idx, 1);
          fire('tabs.onRemoved', one, {});
        }
      },
      group: async () => 777,
      ungroup: async () => undefined,
    },
    tabGroups: {
      onCreated: on('tabGroups.onCreated'),
      onUpdated: on('tabGroups.onUpdated'),
      onRemoved: on('tabGroups.onRemoved'),
      query: async () => [],
      get: async () => ({}),
      update: async () => ({}),
    },
    storage: {
      onChanged: on('storage.onChanged'),
      local: {
        get: async (keys: string[] | null) => {
          if (keys === null) return Object.fromEntries(store);
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        getBytesInUse: async () => 1234,
      },
      // managed intentionally absent: unmanaged browser.
    },
  };

  const sendMessage = (message: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      let settled = false;
      const sendResponse = (value: unknown) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      for (const fn of listeners.get('runtime.onMessage') ?? []) {
        (fn as (...a: unknown[]) => unknown)(message, {}, sendResponse);
      }
      // A listener that never responds leaves the promise pending;
      // tests only send messages that do respond.
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      }, 500);
    });

  return {
    chrome: chrome as Record<string, unknown>,
    fire,
    store,
    tabsData,
    removed,
    focusCalls,
    windowFocusCalls,
    badgeTexts,
    badgeTitles,
    sendMessage,
    storedSnapshot: () =>
      store.get('tabSnapshot') as Record<string, unknown> | undefined,
    storedActivity: () =>
      (store.get('activityLog') as Array<Record<string, unknown>>) ?? [],
  };
}

/** Poll until `cond` holds (real timers; the worker's async
 * chains settle in microtasks + a few macrotasks). */
export async function until(
  cond: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Let pending microtask/macrotask chains run to quiescence. */
export async function flush(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}
