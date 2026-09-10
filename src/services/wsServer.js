// src/services/wsServer.js
import { WebSocketServer } from 'ws';
import redis from './redisClient.js';

/**
 * Initialise WebSocket server attached to an existing HTTP server.
 * Subscribes to Redis channel "lead_updates" and forwards messages
 * to all connected WebSocket clients.
 *
 * @param {import('http').Server} httpServer - The HTTP server returned by app.listen().
 */
export function initWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    // Simple handshake acknowledgement.
    ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to real‑time lead updates' }));
  });

  // Use a Redis subscriber (duplicate connection) to avoid interfering with the main client.
  const subscriber = redis.duplicate();
  subscriber.connect().then(() => {
    subscriber.subscribe('lead_updates', (message) => {
      // Broadcast to every open client.
      wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
          client.send(message);
        }
      });
    });
  }).catch((err) => {
    console.warn('WebSocket server: failed to subscribe to Redis channel', err.message);
  });

  // Graceful shutdown handling.
  const shutdown = () => {
    subscriber.unsubscribe('lead_updates').finally(() => subscriber.quit());
    wss.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
