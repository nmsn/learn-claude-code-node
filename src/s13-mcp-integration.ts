#!/usr/bin/env node
/**
 * s13-mcp-integration.ts - MCP Server + Client
 *
 * MCP Server: exposes local tools (bash, read_file, write_file, edit_file) via stdio
 * MCP Client: calls external MCP servers defined in .mcp/servers.json
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as readline from 'readline';
import { stdin, stdout } from 'process';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { resolve, dirname, join, isAbsolute } from 'path';

const WORKDIR = process.cwd();
const MCP_CONFIG_PATH = join(WORKDIR, '.mcp', 'servers.json');

const DANGEROUS_COMMANDS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];

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

// =============================================================================
// MCP Server Implementation
// =============================================================================

const LOCAL_TOOLS: Tool[] = [
  {
    name: 'bash',
    description: 'Run a shell command in the current workspace.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read file contents.',
    inputSchema: {
      type: 'object',
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
    inputSchema: {
      type: 'object',
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
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
];

function executeLocalTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return runBash(args.command as string);
    case 'read_file':
      return runRead(args.path as string, args.limit as number | undefined);
    case 'write_file':
      return runWrite(args.path as string, args.content as string);
    case 'edit_file':
      return runEdit(args.path as string, args.old_text as string, args.new_text as string);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function createMCPServer(): Server {
  const server = new Server(
    {
      name: 's13-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: LOCAL_TOOLS };
  });

  // Call tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = executeLocalTool(name, args);
      return {
        content: [{ type: 'text' as const, text: result }],
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${e}` }],
        isError: true,
      };
    }
  });

  return server;
}

// =============================================================================
// MCP Client Implementation
// =============================================================================

class ClientManager {
  private clients: Map<string, Client> = new Map();

  async connect(name: string, config: ServerConfig): Promise<void> {
    if (this.clients.has(name)) {
      console.log(`Client ${name} already connected`);
      return;
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
    });

    const client = new Client(
      {
        name: `s13-client-${name}`,
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);
    this.clients.set(name, client);
    console.log(`Connected to MCP server: ${name}`);
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) {
      console.log(`Client ${name} not connected`);
      return;
    }
    await client.close();
    this.clients.delete(name);
    console.log(`Disconnected from MCP server: ${name}`);
  }

  isConnected(name: string): boolean {
    return this.clients.has(name);
  }

  getClient(name: string): Client | undefined {
    return this.clients.get(name);
  }

  getClientNames(): string[] {
    return Array.from(this.clients.keys());
  }

  async listTools(name: string): Promise<Array<{ name: string; description?: string }>> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Client ${name} not connected`);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as any).request({ method: 'tools/list' }, {});
      return response.tools || [];
    } catch (e) {
      console.error(`Error listing tools: ${e}`);
      return [];
    }
  }

  async callTool(name: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Client ${name} not connected`);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as any).request(
        { method: 'tools/call', params: { name: toolName, arguments: args } },
        {}
      );
      if (response.content && response.content.length > 0) {
        return response.content[0].text || '';
      }
      return '';
    } catch (e) {
      return `Error: ${e}`;
    }
  }
}

const clientManager = new ClientManager();

function loadServerConfigs(): ServerConfig[] {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) {
      return [];
    }
    const config: ServersConfig = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf-8'));
    return config.servers || [];
  } catch (e) {
    console.error(`Error loading MCP config: ${e}`);
    return [];
  }
}

async function startMCPServer(): Promise<void> {
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server started on stdio'); // stderr for logging
}

// =============================================================================
// REPL and Main Integration
// =============================================================================

async function main() {
  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: '\x1b[36ms13 >> \x1b[0m',
  });

  console.log('s13 MCP Integration');
  console.log('Commands: /mcp_start, /mcp_list, /mcp_tools, /connect, /disconnect, /quit');
  console.log('Local tools: bash, read_file, write_file, edit_file');

  for await (const query of rl) {
    const trimmed = query.trim();

    if (trimmed === '/quit' || trimmed === 'q' || trimmed === 'exit') {
      break;
    }

    if (trimmed === '/mcp_start') {
      await startMCPServer();
      break;
    }

    if (trimmed === '/mcp_list') {
      const configs = loadServerConfigs();
      console.log('Configured servers:');
      for (const config of configs) {
        const status = clientManager.isConnected(config.name) ? '[connected]' : '[disconnected]';
        console.log(`  ${status} ${config.name}: ${config.command} ${config.args.join(' ')}`);
      }
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/connect ')) {
      const serverName = trimmed.slice(9).trim();
      const configs = loadServerConfigs();
      const config = configs.find((c: ServerConfig) => c.name === serverName);
      if (!config) {
        console.log(`Server "${serverName}" not found in config`);
      } else {
        try {
          await clientManager.connect(serverName, config);
        } catch (e) {
          console.log(`Failed to connect: ${e}`);
        }
      }
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/disconnect ')) {
      const serverName = trimmed.slice(12).trim();
      await clientManager.disconnect(serverName);
      rl.prompt();
      continue;
    }

    if (trimmed.startsWith('/mcp_tools ')) {
      const serverName = trimmed.slice(11).trim();
      try {
        const tools = await clientManager.listTools(serverName);
        console.log(`Tools from ${serverName}:`);
        for (const tool of tools) {
          console.log(`  - ${tool.name}: ${tool.description || ''}`);
        }
      } catch (e) {
        console.log(`Error: ${e}`);
      }
      rl.prompt();
      continue;
    }

    // If query looks like a tool call, parse and execute
    if (
      trimmed.startsWith('bash ') ||
      trimmed.startsWith('read_file ') ||
      trimmed.startsWith('write_file ') ||
      trimmed.startsWith('edit_file ')
    ) {
      const parts = trimmed.split(' ');
      const tool = parts[0];
      const args = parts.slice(1);

      if (tool === 'bash') {
        console.log(runBash(args.join(' ')));
      } else if (tool === 'read_file') {
        console.log(runRead(args[0] || ''));
      } else if (tool === 'write_file' && args.length >= 2) {
        const [path, ...contentParts] = args;
        console.log(runWrite(path, contentParts.join(' ')));
      } else if (tool === 'edit_file' && args.length >= 3) {
        const [path, oldText, newText] = args;
        console.log(runEdit(path, oldText, newText));
      } else {
        console.log('Invalid arguments');
      }
      rl.prompt();
      continue;
    }

    console.log('Unknown command. Try /mcp_start, /mcp_list, /connect <name>, or local tools.');
    rl.prompt();
  }

  // Cleanup
  for (const name of clientManager.getClientNames()) {
    await clientManager.disconnect(name);
  }
}

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  for (const name of clientManager.getClientNames()) {
    await clientManager.disconnect(name);
  }
  process.exit(0);
});

main().catch((e) => {
  console.error(`Fatal error: ${e}`);
  process.exit(1);
});
