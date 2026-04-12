/**
 * Parse CLUSTER_TOKENS env var.
 * Expected format: JSON object  {"clusterName": "token", ...}
 * Internally inverted to Map<token, clusterName> for O(1) auth lookups.
 */
function parseClusterTokens(): Map<string, string> {
  const raw = process.env.CLUSTER_TOKENS;
  if (!raw) throw new Error('CLUSTER_TOKENS env var is required. Format: {"clusterName":"token",...}');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('CLUSTER_TOKENS must be valid JSON: {"clusterName":"token",...}');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CLUSTER_TOKENS must be a JSON object');
  }

  // Inverted map: token → clusterName (for fast lookup without iterating names)
  const tokenToCluster = new Map<string, string>();
  for (const [name, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token !== 'string' || token.length < 16) {
      throw new Error(`Token for cluster "${name}" must be a string of at least 16 characters`);
    }
    if (tokenToCluster.has(token)) {
      throw new Error(`Duplicate token detected — each cluster must have a unique token`);
    }
    tokenToCluster.set(token, name);
  }

  if (tokenToCluster.size === 0) throw new Error('CLUSTER_TOKENS must have at least one entry');

  return tokenToCluster;
}

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  /**
   * Map of token → clusterName.
   * Each cluster agent authenticates with its own unique token.
   * The server uses this to both authenticate and authorise the cluster name.
   */
  clusterTokens: parseClusterTokens(),
  /** Optional API key for MCP clients (Claude, VS Code). If unset, MCP endpoint is open. */
  mcpApiKey: process.env.MCP_API_KEY ?? null,
  nodeEnv: process.env.NODE_ENV ?? 'production',
} as const;
