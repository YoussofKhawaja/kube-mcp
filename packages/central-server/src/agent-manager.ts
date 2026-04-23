import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { audit, logger } from './logger.js';
import type { ServerMessage, CommandMessage, ClusterInfo } from './types.js';

const COMMAND_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
/** If no pong is received within this window the link is treated as dead. */
const PONG_TIMEOUT_MS = 75_000;

interface PendingCommand {
  resolve: (data: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  tool: CommandMessage['tool'];
  args: string[];
}

// ── AgentConnection ────────────────────────────────────────────────────────────

export class AgentConnection {
  readonly id: string;
  readonly ws: WebSocket;
  info: ClusterInfo;

  private pending = new Map<string, PendingCommand>();
  private pingInterval: NodeJS.Timeout;
  private lastPongAt: number;

  constructor(ws: WebSocket, info: ClusterInfo) {
    this.id = randomUUID();
    this.ws = ws;
    this.info = info;
    this.lastPongAt = Date.now();
    this.pingInterval = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  private ping(): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
      logger.warn(
        { cluster: this.info.name, sinceLastPongMs: Date.now() - this.lastPongAt },
        'No pong within timeout — terminating stale connection',
      );
      this.ws.terminate();
      return;
    }
    this.send({ type: 'ping' });
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  handlePong(): void {
    this.info.lastSeen = new Date();
    this.lastPongAt = Date.now();
  }

  handleResponse(requestId: string, success: boolean, data?: string, error?: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);

    const durationMs = Date.now() - pending.startedAt;

    if (success && data !== undefined) {
      audit.info({
        event: 'command.success',
        requestId,
        cluster: this.info.name,
        tool: pending.tool,
        args: pending.args,
        durationMs,
      });
      pending.resolve(data);
    } else {
      audit.warn({
        event: 'command.failed',
        requestId,
        cluster: this.info.name,
        tool: pending.tool,
        args: pending.args,
        durationMs,
        error,
      });
      pending.reject(new Error(error ?? 'Command failed with no error details'));
    }
  }

  async executeCommand(tool: CommandMessage['tool'], args: string[]): Promise<string> {
    const requestId = randomUUID();
    const message: CommandMessage = { type: 'command', requestId, tool, args };
    const startedAt = Date.now();

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        audit.error({
          event: 'command.timeout',
          requestId,
          cluster: this.info.name,
          tool,
          args,
          durationMs: COMMAND_TIMEOUT_MS,
        });
        reject(new Error(`Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, reject, timer, startedAt, tool, args });
      this.send(message);
    });
  }

  destroy(): void {
    clearInterval(this.pingInterval);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Agent disconnected'));
    }
    this.pending.clear();
  }
}

// ── AgentManager ──────────────────────────────────────────────────────────────

export class AgentManager {
  private agents = new Map<string, AgentConnection>();

  register(conn: AgentConnection): void {
    const existing = this.agents.get(conn.info.name);
    if (existing) {
      logger.warn({ cluster: conn.info.name }, 'Replacing existing connection for cluster');
      existing.destroy();
      existing.ws.terminate();
    }
    this.agents.set(conn.info.name, conn);
  }

  unregister(clusterName: string): void {
    const conn = this.agents.get(clusterName);
    if (conn) {
      conn.destroy();
      this.agents.delete(clusterName);
    }
  }

  get(clusterName: string): AgentConnection | undefined {
    return this.agents.get(clusterName);
  }

  list(): ClusterInfo[] {
    return Array.from(this.agents.values()).map((c) => ({ ...c.info }));
  }

  get size(): number {
    return this.agents.size;
  }
}
