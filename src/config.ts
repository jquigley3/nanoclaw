import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'CONTAINER_RUNTIME',
  'K8S_NAMESPACE',
  'K8S_NODE_BEELINK',
  'K8S_NODE_NUC',
  'LITELLM_BASE_URL',
  'LITELLM_API_KEY',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// In k8s mode, image is pulled from the in-cluster registry built by kaniko.
// In docker mode, image must be built locally with ./container/build.sh.
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE ||
  (process.env.CONTAINER_RUNTIME === 'k8s'
    ? '192.168.2.11:32500/nanoclaw-agent:latest'
    : 'nanoclaw-agent:latest');
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;

// Container runtime: 'docker' (default) or 'k8s' (dispatch as Kubernetes Jobs)
export const CONTAINER_RUNTIME =
  process.env.CONTAINER_RUNTIME || envConfig.CONTAINER_RUNTIME || 'docker';

// Kubernetes configuration (only used when CONTAINER_RUNTIME=k8s)
export const K8S_NAMESPACE =
  process.env.K8S_NAMESPACE || envConfig.K8S_NAMESPACE || 'nanoclaw';
// Node names in the k3s cluster — used for nodeSelector
export const K8S_NODE_BEELINK =
  process.env.K8S_NODE_BEELINK || envConfig.K8S_NODE_BEELINK || 'beelink';
export const K8S_NODE_NUC =
  process.env.K8S_NODE_NUC || envConfig.K8S_NODE_NUC || 'intel-nuc';

// LiteLLM proxy — Anthropic-compatible endpoint routing to local Ollama.
// When set, containers use this as ANTHROPIC_BASE_URL instead of OneCLI.
export const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL || envConfig.LITELLM_BASE_URL;
// LiteLLM API key (used as ANTHROPIC_API_KEY inside containers; LiteLLM ignores it)
export const LITELLM_API_KEY =
  process.env.LITELLM_API_KEY || envConfig.LITELLM_API_KEY || 'sk-local';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
