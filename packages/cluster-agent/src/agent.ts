import WebSocket from 'ws';
import { config } from './config.js';
import { execute } from './executor.js';
import { logger } from './logger.js';
import { health } from './health.js';
import type { AgentMessage, ServerMessage } from './types.js';
import type { ToolVersions } from './preflight.js';

const AGENT_VERSION = '1.0.0';
const INITIAL_RECONNECT_MS = 5_000;
const MAX_RECONNECT_MS = 60_000;
/**
 * If no message arrives from the server within this window, assume the TCP
 * connection is half-open (dropped by a middlebox without FIN) and force a
 * reconnect. Must exceed the server's ping interval (30s) with margin.
 */
const SERVER_SILENCE_TIMEOUT_MS = 90_000;

export class Agent {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private readonly toolVersions: ToolVersions;
  private silenceWatchdog: NodeJS.Timeout | null = null;

  constructor(toolVersions: ToolVersions) {
    this.toolVersions = toolVersions;
  }

  connect(): void {
    const rawUrl = config.centralServerUrl.replace(/^http/, 'ws');
    const url = new URL('/agent', rawUrl).toString();

    const wsOptions: WebSocket.ClientOptions = {
      headers: { Authorization: `Bearer ${config.agentToken}` },
      ...(config.insecureTls ? { rejectUnauthorized: false } : {}),
    };

    if (config.insecureTls) {
      logger.warn('INSECURE_TLS=true — TLS verification disabled. Do not use in production.');
    }

    this.ws = new WebSocket(url, wsOptions);

    this.ws.on('open', () => {
      this.reconnectDelay = INITIAL_RECONNECT_MS;
      this.resetSilenceWatchdog();
      this.send({ type: 'register', clusterName: config.clusterName, version: AGENT_VERSION, kubectlVersion: this.toolVersions.kubectl, helmVersion: this.toolVersions.helm });
      logger.info({ cluster: config.clusterName }, 'Connected to central server — registering');
    });

    this.ws.on('message', async (raw) => {
      this.resetSilenceWatchdog();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        logger.error('Received invalid JSON from server');
        return;
      }
      await this.handleMessage(msg);
    });

    this.ws.on('close', (code, reason) => {
      this.clearSilenceWatchdog();
      this.ws = null;
      health.connected = false;
      if (!this.shouldReconnect) return;
      const delay = this.reconnectDelay;
      logger.warn({ code, reason: reason.toString(), nextRetryMs: delay }, 'Disconnected from central server');
      this.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
      setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      logger.error({ err: err.message }, 'WebSocket error');
    });
  }

  stop(): void {
    this.shouldReconnect = false;
    health.connected = false;
    this.clearSilenceWatchdog();
    this.ws?.close(1000, 'Agent stopping');
  }

  private resetSilenceWatchdog(): void {
    this.clearSilenceWatchdog();
    this.silenceWatchdog = setTimeout(() => {
      logger.warn(
        { timeoutMs: SERVER_SILENCE_TIMEOUT_MS },
        'No message from server within watchdog window — terminating stale connection',
      );
      this.ws?.terminate();
    }, SERVER_SILENCE_TIMEOUT_MS);
  }

  private clearSilenceWatchdog(): void {
    if (this.silenceWatchdog) {
      clearTimeout(this.silenceWatchdog);
      this.silenceWatchdog = null;
    }
  }

  private send(msg: AgentMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(msg: ServerMessage): Promise<void> {
    switch (msg.type) {
      case 'registered':
        health.connected = true;
        logger.info({ cluster: msg.clusterName }, 'Successfully registered');
        break;

      case 'ping':
        this.send({ type: 'pong' });
        break;

      case 'error':
        logger.error({ serverMessage: msg.message }, 'Server reported error');
        break;

      case 'command': {
        const { requestId, tool, args } = msg;
        logger.info({ requestId, tool, args }, 'Executing command');
        try {
          const data = await execute(msg);
          this.send({ type: 'response', requestId, success: true, data });
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          this.send({ type: 'response', requestId, success: false, error });
        }
        break;
      }
    }
  }
}
