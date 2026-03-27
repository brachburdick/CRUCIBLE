import type { FastifyInstance } from 'fastify';
import type { SessionModel } from '../../session/index.js';

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
}
