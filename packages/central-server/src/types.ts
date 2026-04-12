// ── Protocol types (keep in sync with cluster-agent/src/types.ts) ─────────────

// Messages: Agent → Central Server
export type AgentMessage =
  | { type: 'register'; clusterName: string; version: string; kubectlVersion: string; helmVersion: string }
  | { type: 'response'; requestId: string; success: boolean; data?: string; error?: string }
  | { type: 'pong' };

// Messages: Central Server → Agent
export type ServerMessage =
  | { type: 'registered'; clusterName: string }
  | { type: 'error'; message: string }
  | { type: 'ping' }
  | CommandMessage;

export interface CommandMessage {
  type: 'command';
  requestId: string;
  /** Which binary to run on the agent side. */
  tool: 'kubectl' | 'helm';
  /**
   * Argument list — does NOT include the binary name itself.
   * e.g. ['get', 'pods', '-n', 'kube-system', '-o', 'wide']
   */
  args: string[];
}

export interface ClusterInfo {
  name: string;
  connectedAt: Date;
  lastSeen: Date;
  version: string;
  kubectlVersion: string;
  helmVersion: string;
}
