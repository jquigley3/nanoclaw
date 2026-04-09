/**
 * NanoClaw Agent Runner — own agentic loop, no Claude Code SDK.
 *
 * Uses @anthropic-ai/sdk directly against ANTHROPIC_BASE_URL (LiteLLM → Ollama).
 * No login, no OAuth, no Anthropic credentials required.
 *
 * Input:  JSON on stdin (ContainerInput)
 * Output: OUTPUT_START/END_MARKER-wrapped ContainerOutput JSON on stdout
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const HISTORY_FILE = '/workspace/group/conversation_history.json';

const IPC_POLL_MS = 500;
const MAX_TOOL_ITERATIONS = 20;
const MAX_HISTORY_PAIRS = 10; // keep last 10 user/assistant exchanges

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface ConversationHistory {
  messages: Anthropic.MessageParam[];
}

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR).filter(f => f.endsWith('.json')).sort();
    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) messages.push(data.text as string);
      } catch {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch {
    return [];
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

function loadHistory(): Anthropic.MessageParam[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const data: ConversationHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    return data.messages ?? [];
  } catch {
    return [];
  }
}

function saveHistory(messages: Anthropic.MessageParam[]): void {
  try {
    // Keep only the last MAX_HISTORY_PAIRS pairs (user + assistant each)
    const trimmed = messages.slice(-(MAX_HISTORY_PAIRS * 2));
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ messages: trimmed }, null, 2));
  } catch (err) {
    log(`Failed to save history: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description:
      'Run a bash command and return its stdout+stderr. Use for reading files, checking state, running scripts. Timeout: 30s.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to the user immediately while still processing. Use for progress updates or to deliver multiple messages.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Message text to send' },
      },
      required: ['text'],
    },
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a recurring or one-time task. context_mode: "group" (uses chat history) or "isolated" (fresh session).',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'What the agent should do when the task runs' },
        schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
        schedule_value: {
          type: 'string',
          description: 'cron expression | milliseconds | local ISO timestamp (no Z)',
        },
        context_mode: { type: 'string', enum: ['group', 'isolated'] },
        target_group_jid: { type: 'string', description: 'Main group only: JID to schedule for' },
        script: {
          type: 'string',
          description: 'Optional bash script; last line must be JSON {wakeAgent:bool,data?:any}',
        },
      },
      required: ['prompt', 'schedule_type', 'schedule_value'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List scheduled tasks for this group.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'pause_task',
    description: 'Pause a scheduled task.',
    input_schema: {
      type: 'object' as const,
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'resume_task',
    description: 'Resume a paused task.',
    input_schema: {
      type: 'object' as const,
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_task',
    description: 'Cancel and delete a scheduled task.',
    input_schema: {
      type: 'object' as const,
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'register_group',
    description: 'Register a new chat/group. Main group only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        jid: { type: 'string', description: 'Chat JID' },
        name: { type: 'string', description: 'Display name' },
        folder: { type: 'string', description: 'Channel-prefixed folder, e.g. whatsapp_family-chat' },
        trigger: { type: 'string', description: 'Trigger word, e.g. @Andy' },
        requiresTrigger: { type: 'boolean' },
      },
      required: ['jid', 'name', 'folder', 'trigger'],
    },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { chatJid: string; groupFolder: string; isMain: boolean },
): string {
  switch (name) {
    case 'bash': {
      const command = input.command as string;
      try {
        const out = execSync(command, {
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 512 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return out.trim() || '(no output)';
      } catch (err: unknown) {
        const e = err as { status?: number; stderr?: string; message?: string };
        const stderr = (e.stderr ?? '').trim();
        return `Exit ${e.status ?? '?'}${stderr ? `: ${stderr}` : `: ${e.message ?? 'unknown error'}`}`;
      }
    }

    case 'send_message': {
      writeIpcFile(MESSAGES_DIR, {
        type: 'message',
        chatJid: ctx.chatJid,
        text: input.text,
        groupFolder: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return 'Message sent.';
    }

    case 'schedule_task': {
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const targetJid =
        ctx.isMain && input.target_group_jid ? (input.target_group_jid as string) : ctx.chatJid;
      writeIpcFile(TASKS_DIR, {
        type: 'schedule_task',
        taskId,
        prompt: input.prompt,
        script: input.script,
        schedule_type: input.schedule_type,
        schedule_value: input.schedule_value,
        context_mode: input.context_mode ?? 'group',
        targetJid,
        createdBy: ctx.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return `Task ${taskId} scheduled.`;
    }

    case 'list_tasks': {
      const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
      if (!fs.existsSync(tasksFile)) return 'No tasks found.';
      try {
        const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8')) as Array<{
          id: string;
          prompt: string;
          schedule_type: string;
          schedule_value: string;
          status: string;
          next_run: string | null;
          groupFolder: string;
        }>;
        const visible = ctx.isMain
          ? tasks
          : tasks.filter(t => t.groupFolder === ctx.groupFolder);
        if (!visible.length) return 'No tasks found.';
        return visible
          .map(
            t =>
              `[${t.id}] ${t.prompt.slice(0, 60)} (${t.schedule_type}: ${t.schedule_value}) - ${t.status}`,
          )
          .join('\n');
      } catch {
        return 'Error reading tasks.';
      }
    }

    case 'pause_task':
    case 'resume_task':
    case 'cancel_task': {
      const action = name.replace('_task', '');
      writeIpcFile(TASKS_DIR, {
        type: `${action}_task`,
        taskId: input.task_id,
        groupFolder: ctx.groupFolder,
        isMain: String(ctx.isMain),
        timestamp: new Date().toISOString(),
      });
      return `Task ${input.task_id as string} ${action} requested.`;
    }

    case 'register_group': {
      if (!ctx.isMain) return 'Only the main group can register new groups.';
      writeIpcFile(TASKS_DIR, {
        type: 'register_group',
        jid: input.jid,
        name: input.name,
        folder: input.folder,
        trigger: input.trigger,
        requiresTrigger: input.requiresTrigger ?? false,
        timestamp: new Date().toISOString(),
      });
      return `Group "${input.name as string}" registered.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function runQuery(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  prompt: string,
  history: Anthropic.MessageParam[],
  ctx: { chatJid: string; groupFolder: string; isMain: boolean },
): Promise<{ result: string | null; updatedHistory: Anthropic.MessageParam[] }> {
  // Build message list: history + current prompt
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: 'user', content: prompt },
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    log(`Iteration ${i + 1}: calling model (${messages.length} messages in context)`);

    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      // Tools disabled: smaller Ollama models (llama3.2:3b) emit tool-call tokens
      // that LiteLLM cannot convert back to Anthropic tool_use blocks, resulting
      // in empty responses. Re-enable when using a model with verified tool support.
      // tools: TOOLS,
      messages,
    });

    const blockTypes = response.content.map(b => b.type).join(',');
    log(`stop_reason=${response.stop_reason}, blocks=${response.content.length} [${blockTypes}]`);

    // Append assistant response to working message list
    messages.push({ role: 'assistant', content: response.content });

    // Check for tool_use blocks regardless of stop_reason — some LiteLLM/Ollama
    // combinations return stop_reason='end_turn' even when tool calls are present.
    const hasToolUse = response.content.some(b => b.type === 'tool_use');

    if ((response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') && !hasToolUse) {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      const text = textBlock?.text?.trim() ?? null;
      log(`End turn result: ${text ? text.slice(0, 100) : '(empty)'}`);
      return { result: text || null, updatedHistory: messages };
    }

    if (response.stop_reason === 'tool_use' || hasToolUse) {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        log(`Tool: ${block.name}(${JSON.stringify(block.input).slice(0, 120)})`);
        const result = executeTool(
          block.name,
          block.input as Record<string, unknown>,
          ctx,
        );
        log(`Result: ${result.slice(0, 200)}`);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // Unexpected stop reason — return whatever text we have
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    return { result: textBlock?.text ?? null, updatedHistory: messages };
  }

  log('Max iterations reached');
  return {
    result: 'I ran out of steps to complete this request.',
    updatedHistory: messages,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: Buffer | string) => { data += typeof chunk === 'string' ? chunk : chunk.toString('utf8'); });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;
  try {
    const raw = await readStdin();
    containerInput = JSON.parse(raw) as ContainerInput;
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Input received for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // LiteLLM endpoint — required
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  if (!baseURL) {
    writeOutput({ status: 'error', result: null, error: 'ANTHROPIC_BASE_URL not set — cannot reach LiteLLM' });
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY ?? 'sk-local';
  const model = process.env.LITELLM_MODEL ?? 'claude-sonnet-4-6';

  const client = new Anthropic({ apiKey, baseURL });

  const assistantName = containerInput.assistantName ?? 'Andy';
  const now = new Date().toLocaleString('en-GB', { timeZone: process.env.TZ ?? 'UTC' });

  const systemPrompt = [
    `You are ${assistantName}, a helpful personal assistant running on a home server.`,
    `You are responding to a WhatsApp message. Keep replies concise and conversational.`,
    `Current time: ${now}`,
    `Group: ${containerInput.groupFolder} | Main: ${containerInput.isMain}`,
    '',
    'Available tools:',
    '  bash           — run shell commands (files, scripts, system info)',
    '  send_message   — send an intermediate message to the user without ending the conversation',
    '  schedule_task  — schedule a recurring or one-time task',
    '  list_tasks     — list scheduled tasks',
    '  pause_task / resume_task / cancel_task — manage tasks',
    '  register_group — register a new WhatsApp group (main group only)',
    '',
    'Use tools when the request benefits from it. For simple questions, just reply directly.',
  ].join('\n');

  const ctx = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isMain: containerInput.isMain,
  };

  // Set up IPC
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Load conversation history
  let history = loadHistory();
  log(`Loaded ${history.length} history messages`);

  let prompt = containerInput.isScheduledTask
    ? `[SCHEDULED TASK]\n\n${containerInput.prompt}`
    : containerInput.prompt;

  // Drain any pending IPC messages into initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) prompt += '\n' + pending.join('\n');

  // Query loop — keeps container alive for follow-up messages
  while (true) {
    log(`Running query (prompt: ${prompt.length} chars)`);

    let result: string | null;
    let updatedHistory: Anthropic.MessageParam[];
    try {
      ({ result, updatedHistory } = await runQuery(client, model, systemPrompt, prompt, history, ctx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${msg}`);
      writeOutput({ status: 'error', result: null, error: msg });
      process.exit(1);
    }

    // Persist updated history
    history = updatedHistory;
    saveHistory(history);

    writeOutput({ status: 'success', result });
    log(`Query done. Result length: ${result?.length ?? 0}`);

    // Wait for next IPC message or close sentinel
    const nextMessage = await new Promise<string | null>(resolve => {
      const poll = (): void => {
        if (shouldClose()) { resolve(null); return; }
        const msgs = drainIpcInput();
        if (msgs.length > 0) { resolve(msgs.join('\n')); return; }
        setTimeout(poll, IPC_POLL_MS);
      };
      poll();
    });

    if (nextMessage === null) {
      log('Close sentinel received, exiting');
      break;
    }

    log(`Follow-up message received (${nextMessage.length} chars)`);
    prompt = nextMessage;
  }
}

main().catch(err => {
  console.error('[agent-runner] Fatal:', err);
  process.exit(1);
});
