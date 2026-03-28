/**
 * ws-server.js
 * WebSocket broadcast server for Agent Topology Dashboard.
 *
 * Publishers  — your MCP processes (proxy, IPC, etc.) connect and send events
 * Subscribers — the dashboard connects and receives all events
 *
 * Usage:
 *   node ws-server.js
 *   WS_PORT=9000 node ws-server.js
 */

import { WebSocketServer, WebSocket } from 'ws';

const PORT = parseInt(process.env.WS_PORT ?? '4242', 10);

const wss = new WebSocketServer({ port: PORT });

// Track connected clients by role
const subscribers = new Set(); // dashboard instances
const publishers  = new Set(); // MCP processes

let eventCount = 0;

// ── Broadcast to all dashboard subscribers ────────────────────────────────────

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of subscribers) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── Connection handler ────────────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const ip   = req.socket.remoteAddress;
  const role = new URL(req.url, `ws://localhost`).searchParams.get('role') ?? 'subscriber';

  if (role === 'publisher') {
    publishers.add(ws);
    console.log(`[+] Publisher connected  (${ip}) — total: ${publishers.size}`);

    ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data);
        // Stamp server-side receipt time if not present
        if (!payload.timestamp) payload.timestamp = Date.now();
        eventCount++;
        broadcast(payload);
      } catch (err) {
        console.error('[ws-server] Parse error from publisher:', err.message);
      }
    });

    ws.on('close', () => {
      publishers.delete(ws);
      console.log(`[-] Publisher disconnected — total: ${publishers.size}`);
    });

  } else {
    subscribers.add(ws);
    console.log(`[+] Subscriber connected (${ip}) — total: ${subscribers.size}`);

    // Send connection ack so dashboard shows 'connected' immediately
    ws.send(JSON.stringify({
      type: 'system',
      id: `sys-${Date.now()}`,
      timestamp: Date.now(),
      label: `Connected to topology server · ${eventCount} events so far`,
    }));

    ws.on('close', () => {
      subscribers.delete(ws);
      console.log(`[-] Subscriber disconnected — total: ${subscribers.size}`);
    });
  }

  ws.on('error', (err) => {
    console.error(`[ws-server] Socket error (${role} @ ${ip}):`, err.message);
  });
});

// ── Status log ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (publishers.size > 0 || subscribers.size > 0) {
    console.log(
      `[ws-server] Status — publishers: ${publishers.size}  subscribers: ${subscribers.size}  events: ${eventCount}`
    );
  }
}, 30_000);

console.log(`[ws-server] Listening on ws://localhost:${PORT}`);
console.log(`  Publishers  →  ws://localhost:${PORT}?role=publisher`);
console.log(`  Subscribers →  ws://localhost:${PORT}?role=subscriber`);
