#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import { Command } from 'commander';
import type { RunConfig } from '../types/index.js';
import { RunEngine } from '../engine/RunEngine.js';
import { validateTaskPayload } from '../engine/validation.js';
import { getAgentNames } from '../engine/agents.js';

// ─── Exit codes ────────────────────────────────────────────────────────────────
const EXIT_COMPLETED = 0;
const EXIT_BUDGET_EXCEEDED = 1;
const EXIT_LOOP_DETECTED = 2;
const EXIT_TTL_EXCEEDED = 3;

// ─── Parse number from env with fallback ───────────────────────────────────────
function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

// ─── Translate exit reason to exit code ────────────────────────────────────────
function exitCodeFromReason(type: string): number {
  switch (type) {
    case 'completed': return EXIT_COMPLETED;
    case 'budget_exceeded': return EXIT_BUDGET_EXCEEDED;
    case 'loop_detected': return EXIT_LOOP_DETECTED;
    case 'ttl_exceeded': return EXIT_TTL_EXCEEDED;
    default: return 1;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('crucible')
    .description('Run a sandboxed agent evaluation')
    .requiredOption('--task <file>', 'Path to task payload JSON file')
    .option('--variant <label>', 'Variant label for this run', 'default')
    .option('--agent <name>', `Agent to use (${getAgentNames().join(', ')})`, 'echo')
    .option('--budget <tokens>', 'Token budget (overrides DEFAULT_TOKEN_BUDGET env)')
    .option('--ttl <seconds>', 'TTL in seconds (overrides DEFAULT_TTL_SECONDS env)')
    .parse(process.argv);

  const opts = program.opts<{
    task: string;
    variant: string;
    agent: string;
    budget?: string;
    ttl?: string;
  }>();

  // Read and validate task payload
  const taskFileContent = await fs.readFile(opts.task, 'utf-8');
  const taskPayload = validateTaskPayload(JSON.parse(taskFileContent));

  // Build RunConfig
  const tokenBudget = opts.budget !== undefined
    ? Number(opts.budget)
    : envNumber('DEFAULT_TOKEN_BUDGET', 100_000);

  const ttlSeconds = opts.ttl !== undefined
    ? Number(opts.ttl)
    : envNumber('DEFAULT_TTL_SECONDS', 300);

  const runConfig: RunConfig = {
    taskPayload,
    variantLabel: opts.variant,
    tokenBudget,
    ttlSeconds,
    loopDetection: {
      windowSize: envNumber('LOOP_WINDOW_SIZE', 8),
      similarityThreshold: envNumber('LOOP_SIMILARITY_THRESHOLD', 0.92),
      consecutiveTurns: envNumber('LOOP_CONSECUTIVE_TURNS', 5),
    },
  };

  // Create engine and subscribe to events (log to stdout as JSON)
  const engine = new RunEngine();

  engine.on('run:event', (event) => {
    console.log(JSON.stringify(event));
  });

  // Run and translate result to exit code
  const result = await engine.startRun(runConfig, opts.agent);
  process.exit(exitCodeFromReason(result.exitReason.type));
}

main().catch((err) => {
  console.error('Fatal error during startup:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
