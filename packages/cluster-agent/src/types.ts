// Keep in sync with packages/central-server/src/types.ts

export type AgentMessage =
  | { type: 'register'; clusterName: string; version: string; kubectlVersion: string; helmVersion: string }
  | { type: 'response'; requestId: string; success: boolean; data?: string; error?: string }
  | { type: 'pong' };

export type ServerMessage =
  | { type: 'registered'; clusterName: string }
  | { type: 'error'; message: string }
  | { type: 'ping' }
  | CommandMessage;

export interface CommandMessage {
  type: 'command';
  requestId: string;
  tool: 'kubectl' | 'helm';
  args: string[];
}
