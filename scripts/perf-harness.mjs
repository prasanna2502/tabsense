#!/usr/bin/env node
/**
 * TabSense CDP end-to-end performance harness (M3).
 *
 * Drives real Chrome via a minimal CDP client (built-in WebSocket,
 * zero dependencies) with the built extension loaded, and enforces
 * the budgets in perf-budgets.json (thresholds are loaded from that
 * file — never hardcoded here).
 *
 * Scenarios: latency, swap, memory, restore-storm, churn, idle.
 * Filter with:  node scripts/perf-harness.mjs --only latency,swap
 * (aliases: restore -> restore-storm)
 *
 * Env:
 *   CHROME_BIN        Chrome/Chromium binary override
 *   PERF_HEADED=1     run headed (debugging)
 *   PERF_SKIP_BUILD=1 skip the "build if .output is missing" check
 *   PERF_CHURN_TOTAL / PERF_CHURN_WARMUP  local iteration aids for the
 *                     churn scenario (defaults are the spec values;
 *                     non-default runs report gates informationally)
 *
 * Output: stdout measured-vs-budget table + perf-report.json and
 * perf-report.md in <repo>/.perf-results/ (CI artifacts).
 * Exit code: 1 if any gate fails (or a scenario errors), else 0.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { launchChrome, makeProfileDir, removeProfileDir, chromeVersion } from './perf/chrome.mjs';
import { startFixture } from './perf/fixture.mjs';
import { SCENARIOS } from './perf/scenarios.mjs';
import { anyGateFailed, buildJsonReport, renderMarkdown, renderStdoutTable } from './perf/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, '.output', 'chrome-mv3');
const resultsDir = join(root, '.perf-results');

function loadBudgets() {
  const parsed = JSON.parse(readFileSync(join(root, 'perf-budgets.json'), 'utf8'));
  if (!Array.isArray(parsed.budgets) || parsed.budgets.length === 0) {
    throw new Error('perf-budgets.json contains no budgets');
  }
  return { version: parsed.version, map: new Map(parsed.budgets.map((b) => [b.id, b])) };
}

function ensureBuild() {
  if (process.env.PERF_SKIP_BUILD === '1') return 'skipped (PERF_SKIP_BUILD=1)';
  if (existsSync(join(extensionDir, 'manifest.json'))) return 'present (.output/chrome-mv3)';
  console.log('[perf] .output/chrome-mv3 missing — running `npm run build`…');
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (!existsSync(join(extensionDir, 'manifest.json'))) {
    throw new Error('Build finished but .output/chrome-mv3/manifest.json is still missing');
  }
  return 'built by harness';
}

function parseScenarioSelection(argv) {
  const aliases = { restore: 'restore-storm', 'restore-storm': 'restore-storm' };
  const all = Object.keys(SCENARIOS);
  const idx = argv.indexOf('--only');
  if (idx === -1 || !argv[idx + 1]) return all;
  const wanted = argv[idx + 1]
    .split(',')
    .map((s) => aliases[s.trim()] ?? s.trim())
    .filter(Boolean);
  const unknown = wanted.filter((w) => !all.includes(w));
  if (unknown.length) {
    throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Known: ${all.join(', ')}`);
  }
  return all.filter((id) => wanted.includes(id));
}

async function probeEnvironment() {
  const profileDir = makeProfileDir();
  let browser = null;
  try {
    browser = await launchChrome({ profileDir, extensionDir: null });
    return await chromeVersion(browser.cdp);
  } catch {
    return null;
  } finally {
    if (browser) await browser.close({ graceful: false }).catch(() => {});
    removeProfileDir(profileDir);
  }
}

async function main() {
  const suiteStart = performance.now();
  const budgets = loadBudgets();
  const buildState = ensureBuild();
  const selected = parseScenarioSelection(process.argv.slice(2));
  console.log(`[perf] scenarios: ${selected.join(', ')}`);
  console.log(`[perf] budgets: v${budgets.version} (${budgets.map.size} budgets) from perf-budgets.json`);

  const environment = {
    chrome: await probeEnvironment(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    chromeBin: process.env.CHROME_BIN ?? '(auto-resolved)',
    extensionBuild: buildState,
    headed: process.env.PERF_HEADED === '1',
  };

  const fixture = await startFixture();
  console.log(`[perf] fixture server: ${fixture.base}`);
  const ctx = {
    budgets: budgets.map,
    fixture,
    extensionDir,
    log: (msg) => console.log(`[perf] ${msg}`),
  };

  // Reports are rewritten after every scenario: the full suite runs
  // for ~25 minutes (churn dominates), and a CI timeout or kill must
  // still leave a usable partial artifact behind.
  const writeReports = (resultsSoFar) => {
    const reportArgs = {
      generatedAt: new Date().toISOString(),
      environment,
      budgetsVersion: budgets.version,
      results: resultsSoFar,
      totalDurationMs: Math.round(performance.now() - suiteStart),
    };
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, 'perf-report.json'), JSON.stringify(buildJsonReport(reportArgs), null, 2));
    writeFileSync(join(resultsDir, 'perf-report.md'), renderMarkdown(reportArgs));
  };

  const results = [];
  try {
    for (const id of selected) {
      console.log(`\n[perf] === scenario: ${id} ===`);
      const t0 = performance.now();
      try {
        const result = await SCENARIOS[id](ctx);
        results.push(result);
        console.log(`[perf] === ${id}: ${result.status} (${((performance.now() - t0) / 1000).toFixed(1)} s) ===`);
      } catch (err) {
        results.push({
          id,
          title: id,
          status: 'error',
          durationMs: Math.round(performance.now() - t0),
          measurements: {},
          gates: [],
          notes: [],
          error: err?.stack ?? String(err),
        });
        console.error(`[perf] === ${id}: ERROR ${err?.message ?? err} ===`);
      }
      writeReports(results);
    }
  } finally {
    await fixture.close();
  }

  const totalDurationMs = Math.round(performance.now() - suiteStart);
  writeReports(results);
  console.log(renderStdoutTable(results));
  console.log(`\n[perf] reports written to ${resultsDir}/perf-report.{json,md}`);
  console.log(`[perf] total wall-clock: ${(totalDurationMs / 1000).toFixed(1)} s`);
  process.exit(anyGateFailed(results) ? 1 : 0);
}

main().catch((err) => {
  console.error(`[perf] fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
