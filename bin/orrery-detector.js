#!/usr/bin/env node
/**
 * orrery-detector — Auto-detection daemon that discovers running AI coding agents.
 *
 * Polls for running AI processes every N seconds and emits agent_spawn / agent_done
 * events to the Orrery WebSocket server.
 *
 * Detected agents:
 *   - Claude Code   (process contains "claude", excludes orrery/detector)
 *   - Gemini CLI    (process contains "gemini")
 *   - Codex CLI     (process contains "codex")
 *   - Cursor        (process contains "cursor" AND "agent")
 *
 * Environment:
 *   ORRERY_WS_URL    WebSocket URL (default: ws://localhost:4242)
 *   POLL_INTERVAL    Polling interval in ms (default: 5000)
 */

import WebSocket from 'ws';
import { execSync } from 'child_process';
import { watch, createReadStream, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';

const WS_URL = process.env.ORRERY_WS_URL ?? 'ws://localhost:4242';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL ?? '5000', 10);
const SESSION_ID = 'detector';

// Agent detection rules
const AGENT_RULES = [
  {
    type: 'claude',
    test: (cmd) => /claude/i.test(cmd) && !/orrery/i.test(cmd) && !/detector/i.test(cmd),
  },
  {
    type: 'gemini',
    test: (cmd) => /gemini/i.test(cmd),
  },
  {
    type: 'codex',
    test: (cmd) => /codex/i.test(cmd),
  },
  {
    type: 'cursor',
    test: (cmd) => /cursor/i.test(cmd) && /agent/i.test(cmd),
  },
];

// State
const knownPids = new Map(); // pid -> { type, id, command }
let ws = null;
let pollTimer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// --- WebSocket management ---

function send(event) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
    return true;
  }
  return false;
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    ws = new WebSocket(`${WS_URL}?role=publisher`);
  } catch (err) {
    console.error(`[detector] WebSocket create failed: ${err.message}`);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log(`[detector] Connected to ${WS_URL}`);
    reconnectDelay = 1000;

    // Emit meta-event for the detector itself
    send({
      type: 'agent_spawn',
      id: 'detector',
      parentId: null,
      label: 'Agent Detector',
      sessionId: SESSION_ID,
      timestamp: Date.now(),
      metadata: { agentType: 'detector', pollInterval: POLL_INTERVAL },
    });

    // Start polling
    if (!pollTimer) {
      poll();
      pollTimer = setInterval(poll, POLL_INTERVAL);
    }
  });

  ws.on('close', () => {
    console.log('[detector] WebSocket closed');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`[detector] WebSocket error: ${err.message}`);
    // 'close' will fire after this, triggering reconnect
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`[detector] Reconnecting in ${reconnectDelay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    connect();
  }, reconnectDelay);
}

// --- Process detection ---

function scanProcesses() {
  try {
    // Use ps with TTY column to group processes by terminal session
    const output = execSync('ps -eo pid,tty,args --no-headers', { encoding: 'utf-8', timeout: 5000 });
    const lines = output.split('\n');

    // Group matching processes by (type, tty) — same agent in same terminal = one instance
    const groups = new Map(); // "type:tty" -> { type, tty, pids: [], command }

    for (const line of lines) {
      if (!line.trim()) continue;
      const match = line.trim().match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const tty = match[2];
      const command = match[3];

      for (const rule of AGENT_RULES) {
        if (rule.test(command)) {
          const key = `${rule.type}:${tty}`;
          if (!groups.has(key)) {
            groups.set(key, { type: rule.type, tty, pids: [], command });
          }
          groups.get(key).pids.push(pid);
          break;
        }
      }
    }

    return groups;
  } catch (err) {
    console.error(`[detector] ps failed: ${err.message}`);
    return new Map();
  }
}

function poll() {
  const current = scanProcesses();

  // Detect new agent groups
  for (const [key, info] of current) {
    if (!knownPids.has(key)) {
      const mainPid = Math.min(...info.pids);
      const id = `${info.type}-${mainPid}`;
      knownPids.set(key, { type: info.type, id, pids: info.pids, command: info.command, tty: info.tty });
      console.log(`[detector] Found ${info.type} agent: PID ${mainPid} (${info.pids.length} process${info.pids.length > 1 ? 'es' : ''}, ${info.tty})`);

      send({
        type: 'agent_spawn',
        id,
        parentId: null,
        label: `${info.type} (${info.tty.replace('pts/', 'tty ')})`,
        sessionId: SESSION_ID,
        timestamp: Date.now(),
        metadata: { agentType: info.type, pid: mainPid, pids: info.pids, tty: info.tty, command: info.command },
      });
    }
  }

  // Detect departed agent groups
  for (const [key, info] of knownPids) {
    if (!current.has(key)) {
      console.log(`[detector] Agent gone: ${info.type} ${info.tty}`);
      knownPids.delete(key);

      send({
        type: 'agent_done',
        id: info.id,
        sessionId: SESSION_ID,
        timestamp: Date.now(),
      });
    }
  }
}

// --- Codex log tailing ---

function watchCodexLog() {
  const logPath = join(homedir(), '.codex', 'log', 'codex-tui.log');
  if (!existsSync(logPath)) {
    console.log(`[detector] Codex log not found at ${logPath}, skipping log watcher`);
    return;
  }

  console.log(`[detector] Watching Codex log: ${logPath}`);

  // Start from current end of file so we only read new lines
  let lastSize = 0;
  try {
    lastSize = statSync(logPath).size;
  } catch {
    // ignore
  }

  const modelPatterns = [
    /model.*init/i,
    /api.*call/i,
    /completion.*request/i,
    /chat\.completions/i,
    /sending.*request/i,
  ];

  function tailNewLines() {
    try {
      const stream = createReadStream(logPath, { start: lastSize, encoding: 'utf-8' });
      const rl = createInterface({ input: stream });
      let newSize = lastSize;

      rl.on('line', (line) => {
        newSize += Buffer.byteLength(line, 'utf-8') + 1;
        for (const pattern of modelPatterns) {
          if (pattern.test(line)) {
            const callId = `codex-log-${Date.now().toString(36)}`;
            console.log(`[detector] Codex model call detected: ${line.substring(0, 80)}`);
            send({
              type: 'mcp_call',
              id: callId,
              parentId: findCodexAgent(),
              label: 'Codex model call',
              sessionId: SESSION_ID,
              timestamp: Date.now(),
              metadata: { source: 'codex-log', line: line.substring(0, 200) },
            });
            break;
          }
        }
      });

      rl.on('close', () => {
        lastSize = newSize > lastSize ? newSize : lastSize;
      });
    } catch (err) {
      console.error(`[detector] Error reading codex log: ${err.message}`);
    }
  }

  try {
    watch(logPath, (eventType) => {
      if (eventType === 'change') {
        tailNewLines();
      }
    });
  } catch (err) {
    console.error(`[detector] Failed to watch codex log: ${err.message}`);
  }
}

function findCodexAgent() {
  for (const info of knownPids.values()) {
    if (info.type === 'codex') return info.id;
  }
  return null;
}

// --- Shutdown ---

function shutdown() {
  console.log('\n[detector] Shutting down...');

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Emit agent_done for the detector itself
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({
      type: 'agent_done',
      id: 'detector',
      sessionId: SESSION_ID,
      timestamp: Date.now(),
    });
    ws.close();
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Main ---

console.log(`[detector] Starting agent detector (poll: ${POLL_INTERVAL}ms, ws: ${WS_URL})`);
connect();
watchCodexLog();
