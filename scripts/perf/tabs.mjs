/**
 * Tab open/close helpers built on the CDP client.
 *
 * Timing convention for tab-open latency: t0 is taken immediately
 * before Target.createTarget is sent; the measurement ends when the
 * new page session fires Page.loadEventFired. A duplicate tab that
 * the extension auto-closes can be detached before its load event —
 * that resolves as outcome 'detached' with the create→detach
 * duration, which is the user-perceived resolution time of that open.
 * 'timeout' outcomes are excluded from latency statistics.
 */

import { performance } from 'node:perf_hooks';
import { sleep } from './cdp.mjs';

/**
 * Open one tab and wait for it to settle (load or detach).
 * @returns {Promise<{targetId: string, sessionId: string|null,
 *   outcome: 'load'|'detached'|'timeout', ms: number}>}
 */
export async function openTabAndWait(cdp, url, { timeoutMs = 15_000, background = false } = {}) {
  const t0 = performance.now();
  const { targetId } = await cdp.send('Target.createTarget', { url, background });
  const sessionId = await cdp.waitForSession(targetId, Math.min(timeoutMs, 10_000));
  if (!sessionId) {
    return { targetId, sessionId: null, outcome: 'timeout', ms: performance.now() - t0 };
  }
  const outcome = await cdp.waitForLoadOrDetach(sessionId, timeoutMs);
  return { targetId, sessionId, outcome, ms: performance.now() - t0 };
}

/**
 * Open a batch of tabs sequentially, measuring each open. Used by the
 * latency scenario, where per-tab isolation matters more than speed.
 */
export async function openBatchSequential(cdp, urls, { timeoutMs = 15_000 } = {}) {
  const results = [];
  for (const url of urls) {
    results.push(await openTabAndWait(cdp, url, { timeoutMs }));
  }
  return results;
}

/**
 * Open a batch of tabs concurrently (background tabs) and wait for
 * all of them to settle. Used by the memory/churn scenarios, where
 * throughput matters and individual timings do not.
 * @returns {Promise<string[]>} targetIds that were created
 */
export async function openBatchConcurrent(cdp, urls, { timeoutMs = 20_000 } = {}) {
  const created = await Promise.all(
    urls.map(async (url) => {
      try {
        const { targetId } = await cdp.send('Target.createTarget', { url, background: true });
        return targetId;
      } catch {
        return null;
      }
    }),
  );
  const targetIds = created.filter(Boolean);
  await Promise.all(
    targetIds.map(async (targetId) => {
      const sessionId = await cdp.waitForSession(targetId, 10_000);
      if (sessionId) await cdp.waitForLoadOrDetach(sessionId, timeoutMs);
    }),
  );
  return targetIds;
}

/** Close targets, tolerating ones the extension already closed. */
export async function closeTargets(cdp, targetIds) {
  await Promise.allSettled(
    targetIds.map((targetId) => cdp.send('Target.closeTarget', { targetId })),
  );
}

/** Page targets whose URL starts with the fixture base. */
export async function fixturePageTargets(cdp, fixtureBase) {
  const targets = await cdp.getTargets();
  return targets.filter((t) => t.type === 'page' && t.url.startsWith(fixtureBase));
}

export async function countFixturePages(cdp, fixtureBase) {
  return (await fixturePageTargets(cdp, fixtureBase)).length;
}

/**
 * Create fixture tabs until `want` fixture page targets exist
 * (top-up loop: creation under memory pressure can drop a tab, and
 * duplicates are never used here so the count is exact). Returns
 * { count, nextIndex } — nextIndex continues the unique-path
 * sequence so staged callers never reuse a path (a reused path
 * would be an exact duplicate and get auto-closed).
 */
export async function openTabsUntilCount(
  cdp,
  fixture,
  want,
  { startIndex = 0, timeoutMs = 300_000, log = () => {} } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let nextIndex = startIndex;
  let current = await countFixturePages(cdp, fixture.base);
  while (current < want && Date.now() < deadline) {
    const missing = want - current;
    const burstSize = Math.min(25, missing);
    const urls = [];
    for (let i = 0; i < burstSize; i++) {
      urls.push(fixture.url(`/p/${nextIndex++}`));
    }
    await openBatchConcurrent(cdp, urls);
    // Give the browser a beat to register targets before recounting.
    await sleep(500);
    current = await countFixturePages(cdp, fixture.base);
    log(`openTabsUntilCount: ${current}/${want} fixture tabs`);
  }
  return { count: current, nextIndex };
}
