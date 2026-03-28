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
import { createServer } from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.WS_PORT ?? '4242', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT ?? '4243', 10);
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Session recording state
const sessions = new Map(); // sessionId -> { events: [], metadata: {} }

// Track connected clients by role
const subscribers = new Set(); // dashboard instances
const publishers  = new Set(); // MCP processes

let eventCount = 0;

// Create WebSocket server
const wss = new WebSocketServer({ port: PORT });

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

        // Record to session
        const sessionId = payload.sessionId || 'default';
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            sessionId,
            events: [],
            metadata: {
              startTime: Date.now(),
              lastEventTime: Date.now()
            }
          });
        }
        const session = sessions.get(sessionId);
        session.events.push(payload);
        session.metadata.lastEventTime = Date.now();
        session.metadata.eventCount = session.events.length;

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

// ── Session persistence ───────────────────────────────────────────────────────

function saveSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || session.events.length === 0) return;

  const filename = `${sessionId}.json`;
  const filepath = path.join(SESSIONS_DIR, filename);

  const data = {
    sessionId: session.sessionId,
    metadata: {
      ...session.metadata,
      savedAt: Date.now(),
      duration: session.metadata.lastEventTime - session.metadata.startTime
    },
    events: session.events
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`[ws-server] Session saved: ${filename} (${session.events.length} events)`);
}

// Auto-save sessions every 10 seconds
setInterval(() => {
  for (const sessionId of sessions.keys()) {
    saveSession(sessionId);
  }
}, 10_000);

// Save all on shutdown
process.on('SIGINT', () => {
  console.log('\n[ws-server] Shutting down, saving sessions...');
  for (const sessionId of sessions.keys()) {
    saveSession(sessionId);
  }
  process.exit(0);
});

// ── HTTP API for session management ──────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${HTTP_PORT}`);

  // List all sessions
  if (url.pathname === '/sessions' && req.method === 'GET') {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const sessionList = files.map(filename => {
      const filepath = path.join(SESSIONS_DIR, filename);
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      return {
        sessionId: data.sessionId,
        filename,
        eventCount: data.events.length,
        startTime: data.metadata.startTime,
        duration: data.metadata.duration,
        lastEventTime: data.metadata.lastEventTime
      };
    }).sort((a, b) => b.startTime - a.startTime); // newest first

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessionList));
    return;
  }

  // Get specific session
  if (url.pathname.startsWith('/sessions/') && req.method === 'GET') {
    const sessionId = url.pathname.split('/')[2];
    const filepath = path.join(SESSIONS_DIR, `${sessionId}.json`);

    if (!fs.existsSync(filepath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const data = fs.readFileSync(filepath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[http-server] Session API listening on http://localhost:${HTTP_PORT}`);
  console.log(`  GET  /sessions        →  List all recorded sessions`);
  console.log(`  GET  /sessions/:id    →  Get session events for playback`);
});

// ── Status log ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (publishers.size > 0 || subscribers.size > 0) {
    console.log(
      `[ws-server] Status — publishers: ${publishers.size}  subscribers: ${subscribers.size}  events: ${eventCount}  sessions: ${sessions.size}`
    );
  }
}, 30_000);

console.log(`[ws-server] Listening on ws://localhost:${PORT}`);
console.log(`  Publishers  →  ws://localhost:${PORT}?role=publisher`);
console.log(`  Subscribers →  ws://localhost:${PORT}?role=subscriber`);
