import { Agent } from './agent.js';
import { startHealthServer } from './health.js';
import { logger } from './logger.js';
import { runPreflight } from './preflight.js';

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT ?? '8080', 10);

startHealthServer(HEALTH_PORT);

const toolVersions = runPreflight();

const agent = new Agent(toolVersions);
agent.connect();

process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  agent.stop();
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  agent.stop();
  setTimeout(() => process.exit(0), 2000);
});
