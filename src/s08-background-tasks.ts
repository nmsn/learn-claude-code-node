#!/usr/bin/env node
/**
 * s08-background-tasks.ts - Background Tasks
 *
 * Run commands in background threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *   Main thread                Background thread
 *   +-----------------+        +-----------------+
 *   | agent loop      |        | task executes   |
 *   | ...             |        | ...             |
 *   | [LLM call] <---+------- | enqueue(result) |
 *   |  ^drain queue  |        +-----------------+
 *   +-----------------+
 *
 *   Timeline:
 *   Agent ----[spawn A]----[spawn B]----[other work]----
 *                |              |
 *                v              v
 *             [A runs]      [B runs]        (parallel)
 *                |              |
 *                +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { randomUUID } from 'crypto';

loadEnv({ path: '.env.local', override: true });
loadEnv({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// ---- BackgroundManager: threaded execution + notification queue ----

interface BackgroundTask {
  status: 'running' | 'completed' | 'timeout' | 'error';
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private notificationQueue: Notification[] = [];

  run(command: string): string {
    const taskId = randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: 'running', result: null, command });
    this.executeInBackground(taskId, command);
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private executeInBackground(taskId: string, command: string): void {
    // Use setTimeout to simulate threading behavior in Node.js
    // In reality Node.js is single-threaded, but we can use child_process.spawn
    // for true parallel execution
    const proc = spawn(command, {
      shell: true,
      cwd: WORKDIR,
    });

    let output = '';

    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('close', (code: number | null) => {
      const result = output.trim().slice(0, 50000) || '(no output)';
      const status = code === 0 ? 'completed' : 'error';
      this.tasks.set(taskId, { status, result, command });

      const notification: Notification = {
        task_id: taskId,
        status,
        command: command.slice(0, 80),
        result: result.slice(0, 500),
      };

      this.notificationQueue.push(notification);
    });

    proc.on('error', (err: Error) => {
      const result = `Error: ${err.message}`;
      this.tasks.set(taskId, { status: 'error', result, command });

      this.notificationQueue.push({
        task_id: taskId,
        status: 'error',
        command: command.slice(0, 80),
        result: result.slice(0, 500),
      });
    });
  }

  check(taskId?: string): string {
    if (taskId) {
      const task = this.tasks.get(taskId);
      if (!task) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${task.status}] ${task.command.slice(0, 60)}\n${task.result ?? '(running)'}`;
    }

    if (this.tasks.size === 0) {
      return 'No background tasks.';
    }

    const lines: string[] = [];
    for (const [tid, task] of this.tasks) {
      lines.push(`${tid}: [${task.status}] ${task.command.slice(0, 60)}`);
    }
    return lines.join('\n');
  }

  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}

const BG = new BackgroundManager();

// ---- Tool implementations ----

function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
  const DANGEROUS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (DANGEROUS.some((d) => command.includes(d))) {
    return 'Error: Dangerous command blocked';
  }
  try {
    const out = execSync(command, {
      cwd: WORKDIR,
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (out as string).trim().slice(0, 50000) || '(no output)';
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'status' in e) {
      const err = e as { status: number; message: string };
      return err.message.slice(0, 50000);
    }
    return String(e).slice(0, 50000);
  }
}

function runRead(path: string, limit?: number): string {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, 'utf-8');
    const lines = content.split('\n');
    if (limit && limit < lines.length) {
      return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more)`;
    }
    return content.slice(0, 50000);
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function runWrite(path: string, content: string): string {
  try {
    const fp = safePath(path);
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, 'utf-8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    writeFileSync(fp, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

// ---- Tool handlers ----

type ToolInput = Record<string, unknown>;

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command as string),
  read_file: (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file: (input) =>
    runEdit(input.path as string, input.old_text as string, input.new_text as string),
  background_run: (input) => BG.run(input.command as string),
  check_background: (input) => BG.check(input.task_id as string | undefined),
};

const TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command (blocking).',
    input_schema: {
      type: 'object' as const,
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'background_run',
    description: 'Run command in background thread. Returns task_id immediately.',
    input_schema: {
      type: 'object' as const,
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'check_background',
    description: 'Check background task status. Omit task_id to list all.',
    input_schema: {
      type: 'object' as const,
      properties: { task_id: { type: 'string' } },
    },
  },
];

type AssistantMessageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
>;

async function agentLoop(messages: MessageParam[]): Promise<AssistantMessageContent> {
  while (true) {
    // Drain background notifications and inject as user message before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
      messages.push({
        role: 'user',
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    });

    const content = response.content as AssistantMessageContent;
    messages.push({ role: 'assistant', content });

    if (response.stop_reason !== 'tool_use') {
      return content;
    }

    const results: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
    }> = [];

    for (const block of content) {
      if (block.type === 'tool_use') {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (e: unknown) {
          output = `Error: ${e}`;
        }
        process.stdout.write(`\x1b[35m> ${block.name}:\x1b[0m\n`);
        process.stdout.write(`${String(output).slice(0, 200)}\n`);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    messages.push({ role: 'user', content: results });
  }
}

const rl = readline.createInterface({
  input: stdin,
  output: stdout,
  prompt: '\x1b[36ms08 >> \x1b[0m',
});

const history: MessageParam[] = [];

async function main() {
  for await (const query of rl) {
    if (query.trim().toLowerCase() in ['q', 'exit', '']) {
      break;
    }
    history.push({ role: 'user', content: query });
    const result = await agentLoop(history);

    for (const block of result) {
      if (block.type === 'text') {
        console.log(block.text);
      }
    }
    console.log();
    try {
      rl.prompt();
    } catch {
      // readline closed (non-interactive mode)
    }
  }
}

main();
