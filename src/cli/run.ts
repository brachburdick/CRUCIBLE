#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import type { RunConfig } from '../types/index.js';
import { RunEngine } from '../engine/RunEngine.js';
import { SessionModel } from '../session/index.js';
import { validateTaskPayload } from '../engine/validation.js';
import { getAgentNames } from '../engine/agents.js';
import { loadVariant } from '../engine/variants.js';
import { envNumber, exitCodeFromReason } from './utils.js';

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('crucible')
    .description('Run a sandboxed agent evaluation')
    .requiredOption('--task <file>', 'Path to task payload JSON file')
    .option('--variant <label>', 'Variant label for this run', 'default')
    .option('--variant-file <path>', 'Path to variant YAML config file (overrides --variant and --agent)')
    .option('--agent <name>', `Agent to use (${getAgentNames().join(', ')})`, 'echo')
    .option('--budget <tokens>', 'Token budget (overrides DEFAULT_TOKEN_BUDGET env)')
    .option('--ttl <seconds>', 'TTL in seconds (overrides DEFAULT_TTL_SECONDS env)')
    .option('--agent-dir <path>', 'Path to .agent/ directory for session state', '.agent')
    .option('--no-session', 'Disable session model (no state persistence, run records, mutation guard)')
    .parse(process.argv);

  const opts = program.opts<{
    task: string;
    variant: string;
    variantFile?: string;
    agent: string;
    budget?: string;
    ttl?: string;
    agentDir: string;
    session: boolean;
  }>();

  // Read and validate task payload
  const taskFileContent = await fs.readFile(opts.task, 'utf-8');
  const taskPayload = validateTaskPayload(JSON.parse(taskFileContent));

  // Load variant config if provided
  const variantConfig = opts.variantFile
    ? await loadVariant(opts.variantFile)
    : undefined;

  // Determine effective values (variant config overrides CLI flags)
  const agentName = variantConfig?.agent ?? opts.agent;
  const variantLabel = variantConfig?.name ?? opts.variant;

  const tokenBudget = variantConfig?.budget
    ?? (opts.budget !== undefined ? Number(opts.budget) : envNumber('DEFAULT_TOKEN_BUDGET', 100_000));

  const ttlSeconds = variantConfig?.ttl
    ?? (opts.ttl !== undefined ? Number(opts.ttl) : envNumber('DEFAULT_TTL_SECONDS', 300));

  const runConfig: RunConfig = {
    taskPayload,
    variantLabel,
    tokenBudget,
    ttlSeconds,
    loopDetection: {
      windowSize: envNumber('LOOP_WINDOW_SIZE', 8),
      similarityThreshold: envNumber('LOOP_SIMILARITY_THRESHOLD', 0.92),
      consecutiveTurns: envNumber('LOOP_CONSECUTIVE_TURNS', 5),
    },
  };

  // Build agent config from variant (for coder agent, passes system prompt + model)
  const agentConfig = variantConfig
    ? {
        systemPrompt: variantConfig.systemPrompt,
        model: variantConfig.model,
      }
    : undefined;

  // Initialize session model (unless --no-session)
  let session: SessionModel | null = null;
  if (opts.session) {
    const agentDir = path.resolve(opts.agentDir);
    session = new SessionModel({ agentDir });
    await session.initialize();

    // Load prior session knowledge (decisions, dead ends, key locations)
    const snapshot = session.snapshot.current;
    if (snapshot.sessionKnowledge.decisions.length > 0) {
      console.error(
        `[crucible] Loaded ${snapshot.sessionKnowledge.decisions.length} prior decisions, ` +
        `${snapshot.sessionKnowledge.deadEnds.length} dead ends from previous session.`
      );
    }
  }

  // Create engine and attach session
  const engine = new RunEngine();
  if (session) {
    engine.setSession(session);
  }

  engine.on('run:event', (event) => {
    console.log(JSON.stringify(event));
  });

  // Run and translate result to exit code
  const result = await engine.startRun(runConfig, agentName, agentConfig);

  // Finalize session — persist state snapshot + task queue
  if (session) {
    session.snapshot.setActiveTasks([]);
    await session.finalize();
    console.error(`[crucible] Session finalized. Run record written.`);
  }

  process.exit(exitCodeFromReason(result.exitReason.type));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
