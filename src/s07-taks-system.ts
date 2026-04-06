#!/usr/bin/env node
/**
 * s07-taks-system.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy).
 *
 *   .tasks/
 *     task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *     task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *     task_3.json  {"id":3, "blockedBy":[2], ...}
 *
 *   Dependency resolution:
 *   +----------+     +----------+     +----------+
 *   | task 1   | --> | task 2   | --> | task 3   |
 *   | complete |     | blocked  |     | blocked  |
 *   +----------+     +----------+     +----------+
 *        |                ^
 *        +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
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
const TASKS_DIR = join(WORKDIR, '.tasks');
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// ---- TaskManager: CRUD with dependency graph, persisted as JSON files ----

interface Task {
  id: number;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  blockedBy: number[];
  owner: string;
}

class TaskManager {
  private _nextId = 1;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this._nextId = this.maxId() + 1;
  }

  private maxId(): number {
    if (!existsSync(this.dir)) return 0;
    const files = readdirSync(this.dir)
      .filter((f: string) => f.startsWith('task_') && f.endsWith('.json'))
      .map((f: string) => {
        const match = f.match(/^task_(\d+)\.json$/);
        return match ? parseInt(match[1], 10) : 0;
      });
    return files.length > 0 ? Math.max(...files) : 0;
  }

  private load(taskId: number): Task {
    const path = join(this.dir, `task_${taskId}.json`);
    if (!existsSync(path)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as Task;
  }

  private save(task: Task): void {
    const path = join(this.dir, `task_${task.id}.json`);
    writeFileSync(path, JSON.stringify(task, null, 2), 'utf-8');
  }

  create(subject: string, description = ''): string {
    const task: Task = {
      id: this._nextId,
      subject,
      description,
      status: 'pending',
      blockedBy: [],
      owner: '',
    };
    this.save(task);
    this._nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  update(
    taskId: number,
    status?: 'pending' | 'in_progress' | 'completed',
    addBlockedBy?: number[],
    removeBlockedBy?: number[]
  ): string {
    const task = this.load(taskId);

    if (status) {
      if (!['pending', 'in_progress', 'completed'].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
      if (status === 'completed') {
        this.clearDependency(taskId);
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (removeBlockedBy) {
      task.blockedBy = task.blockedBy.filter((id) => !removeBlockedBy.includes(id));
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    const files = readdirSync(this.dir).filter(
      (f: string) => f.startsWith('task_') && f.endsWith('.json')
    );
    for (const file of files) {
      const task = JSON.parse(readFileSync(join(this.dir, file), 'utf-8')) as Task;
      const idx = task.blockedBy.indexOf(completedId);
      if (idx !== -1) {
        task.blockedBy.splice(idx, 1);
        this.save(task);
      }
    }
  }

  listAll(): string {
    const files = readdirSync(this.dir)
      .filter((f: string) => f.startsWith('task_') && f.endsWith('.json'))
      .sort((a: string, b: string) => {
        const idA = parseInt(a.match(/^task_(\d+)\.json$/)?.[1] ?? '0', 10);
        const idB = parseInt(b.match(/^task_(\d+)\.json$/)?.[1] ?? '0', 10);
        return idA - idB;
      });

    if (files.length === 0) {
      return 'No tasks.';
    }

    const tasks = files.map(
      (f: string) => JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as Task
    );

    return tasks
      .map((t: Task) => {
        const marker =
          t.status === 'pending'
            ? '[ ]'
            : t.status === 'in_progress'
              ? '[>]'
              : t.status === 'completed'
                ? '[x]'
                : '[?]';
        const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(', ')})` : '';
        return `${marker} #${t.id}: ${t.subject}${blocked}`;
      })
      .join('\n');
  }
}

const TASKS = new TaskManager(TASKS_DIR);

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

// ---- Tool handlers ----

type ToolInput = Record<string, unknown>;

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command as string),
  read_file: (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file: (input) =>
    runEdit(input.path as string, input.old_text as string, input.new_text as string),
  task_create: (input) => TASKS.create(input.subject as string, input.description as string),
  task_update: (input) =>
    TASKS.update(
      input.task_id as number,
      input.status as 'pending' | 'in_progress' | 'completed' | undefined,
      input.addBlockedBy as number[] | undefined,
      input.removeBlockedBy as number[] | undefined
    ),
  task_list: () => TASKS.listAll(),
  task_get: (input) => TASKS.get(input.task_id as number),
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
    name: 'task_create',
    description: 'Create a new task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'task_update',
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'integer' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
        addBlockedBy: { type: 'array', items: { type: 'integer' } },
        removeBlockedBy: { type: 'array', items: { type: 'integer' } },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_list',
    description: 'List all tasks with status summary.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'task_get',
    description: 'Get full details of a task by ID.',
    input_schema: {
      type: 'object' as const,
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
];

type AssistantMessageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
>;

async function agentLoop(messages: MessageParam[]): Promise<AssistantMessageContent> {
  while (true) {
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
  prompt: '\x1b[36ms07 >> \x1b[0m',
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
