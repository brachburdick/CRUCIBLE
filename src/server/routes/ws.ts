import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { RunEngine } from '../../engine/RunEngine.js';
import type { RunEvent } from '../../engine/RunEngine.js';

interface WsClient {
  socket: WebSocket;
  subscriptions: Set<string>; // runIds this client is subscribed to
  subscribeAll: boolean;       // if true, receives all events
}

export function registerWsRoutes(app: FastifyInstance, engine: RunEngine): void {
  const clients = new Set<WsClient>();

  // Broadcast run events to subscribed WebSocket clients
  engine.on('run:event', (event: RunEvent) => {
    const message = JSON.stringify({
      type: 'event',
      runId: event.runId,
      event: event.event,
      data: event.data,
      timestamp: event.timestamp,
    });

    for (const client of clients) {
      if (client.socket.readyState !== 1) continue; // OPEN = 1
      if (client.subscribeAll || client.subscriptions.has(event.runId)) {
        client.socket.send(message);
      }
    }

    // Also broadcast status changes for the run list
    if (event.event === 'run_started' || event.event === 'run_completed') {
      const statusMessage = JSON.stringify({
        type: 'status_change',
        runId: event.runId,
        event: event.event,
        data: event.data,
        timestamp: event.timestamp,
      });
      for (const client of clients) {
        if (client.socket.readyState !== 1) continue;
        if (client.subscribeAll) {
          // Already sent above, skip
          continue;
        }
        // Send status changes to all clients regardless of subscription
        client.socket.send(statusMessage);
      }
    }
  });

  app.get('/api/ws', { websocket: true }, (socket: WebSocket) => {
    const client: WsClient = {
      socket,
      subscriptions: new Set(),
      subscribeAll: false,
    };
    clients.add(client);

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; runId?: string };

        if (msg.type === 'subscribe' && msg.runId) {
          client.subscriptions.add(msg.runId);
        } else if (msg.type === 'unsubscribe' && msg.runId) {
          client.subscriptions.delete(msg.runId);
        } else if (msg.type === 'subscribe_all') {
          client.subscribeAll = true;
        } else if (msg.type === 'unsubscribe_all') {
          client.subscribeAll = false;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      clients.delete(client);
    });
  });
}
