import { randomUUID } from 'crypto';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AgentManager } from './agent-manager.js';
import { verifyMcpApiKey } from './auth.js';
import { logger } from './logger.js';

// ── Read-only allowlists ───────────────────────────────────────────────────────

const KUBECTL_READONLY_VERBS = new Set([
  'get', 'describe', 'logs', 'explain', 'api-resources', 'api-versions',
  'cluster-info', 'version', 'top', 'rollout', 'events', 'auth',
  'diff', 'kustomize', 'config',
]);

const HELM_READONLY_VERBS = new Set([
  'list', 'ls', 'status', 'get', 'history', 'env', 'version',
  'show', 'search', 'template', 'lint',
]);

// ── Input schemas (Zod — McpServer validates automatically) ───────────────────

const ClusterName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-zA-Z0-9\-.]+$/, 'Invalid cluster name');

const CommandArg = z.string().min(1).max(4096);

// ── Helpers ────────────────────────────────────────────────────────────────────

function toolError(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function toolText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Parse a command string into an argument array, respecting single and double quotes.
 */
function parseCommand(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const char of command.trim()) {
    if (inQuote) {
      if (char === quoteChar) { inQuote = false; }
      else { current += char; }
    } else if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (char === ' ' || char === '\t') {
      if (current.length > 0) { args.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

function validateKubectl(args: string[]): string | null {
  if (args.length === 0) return 'Empty command';
  if (args[0]?.toLowerCase() === 'kubectl') args.shift();
  if (args.length === 0) return 'No verb provided';

  const verb = args[0]!.toLowerCase();
  if (!KUBECTL_READONLY_VERBS.has(verb))
    return `Verb "${verb}" is not allowed — only read-only kubectl verbs are permitted`;
  return null;
}

function validateHelm(args: string[]): string | null {
  if (args.length === 0) return 'Empty command';
  if (args[0]?.toLowerCase() === 'helm') args.shift();
  if (args.length === 0) return 'No subcommand provided';

  const verb = args[0]!.toLowerCase();
  if (!HELM_READONLY_VERBS.has(verb))
    return `Subcommand "${verb}" is not allowed — only read-only helm subcommands are permitted`;
  return null;
}

// ── McpServer factory (one instance per Streamable HTTP session) ───────────────

function buildMcpServer(agentManager: AgentManager): McpServer {
  const server = new McpServer({ name: 'multi-cluster-mcp', version: '1.0.0' });

  // ── list_clusters ─────────────────────────────────────────────────────────

  server.registerTool(
    'list_clusters',
    {
      description: 'List all Kubernetes clusters currently connected to this MCP server.',
      inputSchema: {},
    },
    async () => {
      try {
        const clusters = agentManager.list();
        if (clusters.length === 0) return toolText('No clusters are currently connected.');
        const lines = clusters.map((c) => {
          const connectedAt = c.connectedAt instanceof Date ? c.connectedAt.toISOString() : String(c.connectedAt);
          const lastSeen = c.lastSeen instanceof Date ? c.lastSeen.toISOString() : String(c.lastSeen);
          return `  • ${c.name}  agent=${c.version}  kubectl=${c.kubectlVersion}  helm=${c.helmVersion}  connected=${connectedAt}  last-seen=${lastSeen}`;
        });
        return toolText(`Connected clusters (${clusters.length}):\n${lines.join('\n')}`);
      } catch (e: unknown) {
        logger.error({ err: e instanceof Error ? e.message : String(e) }, 'list_clusters handler failed');
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── kubectl ───────────────────────────────────────────────────────────────

  server.registerTool(
    'kubectl',
    {
      description: [
        'Run any read-only kubectl command against a connected cluster.',
        'Provide arguments WITHOUT the "kubectl" prefix.',
        '',
        `Allowed verbs: ${[...KUBECTL_READONLY_VERBS].join(', ')}`,
        '',
        'Examples:',
        '  get pods -n kube-system -o wide',
        '  describe deployment nginx -n default',
        '  logs my-pod -n app --tail=100 --previous',
        '  top pods -A',
        '  get nodes -o jsonpath=\'{.items[*].metadata.name}\'',
        '  api-resources --namespaced=true',
        '  rollout history deployment/nginx -n default',
        '  auth can-i list pods --all-namespaces',
        '  events -n default --for=pod/my-pod',
        '  get crd',
        '  explain deployment.spec.template',
      ].join('\n'),
      inputSchema: {
        cluster: ClusterName.describe('Cluster name as shown by list_clusters'),
        command: CommandArg.describe('kubectl arguments WITHOUT the "kubectl" prefix'),
      },
    },
    async ({ cluster, command }) => {
      const agent = agentManager.get(cluster);
      if (!agent) return toolError(`Cluster "${cluster}" is not connected.`);

      const args = parseCommand(command);
      const err = validateKubectl(args);
      if (err) return toolError(err);

      try {
        const result = await agent.executeCommand('kubectl', args);
        return toolText(result || '(no output)');
      } catch (e: unknown) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── helm ──────────────────────────────────────────────────────────────────

  server.registerTool(
    'helm',
    {
      description: [
        'Run any read-only helm command against a connected cluster.',
        'Provide arguments WITHOUT the "helm" prefix.',
        '',
        `Allowed subcommands: ${[...HELM_READONLY_VERBS].join(', ')}`,
        '',
        'Examples:',
        '  list -A',
        '  status my-release -n default',
        '  get values my-release -n monitoring',
        '  get manifest my-release -n default',
        '  history my-release -n default',
        '  show chart oci://registry-1.docker.io/bitnamicharts/nginx',
        '  search repo prometheus',
        '  template my-chart ./my-chart --values values.yaml',
      ].join('\n'),
      inputSchema: {
        cluster: ClusterName.describe('Cluster name as shown by list_clusters'),
        command: CommandArg.describe('helm arguments WITHOUT the "helm" prefix'),
      },
    },
    async ({ cluster, command }) => {
      const agent = agentManager.get(cluster);
      if (!agent) return toolError(`Cluster "${cluster}" is not connected.`);

      const args = parseCommand(command);
      const err = validateHelm(args);
      if (err) return toolError(err);

      try {
        const result = await agent.executeCommand('helm', args);
        return toolText(result || '(no output)');
      } catch (e: unknown) {
        return toolError(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}

// ── Express router ─────────────────────────────────────────────────────────────

export function createMcpRouter(agentManager: AgentManager): Router {
  const router = Router();
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const mcpAuth = (req: Request, res: Response, next: NextFunction): void => {
    const key =
      (req.query['api_key'] as string | undefined) ??
      (req.headers['x-api-key'] as string | undefined) ??
      (req.headers['authorization'] ?? '').replace(/^Bearer /, '');

    if (!verifyMcpApiKey(key)) {
      logger.warn({ path: req.path, ip: req.ip }, 'MCP client auth failed');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  // POST /mcp — new session init or message to existing session
  router.post('/mcp', mcpAuth, express.json(), async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.handleRequest(req, res, req.body);
      return;
    }

    if (!isInitializeRequest(req.body)) {
      res.status(400).json({ error: 'Expected MCP initialize request' });
      return;
    }

    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = buildMcpServer(agentManager);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET /mcp — SSE stream for an existing session
  router.get('/mcp', mcpAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
  });

  // DELETE /mcp — terminate a session
  router.delete('/mcp', mcpAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    await sessions.get(sessionId)!.handleRequest(req, res);
  });

  return router;
}
