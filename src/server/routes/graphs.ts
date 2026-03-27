import type { FastifyInstance } from 'fastify';
import { GraphStore } from '../../engine/GraphStore.js';

/**
 * Graph store REST endpoints — expose decomposition graphs to the UI.
 */
export function registerGraphRoutes(app: FastifyInstance, graphStore: GraphStore): void {

  // ── List all graphs ──────────────────────────────────────────────────
  app.get('/api/graphs', async () => {
    try {
      const ids = await graphStore.listGraphs();
      return ids.map(id => ({ id }));
    } catch {
      return [];
    }
  });

  // ── Get full graph ───────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/graphs/:id', async (request, reply) => {
    try {
      const graph = await graphStore.loadGraph(request.params.id);
      return graph;
    } catch {
      return reply.code(404).send({ error: 'Graph not found' });
    }
  });

  // ── Get single node detail ───────────────────────────────────────────
  app.get<{
    Params: { id: string; nodeId: string };
  }>('/api/graphs/:id/nodes/:nodeId', async (request, reply) => {
    try {
      const node = await graphStore.loadNodeDetail(request.params.id, request.params.nodeId);
      return node;
    } catch {
      return reply.code(404).send({ error: 'Node not found' });
    }
  });

  // ── Get graph events ─────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/graphs/:id/events', async (request, reply) => {
    try {
      const events = await graphStore.loadEvents(request.params.id);
      return events;
    } catch {
      return reply.code(404).send({ error: 'Graph events not found' });
    }
  });
}
