#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// ---- 安全工具 ----

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
      return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more lines)`;
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
    return `Wrote ${content.length} bytes to ${path}`;
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

// ---- 工具调度映射 ----

type ToolInput = Record<string, unknown>;

const TOOL_HANDLERS: Record<string, (input: ToolInput) => string> = {
  bash: (input) => runBash(input.command as string),
  read_file: (input) => runRead(input.path as string, input.limit as number | undefined),
  write_file: (input) => runWrite(input.path as string, input.content as string),
  edit_file: (input) =>
    runEdit(input.path as string, input.old_text as string, input.new_text as string),
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
        const output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        process.stdout.write(`\x1b[35m> ${block.name}:\x1b[0m\n`);
        process.stdout.write(`${output.slice(0, 200)}\n`);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      }
    }

    messages.push({ role: 'user', content: results });
  }
}

const rl = readline.createInterface({
  input: stdin,
  output: stdout,
  prompt: '\x1b[36ms02 >> \x1b[0m',
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
