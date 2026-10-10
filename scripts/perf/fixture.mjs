/**
 * Deterministic fixture server for the perf harness.
 *
 * A tiny node:http server on 127.0.0.1 (ephemeral port) that serves
 * the same small HTML page for ANY path, so scenario URLs are stable
 * and unique per path (/p/<n>) and duplicates reuse the exact same
 * path. /slow?ms=n delays the response by n ms (available for future
 * scenarios; the current suite loads the instant variant).
 *
 * All traffic stays on loopback: no external network, no DNS, no TLS
 * — page-load time is dominated by tab creation + extension work,
 * which is what the budgets measure.
 */

import http from 'node:http';

export function startFixture() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const respond = () => {
      const body = `<!doctype html><html><head><meta charset="utf-8"><title>perf fixture ${url.pathname}</title></head><body><h1>perf fixture</h1><p>${url.pathname}</p></body></html>`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    };
    if (url.pathname === '/slow') {
      const ms = Math.min(Number(url.searchParams.get('ms') ?? 0) || 0, 30_000);
      setTimeout(respond, ms);
    } else {
      respond();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({
        base,
        port,
        /** Absolute fixture URL for a path like "/p/3". */
        url: (path) => `${base}${path.startsWith('/') ? path : `/${path}`}`,
        close: () =>
          new Promise((res) => {
            server.close(() => res());
            // Do not let keep-alive sockets stall shutdown.
            server.closeAllConnections?.();
            setTimeout(res, 1_000).unref();
          }),
      });
    });
  });
}
