#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config({ override: true });
import { Command } from 'commander';
import { RunEngine } from '../engine/RunEngine.js';
import { SessionModel } from '../session/index.js';
import { openDatabase, cleanupStaleRuns } from './db.js';
import { createServer } from './index.js';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('crucible-serve')
    .description('Start the CRUCIBLE web UI server')
    .option('--port <number>', 'Port to listen on', '3100')
    .option('--agent-dir <path>', 'Path to .agent/ directory for session state', '.agent')
    .parse(process.argv);

  const opts = program.opts<{ port: string; agentDir: string }>();
  const port = Number(opts.port);

  const engine = new RunEngine();
  const db = openDatabase();

  // Clean up runs left in "running" state from a previous server session
  const staleCount = cleanupStaleRuns(db);
  if (staleCount > 0) {
    console.log(`Cleaned up ${staleCount} stale run(s) from previous session`);
  }

  // Initialize session model for API routes
  const session = new SessionModel({ agentDir: opts.agentDir });
  await session.initialize();

  // Attach session to engine for session-aware runs launched from UI
  engine.setSession(session);

  const server = await createServer({ port, engine, db, session });
  const address = server.addresses()[0];

  console.log(`CRUCIBLE server running at http://localhost:${address?.port ?? port}`);
  console.log(`  API:       http://localhost:${address?.port ?? port}/api/runs`);
  console.log(`  Session:   http://localhost:${address?.port ?? port}/api/session/snapshot`);
  console.log(`  WebSocket: ws://localhost:${address?.port ?? port}/api/ws`);
}

main().catch((err) => {
  console.error('Failed to start server:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
