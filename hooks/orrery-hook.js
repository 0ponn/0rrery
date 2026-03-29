#!/usr/bin/env node
/**
 * orrery-hook.js - Claude Code hook for Orrery visualization
 *
 * Sends tool events to Orrery WebSocket server for real-time visualization.
 * Uses stable session ID per Claude Code process.
 */

import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Stable Session ID ─────────────────────────────────────────────────────────
// Use PPID (parent process ID) to get stable ID per Claude Code session
// Falls back to a file-based session ID if PPID not useful

const WS_URL = process.env.ORRERY_WS_URL ?? 'ws://localhost:4242';
const PPID = process.ppid || process.pid;

// Session file to persist session ID across hook invocations
const SESSION_FILE = path.join(os.tmpdir(), `orrery-session-${PPID}.json`);

function getOrCreateSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
      // Check if session is still fresh (less than 1 hour old)
      if (Date.now() - data.created < 3600000) {
        return data;
      }
    }
  } catch {}

  // Create new session
  const session = {
    sessionId: `session-${PPID}-${Date.now().toString(36).slice(-4)}`,
    agentId: `agent-${PPID}`,
    created: Date.now(),
    announced: false
  };

  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session));
  } catch {}

  return session;
}

const SESSION = getOrCreateSession();

// ── Event Sending ─────────────────────────────────────────────────────────────

async function sendEvent(event) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(`${WS_URL}?role=publisher`);
      const timeout = setTimeout(() => { ws.close(); resolve(); }, 2000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          ...event,
          sessionId: SESSION.sessionId,
          timestamp: Date.now()
        }));
        clearTimeout(timeout);
        ws.close();
        resolve();
      });

      ws.on('error', () => { clearTimeout(timeout); resolve(); });
    } catch {
      resolve();
    }
  });
}

// ── Announce Agent (once per session) ─────────────────────────────────────────

async function announceIfNeeded() {
  if (SESSION.announced) return;

  await sendEvent({
    type: 'agent_spawn',
    id: SESSION.agentId,
    parentId: null,  // Top-level agent, no parent
    label: `Claude (${PPID})`
  });

  SESSION.announced = true;
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(SESSION));
  } catch {}
}

// ── Tool Event Builder ────────────────────────────────────────────────────────

function buildToolEvent(toolName, toolInput) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Determine event type and label
  if (toolName === 'Task') {
    return {
      type: 'agent_spawn',
      id: `subagent-${id}`,
      parentId: SESSION.agentId,
      label: toolInput?.description || 'Sub-agent'
    };
  }

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1];
    const method = parts.slice(2).join(':');
    return {
      type: 'mcp_call',
      id,
      parentId: SESSION.agentId,
      label: `${server}:${method}`
    };
  }

  if (toolName === 'Bash') {
    const cmd = (toolInput?.command || '').split(/\s+/)[0];
    return {
      type: 'mcp_call',
      id,
      parentId: SESSION.agentId,
      label: `bash:${cmd}`
    };
  }

  // File operations
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(toolName)) {
    const target = toolInput?.file_path || toolInput?.path || toolInput?.pattern || '';
    const short = target.split('/').slice(-2).join('/');
    return {
      type: 'mcp_call',
      id,
      parentId: SESSION.agentId,
      label: `${toolName.toLowerCase()}:${short}`
    };
  }

  // Default
  return {
    type: 'mcp_call',
    id,
    parentId: SESSION.agentId,
    label: toolName
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Read hook input from stdin
  let input = '';
  try {
    input = await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('readable', () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) data += chunk;
      });
      process.stdin.on('end', () => resolve(data.trim()));
      setTimeout(() => resolve(data.trim()), 100);
    });
  } catch {
    process.exit(0);
  }

  if (!input) process.exit(0);

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const { tool_name, tool_input } = hookData;
  if (!tool_name) process.exit(0);

  // Announce agent on first tool call
  await announceIfNeeded();

  // Build and send tool event
  const event = buildToolEvent(tool_name, tool_input);
  if (event) {
    await sendEvent(event);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
