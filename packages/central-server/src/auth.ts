import { timingSafeEqual } from 'crypto';
import { config } from './config.js';

/**
 * Constant-time string comparison padded to equal length so neither
 * the value nor its length is leaked via timing.
 */
function safeCompare(expected: string, provided: string): boolean {
  const eBuf = Buffer.from(expected);
  const pBuf = Buffer.from(provided);
  const len = Math.max(eBuf.length, pBuf.length);
  const ePadded = Buffer.alloc(len, 0);
  const pPadded = Buffer.alloc(len, 0);
  eBuf.copy(ePadded);
  pBuf.copy(pPadded);
  const equal = timingSafeEqual(ePadded, pPadded);
  return equal && eBuf.length === pBuf.length;
}

/**
 * Verify an agent's Bearer token and return the cluster name it is
 * authorised for, or null if the token is invalid.
 *
 * Iterates ALL registered tokens without early exit so that the
 * execution time does not leak which cluster matched (or whether any did).
 */
export function resolveAgentCluster(authHeader: string): string | null {
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);

  let matchedCluster: string | null = null;
  for (const [registeredToken, clusterName] of config.clusterTokens) {
    if (safeCompare(registeredToken, token)) {
      matchedCluster = clusterName; // no early break — iterate all
    }
  }
  return matchedCluster;
}

/** Verify the API key presented by MCP clients (Claude, VS Code). */
export function verifyMcpApiKey(key: string): boolean {
  if (!config.mcpApiKey) return true; // no key configured → open
  return safeCompare(config.mcpApiKey, key);
}
