import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { RunEngine } from '../../engine/RunEngine.js';
import type { RunConfig } from '../../types/index.js';
import { validateTaskPayload } from '../../engine/validation.js';
import { listRuns, getRun, getRunEvents, insertRun, insertRunEvent, completeRun } from '../db.js';

/** Parse number from env with fallback. */
function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

export function registerRunRoutes(app: FastifyInstance, engine: RunEngine, db: Database.Database): void {

  // ── List available task files ──────────────────────────────────────────
  app.get('/api/tasks', async () => {
    const tasksDir = path.resolve('tasks');
    try {
      const files = await fs.readdir(tasksDir);
      return files.filter(f => f.endsWith('.json')).map(f => ({ name: f, path: `tasks/${f}` }));
    } catch {
      return [];
    }
  });

  // ── List available agents ─────────────────────────────────────────────
  app.get('/api/agents', async () => {
    return engine.getAgentNames().map(name => ({ name }));
  });

  // ── List runs ─────────────────────────────────────────────────────────
  app.get<{
    Querystring: { status?: string; limit?: string; offset?: string };
  }>('/api/runs', async (request) => {
    const { status, limit, offset } = request.query;
    return listRuns(db, {
      status: status || undefined,
      limit: limit ? Number(limit) : 50,
      offset: offset ? Number(offset) : 0,
    });
  });

  // ── Get single run ────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = getRun(db, request.params.id);
    if (!run) {
      return reply.code(404).send({ error: 'Run not found' });
    }
    const events = getRunEvents(db, request.params.id);
    return { ...run, events };
  });

  // ── Start a new run ───────────────────────────────────────────────────
  app.post<{
    Body: {
      taskFile: string;
      agent?: string;
      variant?: string;
      budget?: number;
      ttl?: number;
    };
  }>('/api/runs', async (request, reply) => {
    const { taskFile, agent = 'echo', variant = 'default', budget, ttl } = request.body;

    // Read and validate task payload
    let taskPayload;
    try {
      const content = await fs.readFile(taskFile, 'utf-8');
      taskPayload = validateTaskPayload(JSON.parse(content));
    } catch (err) {
      return reply.code(400).send({
        error: `Failed to read task file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const tokenBudget = budget ?? envNumber('DEFAULT_TOKEN_BUDGET', 100_000);
    const ttlSeconds = ttl ?? envNumber('DEFAULT_TTL_SECONDS', 300);

    const runConfig: RunConfig = {
      taskPayload,
      variantLabel: variant,
      tokenBudget,
      ttlSeconds,
      loopDetection: {
        windowSize: envNumber('LOOP_WINDOW_SIZE', 8),
        similarityThreshold: envNumber('LOOP_SIMILARITY_THRESHOLD', 0.92),
        consecutiveTurns: envNumber('LOOP_CONSECUTIVE_TURNS', 5),
      },
    };

    // Track the runId once we learn it from the first event
    let capturedRunId: string | null = null;

    // Promise that resolves with runId when run_started fires
    let resolveRunId!: (id: string) => void;
    const runIdPromise = new Promise<string>((resolve) => {
      resolveRunId = resolve;
      setTimeout(() => resolve(''), 5000); // timeout fallback
    });

    const eventHandler = (event: { runId: string; event: string; data: Record<string, unknown>; timestamp: string }) => {
      // On run_started: insert the run row FIRST, then persist the event
      if (event.event === 'run_started' && !capturedRunId) {
        capturedRunId = event.runId;
        insertRun(db, {
          id: event.runId,
          agent,
          variant,
          taskFile,
          taskJson: JSON.stringify(taskPayload),
          budget: tokenBudget,
          ttlSeconds,
          startedAt: event.timestamp,
        });
        resolveRunId(event.runId);
      }

      // Only persist events for our run
      if (capturedRunId && event.runId === capturedRunId) {
        try {
          insertRunEvent(db, {
            runId: event.runId,
            event: event.event,
            data: JSON.stringify(event.data),
            timestamp: event.timestamp,
          });
        } catch { /* ignore */ }

        if (event.event === 'run_completed') {
          const data = event.data as Record<string, unknown>;
          const exitReason = data['exitReason'] as Record<string, unknown>;
          const status = exitReason['type'] === 'completed' ? 'completed' : 'killed';
          completeRun(db, capturedRunId, {
            status,
            exitReason: JSON.stringify(exitReason),
            tokenCount: (data['tokenCount'] as number) ?? 0,
            wallTimeMs: (data['wallTimeMs'] as number) ?? 0,
            completedAt: event.timestamp,
          });
        }
      }
    };

    engine.on('run:event', eventHandler);

    // Fire and forget — the run executes in the background
    engine.startRun(runConfig, agent)
      .then(() => { engine.off('run:event', eventHandler); })
      .catch(() => { engine.off('run:event', eventHandler); });

    // Wait for run_started event
    const resolvedRunId = await runIdPromise;

    if (resolvedRunId) {
      return reply.code(201).send({ runId: resolvedRunId });
    } else {
      return reply.code(202).send({ message: 'Run starting' });
    }
  });

  // ── Download artifact ─────────────────────────────────────────────────
  app.get<{ Params: { id: string; '*': string } }>('/api/runs/:id/artifacts/*', async (request, reply) => {
    const artifactPath = path.join('runs', request.params.id, 'artifacts', request.params['*']);
    try {
      const stat = await fs.stat(artifactPath);
      if (!stat.isFile()) {
        return reply.code(404).send({ error: 'Not a file' });
      }
      const content = await fs.readFile(artifactPath);
      return reply.send(content);
    } catch {
      return reply.code(404).send({ error: 'Artifact not found' });
    }
  });
}
