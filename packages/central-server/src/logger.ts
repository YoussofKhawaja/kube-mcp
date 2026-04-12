import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'central-server' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/**
 * Structured audit logger — every entry has audit:true so logs can be
 * filtered and shipped to a separate sink (e.g. CloudWatch, Loki, Splunk).
 *
 * Audit events:
 *   agent.connected     — cluster agent authenticated and registered
 *   agent.disconnected  — cluster agent WebSocket closed
 *   auth.failed         — invalid agent or MCP client token
 *   command.success     — kubectl/helm command completed successfully
 *   command.failed      — kubectl/helm command returned an error
 *   command.timeout     — kubectl/helm command exceeded timeout
 */
export const audit = logger.child({ audit: true });
