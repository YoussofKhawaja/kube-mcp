import { spawn } from 'child_process';
import { logger } from './logger.js';
import type { CommandMessage } from './types.js';

// ── Read-only allowlists (mirrored from central-server for defence-in-depth) ──

const KUBECTL_READONLY_VERBS = new Set([
  'get', 'describe', 'logs', 'explain', 'api-resources', 'api-versions',
  'cluster-info', 'version', 'top', 'rollout', 'events', 'auth',
  'diff', 'kustomize', 'config',
]);

const ROLLOUT_ALLOWED  = new Set(['status', 'history']);
const AUTH_ALLOWED     = new Set(['can-i', 'whoami']);
const CONFIG_ALLOWED   = new Set(['view', 'get-contexts', 'current-context']);

const HELM_READONLY_VERBS = new Set([
  'list', 'ls', 'status', 'get', 'history', 'env', 'version',
  'show', 'search', 'template', 'lint',
]);

/** Flags that redirect traffic or inject credentials — blocked unconditionally. */
const BLOCKED_FLAGS = new Set([
  '--server', '-s', '--kubeconfig', '--token',
  '--certificate-authority', '--client-certificate', '--client-key',
  '--username', '--password', '--exec-command', '--exec-api-version',
]);

const MAX_OUTPUT_BYTES  = 2 * 1024 * 1024; // 2 MB
const COMMAND_TIMEOUT_MS = 55_000;

// ── Validation ─────────────────────────────────────────────────────────────────

function validateKubectl(args: string[]): string | null {
  if (args.length === 0) return 'Empty kubectl command';

  const verb = args[0]!.toLowerCase();
  if (!KUBECTL_READONLY_VERBS.has(verb))
    return `kubectl verb "${verb}" is not permitted — only read-only operations are allowed`;

  if (verb === 'rollout') {
    const sub = args[1]?.toLowerCase();
    if (!sub || !ROLLOUT_ALLOWED.has(sub))
      return `kubectl rollout "${sub ?? ''}" is not permitted — allowed: ${[...ROLLOUT_ALLOWED].join(', ')}`;
  }
  if (verb === 'auth') {
    const sub = args[1]?.toLowerCase();
    if (!sub || !AUTH_ALLOWED.has(sub))
      return `kubectl auth "${sub ?? ''}" is not permitted — allowed: ${[...AUTH_ALLOWED].join(', ')}`;
  }
  if (verb === 'config') {
    const sub = args[1]?.toLowerCase();
    if (!sub || !CONFIG_ALLOWED.has(sub))
      return `kubectl config "${sub ?? ''}" is not permitted — allowed: ${[...CONFIG_ALLOWED].join(', ')}`;
  }

  for (const arg of args) {
    if (BLOCKED_FLAGS.has(arg.split('=')[0]!))
      return `Flag "${arg}" is blocked for security reasons`;
  }
  return null;
}

function validateHelm(args: string[]): string | null {
  if (args.length === 0) return 'Empty helm command';

  const verb = args[0]!.toLowerCase();
  if (!HELM_READONLY_VERBS.has(verb))
    return `helm subcommand "${verb}" is not permitted — only read-only operations are allowed`;

  for (const arg of args) {
    if (BLOCKED_FLAGS.has(arg.split('=')[0]!))
      return `Flag "${arg}" is blocked for security reasons`;
  }
  return null;
}

// ── Execution ──────────────────────────────────────────────────────────────────

function runProcess(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      env: { ...process.env, KUBECONFIG: '' },
      timeout: COMMAND_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length <= MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
      } else if (!truncated) {
        truncated = true;
        stdout += chunk.toString().slice(0, MAX_OUTPUT_BYTES - stdout.length);
        stdout += '\n\n[output truncated at 2 MB]';
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString().slice(0, 4096);
    });

    proc.on('close', (code, signal) => {
      if (signal) { reject(new Error(`Process killed by signal ${signal}`)); return; }
      if (code === 0 || stdout) {
        resolve(stdout || stderr);
      } else {
        reject(new Error(stderr || `Process exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(
        err.message.includes('ENOENT')
          ? `"${binary}" binary not found in agent container`
          : err.message,
      ));
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function execute(cmd: CommandMessage): Promise<string> {
  const { tool, args, requestId } = cmd;
  const start = Date.now();

  if (tool === 'kubectl') {
    const err = validateKubectl(args);
    if (err) throw new Error(err);
  } else if (tool === 'helm') {
    const err = validateHelm(args);
    if (err) throw new Error(err);
  } else {
    throw new Error(`Unknown tool: ${tool}`);
  }

  try {
    const output = await runProcess(tool, args);
    logger.debug({ requestId, tool, args, durationMs: Date.now() - start }, 'Command completed');
    return output;
  } catch (err) {
    logger.error({ requestId, tool, args, durationMs: Date.now() - start, err }, 'Command failed');
    throw err;
  }
}
