import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext, ExecResult } from '../types/index.js';

/**
 * Options for creating an MCP sandbox server.
 */
export interface McpServerOptions {
  /** ToolContext wrapping the E2B sandbox — exec, writeFile, readFile. */
  toolContext: ToolContext;
  /** Optional callback when the MCP server is closing. */
  onClose?: () => void;
}

/**
 * Creates an MCP server that exposes CRUCIBLE sandbox operations as MCP tools.
 *
 * Three tools are exposed:
 *   - exec: Execute a shell command in the sandbox
 *   - writeFile: Write content to a file in the sandbox
 *   - readFile: Read a file from the sandbox
 *
 * Kill switches (token budget, loop detection, TTL) are enforced at the
 * sandbox/middleware layer, not at the MCP layer. The MCP server is a
 * thin passthrough to ToolContext.
 */
export function createMcpSandboxServer(options: McpServerOptions): McpServer {
  const { toolContext } = options;

  const server = new McpServer({
    name: 'crucible-sandbox',
    version: '0.1.0',
  });

  // ─── exec tool ───

  server.tool(
    'exec',
    'Execute a shell command in the sandbox',
    { command: z.string().describe('Shell command to execute') },
    async ({ command }): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const result: ExecResult = await toolContext.exec(command);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          }),
        }],
      };
    },
  );

  // ─── writeFile tool ───

  server.tool(
    'writeFile',
    'Write content to a file in the sandbox',
    {
      path: z.string().describe('File path in the sandbox'),
      content: z.string().describe('File content to write'),
    },
    async ({ path, content }): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      await toolContext.writeFile(path, content);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, path }),
        }],
      };
    },
  );

  // ─── readFile tool ───

  server.tool(
    'readFile',
    'Read a file from the sandbox',
    { path: z.string().describe('File path to read') },
    async ({ path }): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const content = await toolContext.readFile(path);
      return {
        content: [{
          type: 'text' as const,
          text: content,
        }],
      };
    },
  );

  return server;
}
