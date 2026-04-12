import http from 'http';
import { logger } from './logger.js';

/** Mutable state read by the health endpoints. */
export const health = {
  connected: false,
};

/**
 * Start a lightweight HTTP server for k8s probes.
 *
 * GET /health — liveness:  always 200 while the process is alive
 * GET /ready  — readiness: 200 when connected to central server, 503 otherwise
 */
export function startHealthServer(port = 8080): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/ready') {
      if (health.connected) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', connected: true }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not ready', connected: false }));
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'Health server error');
  });
}
