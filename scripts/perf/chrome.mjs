/**
 * Chrome resolution + launch for the perf harness.
 *
 * Binary resolution order:
 *   1. $CHROME_BIN
 *   2. google-chrome / google-chrome-stable / chromium /
 *      chromium-browser found on $PATH
 *   3. /opt/meta-chromium/chrome (local dev VM)
 *
 * Launch: fresh (or caller-supplied) temp user-data-dir,
 * --remote-debugging-port=0 with the port read back from the
 * profile's DevToolsActivePort file, headless=new unless
 * PERF_HEADED=1. Extension runs add --load-extension +
 * --disable-extensions-except pointing at the built MV3 output.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CdpClient, sleep } from './cdp.mjs';

function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveChromeBin() {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  const local = '/opt/meta-chromium/chrome';
  if (isExecutable(local)) return local;
  throw new Error(
    'No Chrome binary found. Set CHROME_BIN, install google-chrome, or use the local /opt/meta-chromium/chrome.',
  );
}

export function makeProfileDir() {
  return mkdtempSync(join(tmpdir(), 'tabsense-perf-profile-'));
}

export function removeProfileDir(profileDir) {
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Temp dir cleanup is best-effort.
  }
}

async function readDevToolsWsUrl(profileDir, timeoutMs = 30_000) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const lines = readFileSync(portFile, 'utf8').trim().split('\n');
      const port = lines[0]?.trim();
      const path = lines[1]?.trim();
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await sleep(100);
  }
  throw new Error(`DevToolsActivePort did not appear in ${profileDir} within ${timeoutMs} ms`);
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Launch Chrome and connect CDP.
 *
 * @param {object} opts
 * @param {string} opts.profileDir user-data-dir (created by caller so
 *   restore scenarios can relaunch the same profile)
 * @param {string|null} opts.extensionDir absolute path to the built
 *   extension, or null for a no-extension run
 * @param {string[]} opts.extraArgs additional Chrome flags
 * @param {string} opts.initialUrl first page (default about:blank)
 * @returns {Promise<{proc: object, cdp: CdpClient, profileDir: string,
 *   wsUrl: string, close: (opts?: {graceful?: boolean}) => Promise<void>}>}
 */
export async function launchChrome({
  profileDir,
  extensionDir = null,
  extraArgs = [],
  initialUrl = 'about:blank',
}) {
  const bin = resolveChromeBin();
  const headed = process.env.PERF_HEADED === '1';
  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-precise-memory-info',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--mute-audio',
    ...(headed ? [] : ['--headless=new']),
    ...extraArgs,
  ];
  if (extensionDir) {
    args.push(`--load-extension=${extensionDir}`);
    args.push(`--disable-extensions-except=${extensionDir}`);
  }
  args.push(initialUrl);

  // A reused profile (restore scenarios) can still carry the
  // previous run's DevToolsActivePort — delete it so the port read
  // below only ever sees this launch's endpoint.
  try {
    unlinkSync(join(profileDir, 'DevToolsActivePort'));
  } catch {
    // File does not exist yet — the normal fresh-profile case.
  }
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2_000);
  });
  proc.on('error', (err) => {
    throw err;
  });

  let cdp;
  try {
    const wsUrl = await readDevToolsWsUrl(profileDir);
    // The endpoint can lag the port file by a beat on a heavy
    // (restored-session) startup — retry the connect briefly.
    let lastErr = null;
    for (let attempt = 0; attempt < 20 && !cdp; attempt++) {
      try {
        cdp = await CdpClient.connect(wsUrl, 3_000);
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    if (!cdp) throw lastErr ?? new Error(`Could not connect to ${wsUrl}`);
    await cdp.enableAutoAttach();
    return {
      proc,
      cdp,
      profileDir,
      wsUrl,
      /**
       * Graceful close (Browser.close) lets Chrome flush the session
       * to disk — required before a --restore-last-session relaunch.
       * Falls back to SIGKILL if Chrome does not exit in time.
       */
      async close({ graceful = true } = {}) {
        if (graceful) {
          try {
            await cdp.send('Browser.close', {}, undefined, 5_000);
          } catch {
            // Connection may already be gone; fall through to wait/kill.
          }
          if (await waitForExit(proc, 15_000)) {
            cdp.close();
            return;
          }
        }
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead.
        }
        await waitForExit(proc, 5_000);
        cdp.close();
      },
      stderrTail: () => stderrTail,
    };
  } catch (err) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // Ignore.
    }
    throw new Error(
      `Chrome launch failed (${bin}): ${err.message}${stderrTail ? `\nChrome stderr tail: ${stderrTail}` : ''}`,
    );
  }
}

export async function chromeVersion(cdp) {
  try {
    const v = await cdp.send('Browser.getVersion', {});
    return v.product ?? null;
  } catch {
    return null;
  }
}
