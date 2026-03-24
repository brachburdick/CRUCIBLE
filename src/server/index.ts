import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type Database from 'better-sqlite3';
import type { RunEngine } from '../engine/RunEngine.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerWsRoutes } from './routes/ws.js';

export interface ServerOptions {
  port: number;
  engine: RunEngine;
  db: Database.Database;
}

export async function createServer(opts: ServerOptions) {
  const app = Fastify({ logger: false });

  // Register WebSocket plugin
  await app.register(fastifyWebsocket);

  // Register API routes
  registerRunRoutes(app, opts.engine, opts.db);
  registerWsRoutes(app, opts.engine);

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
