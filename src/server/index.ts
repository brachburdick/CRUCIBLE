import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { RunEngine } from '../engine/RunEngine.js';
import type { CrucibleMetrics } from '../telemetry/metrics.js';
import type { SessionModel } from '../session/index.js';
import { GraphStore } from '../engine/GraphStore.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerWsRoutes } from './routes/ws.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerGraphRoutes } from './routes/graphs.js';
import { registerProjectRoutes } from './routes/projects.js';

export interface ServerOptions {
  port: number;
  engine: RunEngine;
  db: Database.Database;
  metrics?: CrucibleMetrics;
  session?: SessionModel;
}

export async function createServer(opts: ServerOptions) {
  const app = Fastify({ logger: false });

  // Register WebSocket plugin
  await app.register(fastifyWebsocket);

  // Register API routes
  registerRunRoutes(app, opts.engine, opts.db);
  registerWsRoutes(app, opts.engine);

  // Session and graph routes
  if (opts.session) {
    registerSessionRoutes(app, opts.session);
  }
  registerGraphRoutes(app, new GraphStore('runs'));

  // Cross-project routes — aggregates tasks/questions from all projects
  const projectsDir = path.resolve('..'); // CRUCIBLE lives in projects/, so .. = all sibling projects
  registerProjectRoutes(app, projectsDir);

  // Prometheus metrics endpoint
  if (opts.metrics) {
    const metrics = opts.metrics;
    app.get('/metrics', async (_request, reply) => {
      const metricsText = await metrics.getMetrics();
      return reply.type('text/plain; charset=utf-8').send(metricsText);
    });
  }

  // Health check
  app.get('/api/health', async () => ({ status: 'ok' }));

  // Serve static frontend (production build)
  const uiDistPath = path.resolve('ui', 'dist');
  if (fs.existsSync(uiDistPath)) {
    await app.register(fastifyStatic, {
      root: uiDistPath,
      prefix: '/',
    });

    // SPA fallback — serve index.html for non-API, non-file routes
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: opts.port, host: '0.0.0.0' });
  return app;
}
