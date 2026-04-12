import http from 'http';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { resolveAgentCluster } from './auth.js';
import { logger, audit } from './logger.js';
import { AgentManager, AgentConnection } from './agent-manager.js';
import { createMcpRouter } from './mcp-server.js';
import type { AgentMessage } from './types.js';

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', 1);
app.use(helmet());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down.' },
  }),
);

const agentManager = new AgentManager();

app.use('/', createMcpRouter(agentManager));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', clusters: agentManager.size });
});

// ── HTTP + WebSocket server ────────────────────────────────────────────────────

const MAX_AGENT_CONNECTIONS_PER_IP = parseInt(process.env.MAX_AGENT_CONNECTIONS_PER_IP ?? '10', 10);
const ipConnectionCount = new Map<string, number>();

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/agent') {
    socket.destroy();
    return;
  }

  const ip = getClientIp(req);
  const current = ipConnectionCount.get(ip) ?? 0;
  if (current >= MAX_AGENT_CONNECTIONS_PER_IP) {
    logger.warn({ ip, current, limit: MAX_AGENT_CONNECTIONS_PER_IP }, 'WebSocket connection limit reached for IP');
    socket.write('HTTP/1.1 429 Too Many Connections\r\n\r\n');
    socket.destroy();
    return;
  }

  ipConnectionCount.set(ip, current + 1);

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.once('close', () => {
      const remaining = (ipConnectionCount.get(ip) ?? 1) - 1;
      if (remaining <= 0) ipConnectionCount.delete(ip);
      else ipConnectionCount.set(ip, remaining);
    });
    wss.emit('connection', ws, req);
  });
});

// ── Agent connection handling ──────────────────────────────────────────────────

/** Only allow alphanumeric, hyphen, dot — max 63 chars (k8s name limit). */
function sanitizeClusterName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.replace(/[^a-zA-Z0-9\-.]/g, '').slice(0, 63);
  return clean.length > 0 ? clean : null;
}

wss.on('connection', (ws, req) => {
  const remoteAddress = req.socket.remoteAddress ?? 'unknown';
  const authHeader = req.headers['authorization'] ?? '';

  // Authenticate token and resolve the authorised cluster name in one step.
  const authorizedCluster = resolveAgentCluster(authHeader);
  if (!authorizedCluster) {
    audit.warn({ event: 'auth.failed', remoteAddress, reason: 'invalid_token' });
    ws.close(4001, 'Unauthorized');
    return;
  }

  let connection: AgentConnection | null = null;
  let registered = false;

  const registrationTimeout = setTimeout(() => {
    if (!registered) {
      logger.warn({ authorizedCluster }, 'Agent registration timeout');
      ws.close(4002, 'Registration timeout');
    }
  }, 10_000);

  ws.on('message', (raw) => {
    let msg: AgentMessage;
    try {
      msg = JSON.parse(raw.toString()) as AgentMessage;
    } catch {
      ws.close(4003, 'Invalid JSON');
      return;
    }

    if (!registered) {
      if (msg.type !== 'register') {
        ws.close(4004, 'Expected register message');
        return;
      }

      clearTimeout(registrationTimeout);

      const claimedName = sanitizeClusterName(msg.clusterName);

      // The cluster name in the register message must match what the token authorises.
      // This prevents a compromised cluster from impersonating another.
      if (claimedName !== authorizedCluster) {
        audit.warn({
          event: 'auth.failed',
          remoteAddress,
          reason: 'cluster_name_mismatch',
          authorizedCluster,
          claimedName,
        });
        ws.close(4005, 'Cluster name does not match token authorisation');
        return;
      }

      const version = typeof msg.version === 'string' ? msg.version.slice(0, 32) : 'unknown';
      const kubectlVersion = typeof msg.kubectlVersion === 'string' ? msg.kubectlVersion.slice(0, 64) : 'unknown';
      const helmVersion = typeof msg.helmVersion === 'string' ? msg.helmVersion.slice(0, 64) : 'unknown';

      connection = new AgentConnection(ws, {
        name: authorizedCluster,
        connectedAt: new Date(),
        lastSeen: new Date(),
        version,
        kubectlVersion,
        helmVersion,
      });

      agentManager.register(connection);
      connection.send({ type: 'registered', clusterName: authorizedCluster });
      registered = true;

      audit.info({
        event: 'agent.connected',
        cluster: authorizedCluster,
        version,
        kubectlVersion,
        helmVersion,
        remoteAddress,
      });
      return;
    }

    if (!connection) return;

    if (msg.type === 'response') {
      connection.handleResponse(msg.requestId, msg.success, msg.data, msg.error);
    } else if (msg.type === 'pong') {
      connection.handlePong();
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(registrationTimeout);
    if (connection) {
      audit.info({
        event: 'agent.disconnected',
        cluster: connection.info.name,
        code,
        reason: reason.toString(),
      });

      if (agentManager.get(connection.info.name) === connection) {
        agentManager.unregister(connection.info.name);
      }
      connection = null;
    }
  });

  ws.on('error', (err) => {
    logger.error({ err: err.message, authorizedCluster }, 'Agent WebSocket error');
    if (connection) {
      agentManager.unregister(connection.info.name);
      connection = null;
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(config.port, () => {
  logger.info({
    port: config.port,
    clusters: [...config.clusterTokens.values()],
    mcpAuth: config.mcpApiKey ? 'enabled' : 'disabled',
  }, 'multi-cluster-mcp central server started');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
