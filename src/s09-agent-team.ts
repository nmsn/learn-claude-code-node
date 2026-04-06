#!/usr/bin/env node
/**
 * s09-agent-team.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate thread. Communication via append-only inboxes.
 *
 *   .team/config.json                   .team/inbox/
 *   +----------------------------+      +------------------+
 *   | {"team_name": "default",   |      | alice.jsonl      |
 *   |  "members": [              |      | bob.jsonl        |
 *   |    {"name":"alice",        |      | lead.jsonl       |
 *   |     "role":"coder",        |      +------------------+
 *   |     "status":"idle"}       |
 *   |  ]}                        |      send_message("alice", "fix bug"):
 *   +----------------------------+        append to alice.jsonl
 *
 * Key insight: "Teammates that can talk to each other."
 */

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

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
const TEAM_DIR = join(WORKDIR, '.team');
const INBOX_DIR = join(TEAM_DIR, 'inbox');

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = new Set([
  'message',
  'broadcast',
  'shutdown_request',
  'shutdown_response',
  'plan_approval_response',
]);

// ---- MessageBus: JSONL inbox per teammate ----

interface Message {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

class MessageBus {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  send(
    sender: string,
    to: string,
    content: string,
    msgType: string = 'message',
    extra?: Record<string, unknown>
  ): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${[...VALID_MSG_TYPES].join(', ')}`;
    }
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
    };
    if (extra) {
      Object.assign(msg, extra);
    }
    const inboxPath = join(this.dir, `${to}.jsonl`);
    appendFileSync(inboxPath, JSON.stringify(msg) + '\n', 'utf-8');
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = join(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) {
      return [];
    }
    const content = readFileSync(inboxPath, 'utf-8').trim();
    if (!content) {
      return [];
    }
    const messages: Message[] = [];
    for (const line of content.split('\n')) {
      if (line.trim()) {
        messages.push(JSON.parse(line) as Message);
      }
    }
    // Drain the inbox
    writeFileSync(inboxPath, '', 'utf-8');
    return messages;
  }

  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, 'broadcast');
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// ---- TeammateManager: persistent named agents with config.json ----

interface Member {
  name: string;
  role: string;
  status: 'working' | 'idle' | 'shutdown';
}

interface TeamConfig {
  team_name: string;
  members: Member[];
}

interface BackgroundTask {
  status: 'running' | 'completed' | 'error';
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

class TeammateManager {
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, { status: string }> = new Map();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.configPath = join(dir, 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): TeamConfig {
    if (existsSync(this.configPath)) {
      return JSON.parse(readFileSync(this.configPath, 'utf-8')) as TeamConfig;
    }
    return { team_name: 'default', members: [] };
  }

  private saveConfig(): void {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  private findMember(name: string): Member | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  spawn(name: string, role: string, prompt: string): string {
    const member = this.findMember(name);
    if (member) {
      if (member.status !== 'idle' && member.status !== 'shutdown') {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = 'working';
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: 'working' });
    }
    this.saveConfig();

    // Spawn teammate in background (non-blocking)
    this.spawnTeammateThread(name, role, prompt);

    return `Spawned '${name}' (role: ${role})`;
  }

  private spawnTeammateThread(name: string, role: string, prompt: string): void {
    // Use setImmediate to not block the main thread
    // In a real implementation, this would use worker_threads
    setImmediate(async () => {
      await this.teammateLoop(name, role, prompt);
    });
    this.threads.set(name, { status: 'running' });
  }

  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: MessageParam[] = [{ role: 'user', content: prompt }];
    const tools = this.teammateTools();

    let iterations = 0;
    const maxIterations = 50;

    while (iterations < maxIterations) {
      iterations++;

      // Check inbox
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: 'user', content: JSON.stringify(msg) });
      }

      try {
        const response = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages,
          tools,
          max_tokens: 8000,
        });

        const content = response.content;
        messages.push({ role: 'assistant', content });

        if (response.stop_reason !== 'tool_use') {
          break;
        }

        const results: Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
        }> = [];

        for (const block of content) {
          if (block.type === 'tool_use') {
            const output = this.execTool(name, block.name, block.input as Record<string, unknown>);
            process.stdout.write(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}\n`);
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: String(output),
            });
          }
        }

        messages.push({ role: 'user', content: results });
      } catch (e) {
        process.stderr.write(`[${name}] Error: ${e}\n`);
        break;
      }
    }

    // Mark as idle when done
    const member = this.findMember(name);
    if (member && member.status !== 'shutdown') {
      member.status = 'idle';
      this.saveConfig();
    }
    this.threads.set(name, { status: 'stopped' });
  }

  private execTool(sender: string, toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case 'bash':
        return runBash(args.command as string);
      case 'read_file':
        return runRead(args.path as string);
      case 'write_file':
        return runWrite(args.path as string, args.content as string);
      case 'edit_file':
        return runEdit(args.path as string, args.old_text as string, args.new_text as string);
      case 'send_message':
        return BUS.send(
          sender,
          args.to as string,
          args.content as string,
          (args.msg_type as string) || 'message'
        );
      case 'read_inbox':
        return JSON.stringify(BUS.readInbox(sender), null, 2);
      default:
        return `Unknown tool: ${toolName}`;
    }
  }

  private teammateTools() {
    return [
      {
        name: 'bash',
        description: 'Run a shell command.',
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
          properties: { path: { type: 'string' } },
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
        name: 'send_message',
        description: 'Send message to a teammate.',
        input_schema: {
          type: 'object' as const,
          properties: {
            to: { type: 'string' },
            content: { type: 'string' },
            msg_type: {
              type: 'string',
              enum: [...VALID_MSG_TYPES],
            },
          },
          required: ['to', 'content'],
        },
      },
      {
        name: 'read_inbox',
        description: 'Read and drain your inbox.',
        input_schema: { type: 'object' as const, properties: {} },
      },
    ];
  }

  listAll(): string {
    if (!this.config.members.length) {
      return 'No teammates.';
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join('\n');
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// ---- BackgroundManager (from s08) ----

class BackgroundManager {
  private tasks: Map<string, BackgroundTask> = new Map();
  private notificationQueue: Notification[] = [];

  run(command: string): string {
    const taskId = Math.random().toString(36).slice(2, 10);
    this.tasks.set(taskId, { status: 'running', result: null, command });
    this.executeInBackground(taskId, command);
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  private executeInBackground(taskId: string, command: string): void {
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

      this.notificationQueue.push({
        task_id: taskId,
        status,
        command: command.slice(0, 80),
        result: result.slice(0, 500),
      });
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

// ---- Base tool implementations ----

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

// ---- Lead tool handlers ----

type ToolInput = Record<string, unknown>;

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command as string),
  read_file: (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file: (input) =>
    runEdit(input.path as string, input.old_text as string, input.new_text as string),
  spawn_teammate: (input) =>
    TEAM.spawn(input.name as string, input.role as string, input.prompt as string),
  list_teammates: () => TEAM.listAll(),
  send_message: (input) =>
    BUS.send(
      'lead',
      input.to as string,
      input.content as string,
      (input.msg_type as string) || 'message'
    ),
  read_inbox: () => JSON.stringify(BUS.readInbox('lead'), null, 2),
  broadcast: (input) => BUS.broadcast('lead', input.content as string, TEAM.memberNames()),
  background_run: (input) => BG.run(input.command as string),
  check_background: (input) => BG.check(input.task_id as string | undefined),
};

const TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command.',
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
    name: 'spawn_teammate',
    description: 'Spawn a persistent teammate that runs in its own thread.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string' },
        role: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['name', 'role', 'prompt'],
    },
  },
  {
    name: 'list_teammates',
    description: 'List all teammates with name, role, status.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'send_message',
    description: 'Send a message to a teammate inbox.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string' },
        content: { type: 'string' },
        msg_type: {
          type: 'string',
          enum: [...VALID_MSG_TYPES],
        },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'read_inbox',
    description: 'Read and drain the lead inbox.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'broadcast',
    description: 'Send a message to all teammates.',
    input_schema: {
      type: 'object' as const,
      properties: { content: { type: 'string' } },
      required: ['content'],
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
    // Check lead inbox for teammate messages
    const inbox = BUS.readInbox('lead');
    if (inbox.length > 0) {
      messages.push({
        role: 'user',
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
    }

    // Drain background notifications
    const notifs = BG.drainNotifications();
    if (notifs.length > 0) {
      const notifText = notifs.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
      messages.push({
        role: 'user',
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
    }

    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages,
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
  prompt: '\x1b[36ms09 >> \x1b[0m',
});

const history: MessageParam[] = [];

async function main() {
  for await (const query of rl) {
    if (query.trim().toLowerCase() in ['q', 'exit', '']) {
      break;
    }
    if (query.trim() === '/team') {
      console.log(TEAM.listAll());
      rl.prompt();
      continue;
    }
    if (query.trim() === '/inbox') {
      console.log(JSON.stringify(BUS.readInbox('lead'), null, 2));
      rl.prompt();
      continue;
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
      // readline closed
    }
  }
}

main();
