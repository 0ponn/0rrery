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

// Session recording state — load saved sessions from disk on startup
const sessions = new Map(); // sessionId -> { events: [], metadata: {} }
try {
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
    if (data.sessionId && data.events) {
      sessions.set(data.sessionId, {
        sessionId: data.sessionId,
        events: data.events,
        metadata: data.metadata || { startTime: Date.now(), lastEventTime: Date.now(), eventCount: data.events.length },
      });
    }
  }
  if (files.length > 0) console.log(`[ws-server] Loaded ${files.length} saved session(s) from disk`);
} catch (err) {
  console.error(`[ws-server] Failed to load sessions: ${err.message}`);
}

// Track active agents
const activeAgents = new Map(); // agentId -> { id, label, agentType, pid, firstSeen, lastSeen, status, sessionId }

// Track connected clients by role
const subscribers = new Set(); // dashboard instances
const publishers  = new Set(); // MCP processes

let eventCount = 0;

// Track recent event timestamps for eventsPerMinute calculation
const recentEventTimestamps = [];

// Create HTTP server first for proper upgrade handling
const httpServerForWs = createServer((req, res) => {
  // Handle HTTP requests with CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Upgrade Required');
});

httpServerForWs.listen(PORT, '0.0.0.0', () => {
  console.log(`[ws-server] Listening on ws://localhost:${PORT}`);
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServerForWs });

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
        const isNewSession = !sessions.has(sessionId);
        if (isNewSession) {
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

        // Track recent event timestamps for eventsPerMinute
        recentEventTimestamps.push(Date.now());

        // Track agents from spawn/done events
        if (payload.type === 'agent_spawn' && payload.metadata?.agentType) {
          const agentId = payload.id || `agent-${Date.now()}`;
          const existing = activeAgents.get(agentId);
          activeAgents.set(agentId, {
            id: agentId,
            label: payload.label || agentId,
            agentType: payload.metadata.agentType,
            pid: payload.metadata.pid || null,
            firstSeen: existing?.firstSeen || Date.now(),
            lastSeen: Date.now(),
            status: 'active',
            sessionId,
          });
        } else if (payload.type === 'agent_done') {
          const agentId = payload.id || payload.metadata?.agentId;
          if (agentId && activeAgents.has(agentId)) {
            const agent = activeAgents.get(agentId);
            agent.lastSeen = Date.now();
            agent.status = 'done';
          }
        }

        broadcast(payload);

        // Notify subscribers of new session
        if (isNewSession) {
          broadcast({
            type: 'session_list',
            sessions: [...sessions.keys()].map(sid => {
              const s = sessions.get(sid);
              return {
                sessionId: sid,
                eventCount: s.events.length,
                startTime: s.metadata.startTime,
                duration: Date.now() - s.metadata.startTime,
              };
            }),
          });
        }
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

    // Replay active session events so dashboard shows current state immediately
    for (const session of sessions.values()) {
      if (session.events.length > 0) {
        ws.send(JSON.stringify(session.events));
      }
    }

    // Send current active agents list
    if (activeAgents.size > 0) {
      const agentsList = [...activeAgents.values()]
        .sort((a, b) => b.lastSeen - a.lastSeen);
      ws.send(JSON.stringify({
        type: 'agents_list',
        agents: agentsList,
        timestamp: Date.now(),
      }));
    }

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

  // List all tracked agents
  if (url.pathname === '/agents' && req.method === 'GET') {
    const agentsList = [...activeAgents.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agentsList));
    return;
  }

  // Aggregated statistics
  if (url.pathname === '/stats' && req.method === 'GET') {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Clean up old timestamps and count recent ones
    while (recentEventTimestamps.length > 0 && recentEventTimestamps[0] < oneMinuteAgo) {
      recentEventTimestamps.shift();
    }

    // Count total tokens from model_call events
    let totalTokens = 0;
    for (const session of sessions.values()) {
      for (const event of session.events) {
        if (event.type === 'model_call' && event.metadata?.tokens) {
          totalTokens += event.metadata.tokens;
        }
      }
    }

    // Count agents by type
    const agentsByType = {};
    let activeCount = 0;
    for (const agent of activeAgents.values()) {
      if (agent.status === 'active') activeCount++;
      agentsByType[agent.agentType] = (agentsByType[agent.agentType] || 0) + 1;
    }

    const stats = {
      activeAgents: activeCount,
      totalAgents: activeAgents.size,
      totalEvents: eventCount,
      totalSessions: sessions.size,
      totalTokens,
      estimatedCost: totalTokens * 0.000003, // rough estimate
      eventsPerMinute: parseFloat((recentEventTimestamps.length / 1).toFixed(1)),
      agentsByType,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
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
  console.log(`  GET  /agents          →  List all tracked agents`);
  console.log(`  GET  /stats           →  Aggregated statistics`);
});

// ── Status log ────────────────────────────────────────────────────────────────

setInterval(() => {
  if (publishers.size > 0 || subscribers.size > 0) {
    console.log(
      `[ws-server] Status — publishers: ${publishers.size}  subscribers: ${subscribers.size}  events: ${eventCount}  sessions: ${sessions.size}`
    );
  }
}, 30_000);

console.log(`  Publishers  →  ws://localhost:${PORT}?role=publisher`);
console.log(`  Subscribers →  ws://localhost:${PORT}?role=subscriber`);
