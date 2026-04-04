#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { config as loadEnv } from 'dotenv';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync } from 'child_process';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

loadEnv({ path: '.env.local', override: true });
loadEnv({ override: true }); // .env as fallback

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID!;
const CWD = process.cwd();
const SYSTEM = `You are a coding agent at ${CWD}. Use bash to solve tasks. Act, don't explain.`;

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
];

const DANGEROUS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];

function runBash(command: string): string {
  if (DANGEROUS.some((d) => command.includes(d))) {
    return 'Error: Dangerous command blocked';
  }
  try {
    const out = execSync(command, {
      cwd: CWD,
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

type AssistantMessageContent = Array<
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
>;

async function agentLoop(messages: MessageParam[]): Promise<AssistantMessageContent | string> {
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
        const command = block.input.command as string;
        process.stdout.write(`\x1b[33m$ ${command}\x1b[0m\n`);
        const output = runBash(command);
        process.stdout.write(`${output.slice(0, 200)}\n`);
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
  prompt: '\x1b[36ms01 >> \x1b[0m',
});

const history: MessageParam[] = [];

async function main() {
  for await (const query of rl) {
    if (query.trim().toLowerCase() in ['q', 'exit', '']) {
      break;
    }
    history.push({ role: 'user', content: query });
    const result = await agentLoop(history);

    if (typeof result === 'object') {
      for (const block of result) {
        if (block.type === 'text') {
          console.log(block.text);
        }
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
