#!/usr/bin/env node
/**
 * s06_context_compact.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *   Every turn:
 *   +------------------+
 *   | Tool call result |
 *   +------------------+
 *           |
 *           v
 *   [Layer 1: micro_compact]        (silent, every turn)
 *     Replace non-read_file tool_result content older than last 3
 *     with "[Previous: used {tool_name}]"
 *           |
 *           v
 *   [Check: tokens > 50000?]
 *      |               |
 *      no              yes
 *      |               |
 *      v               v
 *   continue    [Layer 2: auto_compact]
 *                 Save full transcript to .transcripts/
 *                 Ask LLM to summarize conversation.
 *                 Replace all messages with [summary].
 *                       |
 *                       v
 *               [Layer 3: compact tool]
 *                 Model calls compact -> immediate summarization.
 *                 Same as auto, triggered manually.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = join(WORKDIR, '.transcripts');
const KEEP_RECENT = 3;
const PRESERVE_RESULT_TOOLS = new Set(['read_file']);

// ---- Token estimation ----

function estimateTokens(messages: MessageParam[]): number {
  // Rough token count: ~4 chars per token
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// ---- Layer 1: micro_compact ----

interface ToolResultPart {
  type: 'tool_result';
  tool_use_id?: string;
  content: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function microCompact(messages: MessageParam[]): void {
  // Collect all tool_result entries with their indices
  const toolResults: Array<{ msgIdx: number; partIdx: number; result: ToolResultPart }> = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx] as ToolResultPart;
        if (part.type === 'tool_result') {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  // Build tool_name map from assistant messages
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as ToolUseBlock;
        if (b.type === 'tool_use') {
          toolNameMap.set(b.id, b.name);
        }
      }
    }
  }

  // Clear old results (keep last KEEP_RECENT)
  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const { result } of toClear) {
    if (typeof result.content !== 'string' || result.content.length <= 100) continue;

    const toolId = result.tool_use_id ?? '';
    const toolName = toolNameMap.get(toolId) ?? 'unknown';

    if (PRESERVE_RESULT_TOOLS.has(toolName)) continue;

    result.content = `[Previous: used ${toolName}]`;
  }
}

// ---- Layer 2: auto_compact ----

async function autoCompactAsync(messages: MessageParam[]): Promise<MessageParam[]> {
  // Save full transcript to disk
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const transcriptContent = messages.map((msg) => JSON.stringify(msg, null, 0)).join('\n');
  writeFileSync(transcriptPath, transcriptContent, 'utf-8');
  console.log(`[transcript saved: ${transcriptPath}]`);

  // Ask LLM to summarize
  const conversationText = JSON.stringify(messages).slice(-80000);
  const response = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: 'user',
        content:
          'Summarize this conversation for continuity. Include: ' +
          '1) What was accomplished, 2) Current state, 3) Key decisions made. ' +
          'Be concise but preserve critical details.\n\n' +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary =
    response.content.find((b) => b.type === 'text')?.type === 'text'
      ? (response.content[0] as { type: 'text'; text: string }).text
      : 'No summary generated.';

  return [
    {
      role: 'user',
      content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}`,
    },
  ];
}

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

// ---- Tool handlers and definitions ----

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
  {
    name: 'compact',
    description: 'Trigger manual conversation compression.',
    input_schema: {
      type: 'object' as const,
      properties: {
        focus: {
          type: 'string',
          description: 'What to preserve in the summary',
        },
      },
    },
  },
];

type AssistantMessageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
>;

async function agentLoop(messages: MessageParam[]): Promise<AssistantMessageContent> {
  while (true) {
    // Layer 1: micro_compact before each LLM call
    microCompact(messages);

    // Layer 2: auto_compact if token estimate exceeds threshold
    if (estimateTokens(messages) > THRESHOLD) {
      console.log('[auto_compact triggered]');
      messages.splice(0, messages.length, ...(await autoCompactAsync(messages)));
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
    let manualCompact = false;

    for (const block of content) {
      if (block.type === 'tool_use') {
        if (block.name === 'compact') {
          manualCompact = true;
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Compressing...',
          });
        } else {
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
    }

    messages.push({ role: 'user', content: results });

    // Layer 3: manual compact triggered by the compact tool
    if (manualCompact) {
      console.log('[manual compact]');
      messages.splice(0, messages.length, ...(await autoCompactAsync(messages)));
      return [
        {
          type: 'text',
          text: '[Conversation compressed. Type continue to keep working.]',
        },
      ];
    }
  }
}

const rl = readline.createInterface({
  input: stdin,
  output: stdout,
  prompt: '\x1b[36ms06 >> \x1b[0m',
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
