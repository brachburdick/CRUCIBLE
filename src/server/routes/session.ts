import type { FastifyInstance } from 'fastify';
import type { SessionModel } from '../../session/index.js';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Transcript Parsing ────────────────────────────────────────────────

interface SessionMetrics {
  session_id: string;
  project: string;
  title: string;
  first_timestamp: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_creation: number;
  peak_context: number;
  peak_context_pct: number;
  turn_count: number;
  mtime: number;
}

async function parseTranscript(filePath: string, contextSize: number): Promise<SessionMetrics | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    // Deduplicate assistant turns by requestId — keep highest output_tokens
    const assistantByReq = new Map<string, Record<string, unknown>>();
    const userEntries: Record<string, unknown>[] = [];
    let firstTimestamp = '';
    let title = '';

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }

      if (entry['type'] === 'user') {
        userEntries.push(entry);
        if (!firstTimestamp && typeof entry['timestamp'] === 'string') {
          firstTimestamp = entry['timestamp'];
        }
        // Extract title from first user message
        if (!title) {
          const msg = entry['message'] as { content?: unknown } | undefined;
          if (msg?.content) {
            const content = Array.isArray(msg.content)
              ? (msg.content as Array<{ type?: string; text?: string }>).filter(b => b.type === 'text').map(b => b.text).join(' ')
              : typeof msg.content === 'string' ? msg.content : '';
            title = content.replace(/@[\w/.-]+/g, '').trim().slice(0, 60);
          }
        }
      }

      if (entry['type'] === 'assistant' && entry['requestId']) {
        const reqId = entry['requestId'] as string;
        const msg = entry['message'] as { usage?: Record<string, number> } | undefined;
        const outputTokens = msg?.usage?.['output_tokens'] ?? 0;
        const existing = assistantByReq.get(reqId);
        const existingOutput = (existing?.['message'] as { usage?: Record<string, number> } | undefined)?.usage?.['output_tokens'] ?? 0;
        if (!existing || outputTokens > existingOutput) {
          assistantByReq.set(reqId, entry);
        }
      }
    }

    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreation = 0;
    let peakContext = 0;
    let turnCount = 0;

    for (const entry of assistantByReq.values()) {
      const msg = entry['message'] as { usage?: Record<string, number> } | undefined;
      const usage = msg?.usage;
      if (!usage) continue;

      turnCount++;
      const inp = usage['input_tokens'] ?? 0;
      const out = usage['output_tokens'] ?? 0;
      const cacheRead = usage['cache_read_input_tokens'] ?? 0;
      const cacheCreate = usage['cache_creation_input_tokens'] ?? 0;
      const totalContext = inp + cacheRead + cacheCreate;

      totalInput += inp;
      totalOutput += out;
      totalCacheRead += cacheRead;
      totalCacheCreation += cacheCreate;
      if (totalContext > peakContext) peakContext = totalContext;
    }

    const fileStat = await stat(filePath);

    return {
      session_id: filePath.split('/').pop()?.replace('.jsonl', '') ?? '',
      project: '',
      title: title || '(untitled)',
      first_timestamp: firstTimestamp,
      total_input_tokens: totalInput,
      total_output_tokens: totalOutput,
      total_cache_read: totalCacheRead,
      total_cache_creation: totalCacheCreation,
      peak_context: peakContext,
      peak_context_pct: contextSize > 0 ? (peakContext / contextSize) * 100 : 0,
      turn_count: turnCount,
      mtime: fileStat.mtimeMs,
    };
  } catch {
    return null;
  }
}

async function getSessionMetrics(projectSlug: string, limit: number, contextSize: number): Promise<SessionMetrics[]> {
  const projectDir = join(homedir(), '.claude', 'projects', projectSlug);
  let files: string[];
  try {
    const entries = await readdir(projectDir);
    files = entries.filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const results: SessionMetrics[] = [];
  for (const file of files) {
    const metrics = await parseTranscript(join(projectDir, file), contextSize);
    if (metrics) {
      metrics.project = projectSlug;
      results.push(metrics);
    }
  }

  // Sort by mtime descending (most recent first)
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/**
 * Session model REST endpoints — expose .agent/ state to the UI.
 *
 * All routes read/write the same .agent/ files the CLI uses.
 * The SessionModel must be initialized before registering these routes.
 */
export function registerSessionRoutes(app: FastifyInstance, session: SessionModel): void {

  // ── State Snapshot ───────────────────────────────────────────────────
  app.get('/api/session/snapshot', async () => {
    return session.snapshot.current;
  });

  // ── Reload session state from disk ───────────────────────────────────
  // Local dev server — re-read on every request so external changes
  // (CLI appending tasks, other sessions) are visible immediately.
  app.post('/api/session/reload', async () => {
    await session.initialize();
    return { status: 'reloaded' };
  });

  // ── Task Queue ───────────────────────────────────────────────────────
  app.get('/api/session/tasks', async () => {
    await session.tasks.load(); // re-read from disk
    return session.tasks.all();
  });

  app.get('/api/session/tasks/ready', async () => {
    await session.tasks.load();
    return session.tasks.ready();
  });

  app.patch<{
    Params: { id: string };
    Body: { status?: string; assignedTo?: string };
  }>('/api/session/tasks/:id', async (request, reply) => {
    const { id } = request.params;
    const updates = request.body;

    try {
      const task = session.tasks.update(id, updates as Record<string, unknown>);
      await session.tasks.save();
      return task;
    } catch (err) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Question Queue ───────────────────────────────────────────────────
  app.get<{
    Querystring: { status?: string };
  }>('/api/session/questions', async (request) => {
    await session.questions.load(); // re-read from disk
    const { status } = request.query;
    if (status === 'pending') {
      return session.questions.pending();
    }
    if (status === 'answered') {
      return session.questions.answered();
    }
    return session.questions.all();
  });

  app.post<{
    Params: { id: string };
    Body: { answer: string };
  }>('/api/session/questions/:id/answer', async (request, reply) => {
    const { id } = request.params;
    const { answer } = request.body;

    if (!answer) {
      return reply.code(400).send({ error: 'answer is required' });
    }

    try {
      const question = session.questions.answer(id, answer);
      await session.questions.save();
      return question;
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Run Records ──────────────────────────────────────────────────────
  app.get<{
    Querystring: { last?: string };
  }>('/api/session/run-records', async (request) => {
    await session.runRecords.load(); // re-read from disk
    const { last } = request.query;
    if (last) {
      return session.runRecords.recent(Number(last));
    }
    return session.runRecords.all();
  });

  // ── Config / Env Status ──────────────────────────────────────────────
  app.get('/api/config/env-status', async () => {
    return {
      E2B_API_KEY: !!process.env['E2B_API_KEY'],
      ANTHROPIC_API_KEY: !!process.env['ANTHROPIC_API_KEY'],
      OPENAI_API_KEY: !!process.env['OPENAI_API_KEY'],
      OTEL_EXPORTER_OTLP_ENDPOINT: !!process.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
    };
  });

  // ── Session Token Metrics ──────────────────────────────────────────
  app.get<{
    Querystring: { project?: string; limit?: string; context_size?: string };
  }>('/api/sessions/metrics', async (request) => {
    // Default to CRUCIBLE project slug
    const slug = request.query.project || '-Users-brach-Documents-THE-FACTORY-projects-CRUCIBLE';
    const limit = Number(request.query.limit) || 20;
    const contextSize = Number(request.query.context_size) || 1_000_000;
    return getSessionMetrics(slug, limit, contextSize);
  });

  // ── Available project slugs ────────────────────────────────────────
  app.get('/api/sessions/projects', async () => {
    const projectsDir = join(homedir(), '.claude', 'projects');
    try {
      const entries = await readdir(projectsDir);
      return entries.filter(e => e.startsWith('-'));
    } catch {
      return [];
    }
  });
}
