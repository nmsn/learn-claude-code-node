# s13 MCP Integration Design

**Date**: 2026-04-07
**Author**: Claude Code
**Status**: Approved

## Overview

s13 implements a minimal but complete MCP (Model Context Protocol) integration in TypeScript. It supports both MCP Server (expose local tools) and MCP Client (call external servers) via stdio transport.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    s13-mcp-integration.ts                │
│                                                         │
│  ┌─────────────────┐    ┌─────────────────────────┐  │
│  │   MCP Server     │    │      MCP Client         │  │
│  │                 │    │                         │  │
│  │ Exposed tools:  │    │ External servers:       │  │
│  │  - bash         │    │  - reads .mcp/servers   │  │
│  │  - read_file    │    │  - spawns processes    │  │
│  │  - write_file   │    │  - stdio JSON-RPC      │  │
│  │  - edit_file    │    │                         │  │
│  └────────┬────────┘    └───────────┬─────────────┘  │
│           │                         │                 │
│           │ stdio                   │ stdio           │
└───────────┼─────────────────────────┼─────────────────┘
            │                         │
            v                         v
    External MCP Client         External MCP Server
    (e.g. Claude Code)         (e.g. filesystem server)
```

## MCP Server

### Protocol

- Transport: stdio (JSON-RPC 2.0)
- Server receives requests via stdin, sends responses via stdout
- Notifications via stderr

### Exposed Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `bash` | Execute shell command | `{ command: string }` |
| `read_file` | Read file contents | `{ path: string, limit?: number }` |
| `write_file` | Write content to file | `{ path: string, content: string }` |
| `edit_file` | Replace text in file | `{ path: string, old_text: string, new_text: string }` |

### Safety

- `bash` blocks dangerous commands: `rm -rf /`, `sudo`, `shutdown`, `reboot`
- Path escaping protection: files must be within WORKDIR

## MCP Client

### Configuration

File: `.mcp/servers.json`

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem", "./workspace"]
    }
  ]
}
```

### Features

- Lazy startup: Server processes start only when first tool call is made
- Process management: Track running server processes
- Resource cleanup: Kill processes on shutdown

## REPL Commands

| Command | Description |
|---------|-------------|
| `bash <command>` | Execute shell command locally |
| `read_file <path>` | Read file contents |
| `write_file <path>` | Write file (mode: `write`) |
| `edit_file <path>` | Edit file (mode: `edit`) |
| `/mcp_start` | Start MCP Server on stdio |
| `/mcp_list` | List configured external servers |
| `/mcp_tools <server>` | List tools available from a server |
| `/connect <server>` | Connect to an external MCP server |
| `/disconnect <server>` | Disconnect from a server |
| `/quit` | Exit |

## Data Flow

### MCP Server Request/Response

```
Request:
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "bash",
    "arguments": { "command": "ls -la" }
  }
}

Response:
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      { "type": "text", "text": "..." }
    ]
  }
}
```

### External Tool Call Flow

```
Agent calls external tool
    │
    └─→ MCP Client sends JSON-RPC
            │
            ├─→ Spawn server process (if not running)
            ├─→ Write request to stdin
            └─→ Read response from stdout
                    │
                    └─→ Return result to Agent
```

## Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^0.5.0"
}
```

## File Structure

```
src/
  s13-mcp-integration.ts    # Main entry point, REPL, orchestration
```

All components are in a single file for simplicity and easy review.

## Error Handling

- Invalid JSON-RPC: Return `{ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }`
- Unknown method: Return `{ "jsonrpc": "2.0", "id": <id>, "error": { "code": -32601, "message": "Method not found" } }`
- Tool execution error: Return error in tool result

## Testing Strategy

1. Start s13, run `/mcp_start`
2. Use `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node s13-mcp-integration.ts`
3. Verify external MCP client (e.g., Claude Code) can connect and call tools
4. Test MCP Client by configuring an external server and calling its tools

## Out of Scope

- Integration with s-full.ts (future work)
- HTTP/SSE transport (stdio only)
- Authentication/authorization
- Tool access control policies
