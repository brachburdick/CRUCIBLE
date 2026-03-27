#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import type { RunConfig, RunResult, ScoreResult } from '../types/index.js';
import { RunEngine } from '../engine/RunEngine.js';
import { validateTaskPayload } from '../engine/validation.js';
import { loadVariant } from '../engine/variants.js';
import { envNumber } from './utils.js';

// ─── Comparison result types ─────────────────────────────────────────────────

interface VariantRunResult {
  variantName: string;
  variantFile: string;
  result: RunResult;
  scores?: ScoreResult;
}

interface ComparisonResult {
  task: string;
  timestamp: string;
  runs: VariantRunResult[];
  winner: string | null;
  winnerReason: string;
  discrimination: number;
}

// ─── Winner logic ────────────────────────────────────────────────────────────

function determineWinner(runs: VariantRunResult[]): { winner: string | null; reason: string; discrimination: number } {
  if (runs.length === 0) return { winner: null, reason: 'No runs', discrimination: 0 };
  if (runs.length === 1) return { winner: runs[0].variantName, reason: 'Only variant', discrimination: 0 };

  // Hard gate 1: completed beats non-completed
  const completed = runs.filter((r) => r.result.exitReason.type === 'completed');
  const notCompleted = runs.filter((r) => r.result.exitReason.type !== 'completed');

  if (completed.length === 1 && notCompleted.length > 0) {
    return {
      winner: completed[0].variantName,
      reason: `Only variant that completed (others: ${notCompleted.map((r) => `${r.variantName}=${r.result.exitReason.type}`).join(', ')})`,
      discrimination: 1.0,
    };
  }

  // Hard gate 2: higher check pass rate wins
  const withScores = runs.filter((r) => r.scores);
  if (withScores.length >= 2) {
    const sorted = [...withScores].sort((a, b) => (b.scores?.passRate ?? 0) - (a.scores?.passRate ?? 0));
    const best = sorted[0];
    const second = sorted[1];

    if ((best.scores?.passRate ?? 0) > (second.scores?.passRate ?? 0)) {
      return {
        winner: best.variantName,
        reason: `Higher check pass rate (${fmt(best.scores!.passRate * 100)}% vs ${fmt(second.scores!.passRate * 100)}%)`,
        discrimination: Math.abs((best.scores?.passRate ?? 0) - (second.scores?.passRate ?? 0)),
      };
    }
  }

  // Tiebreaker: fewer tokens
  const sortedByTokens = [...runs].sort(
    (a, b) => a.result.tokenUsage.totalTokens - b.result.tokenUsage.totalTokens,
  );
  const cheapest = sortedByTokens[0];
  const mostExpensive = sortedByTokens[sortedByTokens.length - 1];

  if (cheapest.result.tokenUsage.totalTokens < mostExpensive.result.tokenUsage.totalTokens) {
    const savings = 1 - cheapest.result.tokenUsage.totalTokens / mostExpensive.result.tokenUsage.totalTokens;
    return {
      winner: cheapest.variantName,
      reason: `${fmt(savings * 100)}% fewer tokens (${fmtNum(cheapest.result.tokenUsage.totalTokens)} vs ${fmtNum(mostExpensive.result.tokenUsage.totalTokens)})`,
      discrimination: savings,
    };
  }

  // Tiebreaker: less wall time
  const sortedByTime = [...runs].sort((a, b) => a.result.wallTimeMs - b.result.wallTimeMs);
  const fastest = sortedByTime[0];
  const slowest = sortedByTime[sortedByTime.length - 1];

  if (fastest.result.wallTimeMs < slowest.result.wallTimeMs) {
    return {
      winner: fastest.variantName,
      reason: `Faster (${fmtTime(fastest.result.wallTimeMs)} vs ${fmtTime(slowest.result.wallTimeMs)})`,
      discrimination: 1 - fastest.result.wallTimeMs / slowest.result.wallTimeMs,
    };
  }

  return { winner: null, reason: 'Tie — no distinguishing metric', discrimination: 0 };
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmt(n: number): string { return n.toFixed(1); }
function fmtNum(n: number): string { return n.toLocaleString(); }
function fmtTime(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }

function checksDisplay(scores?: ScoreResult): string {
  if (!scores) return 'N/A';
  const passed = scores.checks.filter((c) => c.passed).length;
  const total = scores.checks.length;
  return passed === total ? `${passed}/${total} PASS` : `${passed}/${total} FAIL`;
}

function exitDisplay(result: RunResult): string {
  switch (result.exitReason.type) {
    case 'completed': return 'done';
    case 'budget_exceeded': return 'budget';
    case 'loop_detected': return 'loop';
    case 'ttl_exceeded': return 'ttl';
    default: return 'unknown';
  }
}

// ─── Table rendering ─────────────────────────────────────────────────────────

function printComparisonTable(taskName: string, runs: VariantRunResult[], winnerInfo: { winner: string | null; reason: string }): void {
  const headers = ['Variant', 'Checks', 'Tokens', 'Time', 'Exit'];
  const rows = runs.map((r) => [
    r.variantName,
    checksDisplay(r.scores),
    fmtNum(r.result.tokenUsage.totalTokens),
    fmtTime(r.result.wallTimeMs),
    exitDisplay(r.result),
  ]);

  // Compute column widths
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));

  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const line = (cells: string[]) => '│ ' + cells.map((c, i) => pad(c, widths[i])).join(' │ ') + ' │';
  const border = (left: string, mid: string, right: string) =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;

  console.log(`\nTask: ${taskName}`);
  console.log(border('┌', '┬', '┐'));
  console.log(line(headers));
  console.log(border('├', '┼', '┤'));
  rows.forEach((row) => console.log(line(row)));
  console.log(border('└', '┴', '┘'));

  if (winnerInfo.winner) {
    console.log(`Winner: ${winnerInfo.winner} (${winnerInfo.reason})`);
  } else {
    console.log(`Result: ${winnerInfo.reason}`);
  }
  console.log();
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();

  function collect(val: string, prev: string[]): string[] {
    prev.push(val);
    return prev;
  }

  program
    .name('crucible-compare')
    .description('Compare pipeline variants on the same task')
    .requiredOption('--task <file>', 'Path to task payload JSON file')
    .requiredOption('-v, --variant <file>', 'Variant YAML config file (repeat for each variant)', collect, [] as string[])
    .option('--budget <tokens>', 'Token budget override for all variants')
    .option('--ttl <seconds>', 'TTL override for all variants')
    .parse(process.argv);

  const opts = program.opts<{
    task: string;
    variant: string[];
    budget?: string;
    ttl?: string;
  }>();

  const variantFiles = opts.variant;

  if (variantFiles.length < 2) {
    console.error('Error: at least 2 variant files required. Use -v for each:');
    console.error('  crucible-compare --task <file> -v variant1.yaml -v variant2.yaml');
    process.exit(1);
  }

  // Read and validate task payload
  const taskFileContent = await fs.readFile(opts.task, 'utf-8');
  const taskPayload = validateTaskPayload(JSON.parse(taskFileContent));

  // Load all variants
  const variants = await Promise.all(variantFiles.map(loadVariant));

  console.log(`Comparing ${variants.length} variants on task: ${taskPayload.description}`);
  console.log(`Variants: ${variants.map((v) => v.name).join(', ')}\n`);

  // Run each variant sequentially
  const engine = new RunEngine();
  const variantRuns: VariantRunResult[] = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    const variantFile = variantFiles[i];
    console.log(`[${i + 1}/${variants.length}] Running variant: ${variant.name}...`);

    const agentName = variant.agent ?? 'coder';
    const tokenBudget = variant.budget
      ?? (opts.budget !== undefined ? Number(opts.budget) : envNumber('DEFAULT_TOKEN_BUDGET', 100_000));
    const ttlSeconds = variant.ttl
      ?? (opts.ttl !== undefined ? Number(opts.ttl) : envNumber('DEFAULT_TTL_SECONDS', 300));

    const runConfig: RunConfig = {
      taskPayload,
      variantLabel: variant.name,
      tokenBudget,
      ttlSeconds,
      loopDetection: {
        windowSize: envNumber('LOOP_WINDOW_SIZE', 8),
        similarityThreshold: envNumber('LOOP_SIMILARITY_THRESHOLD', 0.92),
        consecutiveTurns: envNumber('LOOP_CONSECUTIVE_TURNS', 5),
      },
    };

    const agentConfig = {
      systemPrompt: variant.systemPrompt,
      model: variant.model,
    };

    // Subscribe to key events for progress display
    const listener = (event: { event: string; data: Record<string, unknown> }) => {
      if (event.event === 'agent_completed') {
        console.log(`  Agent completed`);
      } else if (event.event === 'checks_completed') {
        console.log(`  Checks: pass rate ${event.data['passRate']}`);
      } else if (event.event === 'error') {
        console.log(`  Error: ${event.data['error']}`);
      }
    };
    engine.on('run:event', listener);

    const result = await engine.startRun(runConfig, agentName, agentConfig);
    engine.removeListener('run:event', listener);

    const scores = result.metadata?.['scores'] as ScoreResult | undefined;

    variantRuns.push({
      variantName: variant.name,
      variantFile,
      result,
      scores,
    });

    console.log(`  Exit: ${exitDisplay(result)} | Tokens: ${fmtNum(result.tokenUsage.totalTokens)} | Time: ${fmtTime(result.wallTimeMs)}`);
    console.log();
  }

  // Determine winner
  const winnerInfo = determineWinner(variantRuns);

  // Print comparison table
  printComparisonTable(taskPayload.description, variantRuns, winnerInfo);

  // Save comparison result
  const comparison: ComparisonResult = {
    task: opts.task,
    timestamp: new Date().toISOString(),
    runs: variantRuns,
    winner: winnerInfo.winner,
    winnerReason: winnerInfo.reason,
    discrimination: winnerInfo.discrimination,
  };

  const comparisonDir = path.join('runs', 'comparisons');
  await fs.mkdir(comparisonDir, { recursive: true });
  const comparisonFile = path.join(comparisonDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(comparisonFile, JSON.stringify(comparison, null, 2), 'utf-8');
  console.log(`Comparison saved: ${comparisonFile}`);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
