/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Supports two runtimes selected by CONTAINER_RUNTIME env var:
 *   'docker' (default) — docker run, works locally on macOS/Linux
 *   'k8s'              — kubectl Job dispatch, targets k3s cluster
 */
import { execSync } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

// ─── Kubernetes Job runtime ───────────────────────────────────────────────────

export interface K8sJobSpec {
  jobName: string;
  namespace: string;
  image: string;
  nodeName?: string; // nodeSelector: kubernetes.io/hostname
  env: Record<string, string>;
  /** hostPath volumes: key = mount path inside container, value = host path */
  mounts: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
  /** Wall-clock deadline for the Job (seconds). Maps to activeDeadlineSeconds. */
  timeoutSeconds: number;
}

/**
 * Build a Kubernetes Job manifest as a plain object (serialisable to YAML/JSON).
 * The Job runs the nanoclaw-agent image as a single Pod, reads input from a
 * file pre-written to the IPC hostPath directory, and writes output there too.
 */
export function buildK8sJobManifest(spec: K8sJobSpec): object {
  const volumes: object[] = [];
  const volumeMounts: object[] = [];

  spec.mounts.forEach((m, i) => {
    const volName = `vol-${i}`;
    volumes.push({
      name: volName,
      hostPath: { path: m.hostPath, type: 'DirectoryOrCreate' },
    });
    volumeMounts.push({
      name: volName,
      mountPath: m.containerPath,
      readOnly: m.readonly,
    });
  });

  const envList = Object.entries(spec.env).map(([name, value]) => ({
    name,
    value,
  }));

  const manifest: Record<string, unknown> = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: spec.jobName,
      namespace: spec.namespace,
      labels: { app: 'nanoclaw-agent' },
    },
    spec: {
      ttlSecondsAfterFinished: 300, // auto-cleanup 5 min after completion
      activeDeadlineSeconds: spec.timeoutSeconds,
      backoffLimit: 0, // no retries — each run is a single agent invocation
      template: {
        metadata: { labels: { app: 'nanoclaw-agent', job: spec.jobName } },
        spec: {
          restartPolicy: 'Never',
          ...(spec.nodeName
            ? {
                nodeSelector: {
                  'kubernetes.io/hostname': spec.nodeName,
                },
              }
            : {}),
          containers: [
            {
              name: 'agent',
              image: spec.image,
              imagePullPolicy: 'Always',
              env: envList,
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
  return manifest;
}

/** Delete a k8s Job by name (best-effort, used in cleanup). */
export function deleteK8sJob(jobName: string, namespace: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(jobName)) {
    throw new Error(`Invalid k8s job name: ${jobName}`);
  }
  execSync(`kubectl delete job ${jobName} -n ${namespace} --ignore-not-found`, {
    stdio: 'pipe',
  });
}

/** Kill orphaned nanoclaw Jobs left from a previous crashed orchestrator run. */
export function cleanupOrphanK8sJobs(namespace: string): void {
  try {
    const out = execSync(
      `kubectl get jobs -n ${namespace} -l app=nanoclaw-agent -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const names = out.trim().split(/\s+/).filter(Boolean);
    for (const name of names) {
      try {
        deleteK8sJob(name, namespace);
      } catch {
        /* already gone */
      }
    }
    if (names.length > 0) {
      logger.info({ count: names.length, names }, 'Cleaned up orphan k8s Jobs');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphan k8s Jobs');
  }
}
