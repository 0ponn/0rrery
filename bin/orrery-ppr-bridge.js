#!/usr/bin/env node
/**
 * orrery-ppr-bridge — Bridges the PPR IPC bus to Orrery's WebSocket server.
 *
 * Subscribes to all PPR bus traffic and translates messages into Orrery
 * topology events. Agents on the PPR bus are automatically detected and
 * visualized in the dashboard.
 *
 * Usage:
 *   node orrery-ppr-bridge.js
 *
 * Environment:
 *   ORRERY_WS_URL   WebSocket URL (default: ws://localhost:4242)
 *   PPR_BUS_NAME    PPR bus name (default: ppr)
 */

import WebSocket from 'ws';

const WS_URL = process.env.ORRERY_WS_URL ?? 'ws://localhost:4242';
const SESSION_ID = `ppr-bridge-${Date.now().toString(36).slice(-4)}`;

// Track known agents to auto-spawn them in orrery
const knownAgents = new Set();
let ws = null;
let reconnectTimer = null;

function connectWs() {
  ws = new WebSocket(`${WS_URL}?role=publisher`);

  ws.on('open', () => {
    console.log(`[orrery-ppr] Connected to ${WS_URL}`);
    // Announce bridge as an agent
    send({
      type: 'agent_spawn',
      id: 'ppr-bridge',
      parentId: null,
      label: 'PPR Bus Bridge',
      sessionId: SESSION_ID,
    });
  });

  ws.on('close', () => {
    console.log('[orrery-ppr] Disconnected, reconnecting in 3s...');
    reconnectTimer = setTimeout(connectWs, 3000);
  });

  ws.on('error', (err) => {
    console.error(`[orrery-ppr] WS error: ${err.message}`);
  });
}

function send(payload) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ ...payload, timestamp: Date.now() }));
  }
}

function ensureAgent(agentId) {
  if (!agentId || knownAgents.has(agentId)) return;
  knownAgents.add(agentId);
  send({
    type: 'agent_spawn',
    id: agentId,
    parentId: 'ppr-bridge',
    label: agentId,
    sessionId: SESSION_ID,
  });
}

// Poll PPR bus for messages using the MCP tools
// Since we can't import PPR directly, we use a stdin/stdout approach
// to communicate with the PPR MCP server

async function pollPprViaStdin() {
  // Read from stdin - expects JSON lines from a PPR subscriber
  // Usage: ppr_subscriber | node orrery-ppr-bridge.js
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      handlePprMessage(msg);
    } catch {}
  });

  rl.on('close', () => {
    console.log('[orrery-ppr] stdin closed');
    cleanup();
  });
}

function handlePprMessage(msg) {
  const { topic, payload, sender, recipient } = msg;

  // Auto-detect agents
  if (sender) ensureAgent(sender);
  if (recipient) ensureAgent(recipient);

  // Translate PPR messages to orrery events
  if (topic?.startsWith('agent.spawn') || msg.type === 'agent_spawn') {
    const id = payload?.id || sender;
    ensureAgent(id);
  } else if (topic?.startsWith('agent.done') || msg.type === 'agent_done') {
    send({
      type: 'agent_done',
      id: payload?.id || sender,
      sessionId: SESSION_ID,
    });
  } else if (sender && recipient) {
    // Generic IPC message between agents
    send({
      type: 'ipc_message',
      source: sender,
      target: recipient,
      message: topic ? `${topic}: ${truncate(JSON.stringify(payload), 60)}` : truncate(JSON.stringify(payload), 80),
      sessionId: SESSION_ID,
    });
  } else if (topic) {
    // Broadcast message — show as MCP call from sender
    if (sender) {
      send({
        type: 'mcp_call',
        id: `ppr-${Date.now().toString(36)}`,
        parentId: sender,
        label: `ppr:${topic}`,
        sessionId: SESSION_ID,
      });
    }
  }
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}

function cleanup() {
  clearTimeout(reconnectTimer);
  send({ type: 'agent_done', id: 'ppr-bridge', sessionId: SESSION_ID });
  setTimeout(() => {
    ws?.close();
    process.exit(0);
  }, 500);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Start
connectWs();

// Check if stdin is a pipe (data being fed in)
if (!process.stdin.isTTY) {
  console.log('[orrery-ppr] Reading from stdin (pipe mode)');
  pollPprViaStdin();
} else {
  console.log('[orrery-ppr] No stdin pipe detected.');
  console.log('[orrery-ppr] Waiting for PPR messages on stdin.');
  console.log('[orrery-ppr] Usage: ppr_subscriber | node orrery-ppr-bridge.js');
  console.log('[orrery-ppr] Or send JSON lines to stdin manually.');
  pollPprViaStdin();
}
