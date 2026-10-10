/**
 * Minimal Chrome DevTools Protocol client over the built-in WebSocket
 * (Node 22+). Zero dependencies.
 *
 * Model: one browser-level WebSocket connection. Targets are
 * auto-attached in flatten mode (Target.setAutoAttach), so every
 * target gets a sessionId on the same connection and protocol
 * messages carry that sessionId at the top level.
 *
 * The client tracks:
 *  - sessions per targetId (from Target.attachedToTarget),
 *  - Page.loadEventFired per page session, exposed as
 *    waitForLoadOrDetach(sessionId) so tab-open timing can resolve on
 *    either a completed load or the target being closed first (the
 *    extension auto-closes duplicate tabs, which can race the load).
 *
 * Attached hooks: callbacks registered with addAttachedHook run for
 * every newly attached target (used e.g. to apply CPU throttling to
 * each page session at attach time). Page.enable is sent
 * automatically for page targets so load events flow.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function, method: string}>} */
    this.pending = new Map();
    /** @type {Array<(msg: object) => void>} */
    this.listeners = [];
    /** @type {Array<(info: {sessionId: string, targetInfo: object}) => void>} */
    this.attachedHooks = [];
    /** targetId -> sessionId */
    this.sessionByTarget = new Map();
    /** sessionId -> targetInfo */
    this.targetBySession = new Map();
    /** sessionId -> Array<resolve> waiting for load/detach */
    this.loadWaiters = new Map();
    /** sessionIds that already fired loadEventFired */
    this.loadedSessions = new Set();
    /** sessionIds whose target detached */
    this.detachedSessions = new Set();

    ws.onmessage = (ev) => this.#onMessage(ev);
    ws.onclose = () => {
      for (const { reject, method } of this.pending.values()) {
        reject(new Error(`CDP connection closed while waiting for ${method}`));
      }
      this.pending.clear();
      // Release any load waiters so scenarios fail fast, not hang.
      for (const waiters of this.loadWaiters.values()) {
        for (const w of waiters) w.resolve('detached');
      }
      this.loadWaiters.clear();
    };
  }

  static async connect(wsUrl, timeoutMs = 15_000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out connecting to ${wsUrl}`)),
        timeoutMs,
      );
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = (err) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to ${wsUrl}: ${err?.message ?? err}`));
      };
    });
    return new CdpClient(ws);
  }

  #onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(
          new Error(
            `CDP ${entry.method} failed: ${msg.error.message ?? JSON.stringify(msg.error)}`,
          ),
        );
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) {
      this.#handleEvent(msg);
      for (const listener of this.listeners) {
        try {
          listener(msg);
        } catch {
          // Listener bugs must not break protocol handling.
        }
      }
    }
  }

  #handleEvent(msg) {
    const { method, params, sessionId } = msg;
    if (method === 'Target.attachedToTarget') {
      const { sessionId: sid, targetInfo } = params;
      this.sessionByTarget.set(targetInfo.targetId, sid);
      this.targetBySession.set(sid, targetInfo);
      if (targetInfo.type === 'page') {
        // Needed for Page.loadEventFired. Fire and forget.
        this.send('Page.enable', {}, sid).catch(() => {});
      }
      for (const hook of this.attachedHooks) {
        try {
          const r = hook({ sessionId: sid, targetInfo });
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
          // Hooks are best-effort (e.g. throttling a short-lived page).
        }
      }
      this.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
    } else if (method === 'Target.detachedFromTarget') {
      const sid = params.sessionId;
      this.detachedSessions.add(sid);
      for (const [targetId, s] of this.sessionByTarget) {
        if (s === sid) this.sessionByTarget.delete(targetId);
      }
      this.targetBySession.delete(sid);
      this.#resolveLoadWaiters(sid, 'detached');
    } else if (method === 'Page.loadEventFired' && sessionId) {
      this.loadedSessions.add(sessionId);
      this.#resolveLoadWaiters(sessionId, 'load');
    }
  }

  #resolveLoadWaiters(sessionId, outcome) {
    const waiters = this.loadWaiters.get(sessionId);
    if (!waiters) return;
    this.loadWaiters.delete(sessionId);
    for (const w of waiters) w.resolve(outcome);
  }

  /** Subscribe to all protocol events. Returns an unsubscribe fn. */
  on(listener) {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Subscribe to one protocol method. Returns an unsubscribe fn. */
  onMethod(method, listener) {
    return this.on((msg) => {
      if (msg.method === method) listener(msg);
    });
  }

  addAttachedHook(hook) {
    this.attachedHooks.push(hook);
  }

  /**
   * Send a protocol method. `sessionId` targets a flattened session;
   * omit it for browser-level methods.
   */
  send(method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  /** Enable target discovery + flatten auto-attach. Call once. */
  async enableAutoAttach() {
    await this.send('Target.setDiscoverTargets', { discover: true });
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }

  async getTargets() {
    const { targetInfos } = await this.send('Target.getTargets', {});
    return targetInfos ?? [];
  }

  sessionForTarget(targetId) {
    return this.sessionByTarget.get(targetId) ?? null;
  }

  /** Wait until a target has an attached session. */
  async waitForSession(targetId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let triedExplicitAttach = false;
    for (;;) {
      const sid = this.sessionByTarget.get(targetId);
      if (sid) return sid;
      if (Date.now() >= deadline) return null;
      // Auto-attach normally delivers the session within milliseconds.
      // If it hasn't after ~1 s (e.g. the target predates auto-attach),
      // attach explicitly once.
      if (!triedExplicitAttach && Date.now() > deadline - timeoutMs + 1_000) {
        triedExplicitAttach = true;
        try {
          const { sessionId } = await this.send(
            'Target.attachToTarget',
            { targetId, flatten: true },
            undefined,
            2_000,
          );
          if (sessionId && !this.sessionByTarget.has(targetId)) {
            this.sessionByTarget.set(targetId, sessionId);
          }
        } catch {
          // Target may already be gone; keep polling until deadline.
        }
      }
      await sleep(25);
    }
  }

  /**
   * Resolve 'load' when Page.loadEventFired fires for the session,
   * 'detached' if the target goes away first, or 'timeout'.
   */
  waitForLoadOrDetach(sessionId, timeoutMs = 15_000) {
    if (this.loadedSessions.has(sessionId)) return Promise.resolve('load');
    if (this.detachedSessions.has(sessionId)) return Promise.resolve('detached');
    return new Promise((resolve) => {
      const waiter = {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      const timer = setTimeout(() => {
        const waiters = this.loadWaiters.get(sessionId);
        if (waiters) {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          if (waiters.length === 0) this.loadWaiters.delete(sessionId);
        }
        resolve('timeout');
      }, timeoutMs);
      const waiters = this.loadWaiters.get(sessionId) ?? [];
      waiters.push(waiter);
      this.loadWaiters.set(sessionId, waiters);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Already closed.
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
