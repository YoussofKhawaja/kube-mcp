function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Environment variable ${key} is required but not set`);
  return val;
}

export const config = {
  centralServerUrl: required('CENTRAL_SERVER_URL'),
  agentToken: required('AGENT_TOKEN'),
  clusterName: required('CLUSTER_NAME'),
  /** Set to "true" only in dev environments with self-signed certs. */
  insecureTls: process.env.INSECURE_TLS === 'true',
} as const;
