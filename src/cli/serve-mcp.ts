#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import { Command } from 'commander';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { validateTaskPayload } from '../engine/validation.js';
import { SandboxRunner } from '../sandbox/runner.js';
import { createMcpSandboxServer } from '../server/mcp.js';
import type { RunConfig } from '../types/index.js';
import { envNumber } from './utils.js';

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('crucible-mcp')
    .description('Serve a CRUCIBLE sandbox as an MCP server for external agent evaluation')
    .requiredOption('--task <file>', 'Path to task payload JSON file')
    .option('--transport <type>', 'Transport type (stdio)', 'stdio')
    .option('--budget <tokens>', 'Token budget', String(envNumber('DEFAULT_TOKEN_BUDGET', 100_000)))
    .option('--ttl <seconds>', 'TTL in seconds', String(envNumber('DEFAULT_TTL_SECONDS', 300)))
    .parse(process.argv);

  const opts = program.opts<{
    task: string;
    transport: string;
    budget: string;
    ttl: string;
  }>();

  // Read and validate task payload
  const taskFileContent = await fs.readFile(opts.task, 'utf-8');
  const taskPayload = validateTaskPayload(JSON.parse(taskFileContent));

  const ttlSeconds = Number(opts.ttl);
  const tokenBudget = Number(opts.budget);

  // Build a RunConfig for the sandbox (used by SandboxRunner.create)
  const runConfig: RunConfig = {
    taskPayload,
    variantLabel: 'mcp-external',
    tokenBudget,
    ttlSeconds,
    loopDetection: {
      windowSize: 8,
      similarityThreshold: 0.92,
      consecutiveTurns: 5,
    },
  };

  // Create sandbox
  console.error(`[crucible-mcp] Creating sandbox (TTL: ${ttlSeconds}s)...`);
  const sandboxRunner = await SandboxRunner.create(runConfig);
  const toolContext = sandboxRunner.getToolContext();
  console.error('[crucible-mcp] Sandbox ready.');

  // Create MCP server wrapping sandbox tools
  const server = createMcpSandboxServer({ toolContext });

  // TTL teardown — destroy sandbox when time expires
  const ttlTimer = setTimeout(async () => {
    console.error('[crucible-mcp] TTL expired. Tearing down sandbox...');
    await cleanup();
    process.exit(0);
  }, ttlSeconds * 1000);
  ttlTimer.unref();

  // Cleanup function — idempotent
  let destroyed = false;
  async function cleanup(): Promise<void> {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(ttlTimer);
    try {
      await sandboxRunner.destroy();
    } catch (err) {
      console.error('[crucible-mcp] Sandbox destroy error:', err instanceof Error ? err.message : String(err));
    }
  }

  // Handle process signals for clean shutdown
  process.on('SIGINT', async () => {
    console.error('[crucible-mcp] SIGINT received. Cleaning up...');
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    console.error('[crucible-mcp] SIGTERM received. Cleaning up...');
    await cleanup();
    process.exit(0);
  });

  // Connect transport
  if (opts.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[crucible-mcp] MCP server running on stdio. Waiting for client...');
  } else {
    console.error(`[crucible-mcp] Unsupported transport: ${opts.transport}. Use "stdio".`);
    await cleanup();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
