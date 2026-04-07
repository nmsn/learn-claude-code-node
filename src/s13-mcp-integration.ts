#!/usr/bin/env node
/**
 * s13-mcp-integration.ts - MCP Server + Client
 *
 * MCP Server: exposes local tools (bash, read_file, write_file, edit_file) via stdio
 * MCP Client: calls external MCP servers defined in .mcp/servers.json
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { Client } from '@modelcontextprotocol/sdk/client/index.js'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'; // eslint-disable-line @typescript-eslint/no-unused-vars
import * as readline from 'readline'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { stdin, stdout } from 'process'; // eslint-disable-line @typescript-eslint/no-unused-vars
import { execSync } from 'child_process';
import * as fs from 'fs';
import { resolve, dirname, join, isAbsolute } from 'path';

const WORKDIR = process.cwd();
const MCP_CONFIG_PATH = join(WORKDIR, '.mcp', 'servers.json'); // eslint-disable-line @typescript-eslint/no-unused-vars

const DANGEROUS_COMMANDS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ServerConfig {
  name: string;
  command: string;
  args: string[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface ServersConfig {
  servers: ServerConfig[];
}

function safePath(p: string): string {
  const absPath = isAbsolute(p) ? p : join(WORKDIR, p);
  const resolved = resolve(WORKDIR, absPath);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runBash(command: string): string {
  if (DANGEROUS_COMMANDS.some((d) => command.includes(d))) {
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runRead(path: string, limit?: number): string {
  try {
    const fp = safePath(path);
    const lines = fs.readFileSync(fp, 'utf-8').split('\n');
    if (limit && limit < lines.length) {
      return lines.slice(0, limit).join('\n') + `\n... (${lines.length - limit} more)`;
    }
    return fs.readFileSync(fp, 'utf-8').slice(0, 50000);
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runWrite(path: string, content: string): string {
  try {
    const fp = safePath(path);
    fs.mkdirSync(dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function runEdit(path: string, oldText: string, newText: string): string {
  try {
    const fp = safePath(path);
    const content = fs.readFileSync(fp, 'utf-8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText));
    return `Edited ${path}`;
  } catch (e: unknown) {
    return `Error: ${e}`;
  }
}
