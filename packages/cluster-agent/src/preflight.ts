import { execFileSync } from 'child_process';
import { logger } from './logger.js';

export interface ToolVersions {
  kubectl: string;
  helm: string;
}

function getKubectlVersion(): string {
  try {
    const raw = execFileSync('kubectl', ['version', '--client', '--output=json'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const parsed = JSON.parse(raw) as { clientVersion?: { gitVersion?: string } };
    return parsed.clientVersion?.gitVersion ?? 'unknown';
  } catch (err: unknown) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      'kubectl not found or not executable — cannot start agent',
    );
    process.exit(1);
  }
}

function getHelmVersion(): string {
  try {
    const raw = execFileSync('helm', ['version', '--short'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return raw.trim();
  } catch (err: unknown) {
    logger.fatal(
      { err: err instanceof Error ? err.message : String(err) },
      'helm not found or not executable — cannot start agent',
    );
    process.exit(1);
  }
}

/**
 * Verify that kubectl and helm are present and executable.
 * Logs the versions and exits the process if either binary is missing.
 */
export function runPreflight(): ToolVersions {
  const kubectl = getKubectlVersion();
  const helm = getHelmVersion();

  logger.info({ kubectl, helm }, 'Preflight check passed');

  return { kubectl, helm };
}
