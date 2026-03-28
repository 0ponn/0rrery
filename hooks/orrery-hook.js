#!/usr/bin/env node
/**
 * orrery-hook.js
 * Claude Code hook for Orrery auto-instrumentation.
 *
 * Install in your Claude Code settings.json:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "*", "hooks": ["node /path/to/orrery/hooks/orrery-hook.js"] }
 *     ]
 *   }
 *
 * Or for specific tools:
 *
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "mcp__*", "hooks": ["node /path/to/orrery/hooks/orrery-hook.js"] },
 *       { "matcher": "Read|Write|Edit|Glob|Grep", "hooks": ["node /path/to/orrery/hooks/orrery-hook.js"] },
 *       { "matcher": "Task", "hooks": ["node /path/to/orrery/hooks/orrery-hook.js"] }
 *     ]
 *   }
 *
 * Environment variables:
 *   ORRERY_WS_URL       - WebSocket server URL (default: ws://localhost:4242)
 *   ORRERY_AGENT_ID     - Current agent ID (default: orch)
 *   ORRERY_SESSION_ID   - Session ID (default: auto-generated)
 *   ORRERY_SILENT       - Suppress hook output (default: false)
 */

import { WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Config ────────────────────────────────────────────────────────────────────

const WS_URL = process.env.ORRERY_WS_URL ?? 'ws://localhost:4242';
const AGENT_ID = process.env.ORRERY_AGENT_ID ?? 'orch';
const SESSION_ID = process.env.ORRERY_SESSION_ID ?? `session-${Date.now().toString(36).slice(-6)}`;
const SILENT = process.env.ORRERY_SILENT === 'true';

// Load auto-approve patterns from settings
let AUTO_APPROVE_PATTERNS = [];
try {
  const settingsPath = path.join(os.homedir(), 'dotfiles/.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  AUTO_APPROVE_PATTERNS = settings.autoApproveToolUsePatterns || [];
} catch {
  // Ignore if settings not found
}

// ── Tool categorization ───────────────────────────────────────────────────────

const CATEGORIES = {
  // File tools
  Read: 'file_access',
  Write: 'file_access',
  Edit: 'file_access',
  Glob: 'file_access',
  Grep: 'file_access',
  NotebookEdit: 'file_access',

  // API tools
  WebFetch: 'api_call',
  WebSearch: 'api_call',

  // Agent tool
  Task: 'agent_spawn',
};

// ── Permission Inference ──────────────────────────────────────────────────────

function isAutoApproved(toolName, toolInput) {
  // Check if this tool matches any auto-approve pattern
  for (const pattern of AUTO_APPROVE_PATTERNS) {
    if (typeof pattern === 'string') {
      // Simple string match or wildcard
      if (pattern === '*' || pattern === toolName) return true;
      // Glob-style patterns
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      if (regex.test(toolName)) return true;
    } else if (typeof pattern === 'object' && pattern.tool) {
      // Object pattern with tool and optional input matching
      if (pattern.tool === toolName || pattern.tool === '*') {
        return true;
      }
    }
  }
  return false;
}

function formatPermissionLabel(toolName, toolInput) {
  switch (toolName) {
    case 'Read':
      return `Read: ${toolInput?.file_path || 'unknown'}`;
    case 'Write':
      return `Write: ${toolInput?.file_path || 'unknown'}`;
    case 'Edit':
      return `Edit: ${toolInput?.file_path || 'unknown'}`;
    case 'Bash':
      const cmd = toolInput?.command || '';
      return `Execute: ${cmd.slice(0, 50)}${cmd.length > 50 ? '...' : ''}`;
    case 'Task':
      return `Spawn: ${toolInput?.description || 'sub-agent'}`;
    case 'WebFetch':
      return `Fetch: ${toolInput?.url || 'unknown'}`;
    case 'WebSearch':
      return `Search: ${toolInput?.query || 'unknown'}`;
    default:
      if (toolName.startsWith('mcp__')) {
        return toolName.replace('mcp__', '').replace(/__/g, ':');
      }
      return toolName;
  }
}

async function emitPermissionFlow(toolName, toolInput) {
  const autoApproved = isAutoApproved(toolName, toolInput);

  // Skip permission events for tools that never need approval
  if (toolName === 'AskUserQuestion' || toolName === 'TaskList') return;

  // Generate a permission ID
  const permId = `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Emit permission request
  await sendEvent({
    type: 'permission_request',
    id: permId,
    parentId: AGENT_ID,
    sessionId: SESSION_ID,
    label: formatPermissionLabel(toolName, toolInput),
    action: autoApproved ? 'Auto-approved' : 'Manual approval',
  });

  // If auto-approved, immediately emit resolution (small delay for visual effect)
  if (autoApproved) {
    setTimeout(async () => {
      await sendEvent({
        type: 'permission_resolve',
        id: permId,
        sessionId: SESSION_ID,
        status: 'approved',
      });
    }, 50);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Read hook input from stdin
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch (e) {
    if (!SILENT) console.error('[orrery-hook] Failed to parse input:', e.message);
    process.exit(0);
  }

  const { tool_name, tool_input } = hookData;
  if (!tool_name) {
    process.exit(0);
  }

  // Check if tool needs permission and emit permission flow
  await emitPermissionFlow(tool_name, tool_input);

  // Build topology event
  const event = buildEvent(tool_name, tool_input);
  if (!event) {
    process.exit(0);
  }

  // Send to WebSocket server
  await sendEvent(event);

  // Always allow tool to proceed
  process.exit(0);
}

// ── Event Builder ─────────────────────────────────────────────────────────────

function buildEvent(toolName, toolInput) {
  const timestamp = Date.now();
  const id = `${timestamp}-${Math.random().toString(36).slice(2, 7)}`;

  // Check explicit category
  if (CATEGORIES[toolName]) {
    const type = CATEGORIES[toolName];

    if (type === 'agent_spawn') {
      // Task tool — emit pending, actual spawn tracked separately
      return null; // Don't emit here, let PostToolUse handle it
    }

    return {
      type,
      id,
      timestamp,
      parentId: AGENT_ID,
      sessionId: SESSION_ID,
      label: extractLabel(toolName, toolInput),
    };
  }

  // MCP tools
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1];
    const op = parts.slice(2).join('_');

    // Special labels for engram
    if (server === 'engram') {
      const isWrite = ['mem_save', 'mem_update', 'mem_delete', 'mem_session_start', 'mem_session_end', 'mem_session_summary', 'mem_save_prompt', 'mem_capture_passive'].includes(op);
      return {
        type: 'mcp_call',
        id,
        timestamp,
        parentId: AGENT_ID,
        label: `engram:${isWrite ? 'write' : 'read'} ${extractEngramDetail(op, toolInput)}`,
      };
    }

    // Special labels for headroom
    if (server === 'headroom') {
      return {
        type: 'mcp_call',
        id,
        timestamp,
        parentId: AGENT_ID,
        label: `headroom:${op}`,
      };
    }

    // PPR IPC tools
    if (server === 'ppr') {
      if (op === 'ipc_publish' || op === 'ipc_request') {
        const topic = toolInput?.topic ?? '';
        return {
          type: 'ipc_message',
          id,
          timestamp,
          source: AGENT_ID,
          target: topic.split('.')[0] ?? 'bus',
          message: topic,
        };
      }
      return {
        type: 'mcp_call',
        id,
        timestamp,
        parentId: AGENT_ID,
        label: `ppr:${op}`,
      };
    }

    // Generic MCP
    return {
      type: 'mcp_call',
      id,
      timestamp,
      parentId: AGENT_ID,
      label: `${server}:${op}`,
    };
  }

  // Bash
  if (toolName === 'Bash') {
    const cmd = toolInput?.command ?? '';
    const firstWord = cmd.split(/\s+/)[0];
    return {
      type: 'mcp_call',
      id,
      timestamp,
      parentId: AGENT_ID,
      label: `bash:${firstWord}`,
    };
  }

  // Default: generic MCP call
  return {
    type: 'mcp_call',
    id,
    timestamp,
    parentId: AGENT_ID,
    label: toolName,
  };
}

// ── Label Extractors ──────────────────────────────────────────────────────────

function extractLabel(toolName, input) {
  const path = input?.file_path ?? input?.path ?? input?.pattern ?? '';
  const shortPath = path.split('/').slice(-2).join('/');

  switch (toolName) {
    case 'Read':
      return `read: ${shortPath}`;
    case 'Write':
      return `write: ${shortPath}`;
    case 'Edit':
      return `edit: ${shortPath}`;
    case 'Glob':
      return `glob: ${input?.pattern ?? '*'}`;
    case 'Grep':
      return `grep: ${truncate(input?.pattern ?? '', 20)}`;
    case 'WebFetch':
      try {
        const url = new URL(input?.url ?? '');
        return `fetch: ${url.hostname}`;
      } catch {
        return 'WebFetch';
      }
    case 'WebSearch':
      return `search: ${truncate(input?.query ?? '', 25)}`;
    default:
      return `${toolName}: ${shortPath}`;
  }
}

function extractEngramDetail(op, input) {
  switch (op) {
    case 'mem_save':
      return truncate(input?.title ?? '', 25);
    case 'mem_search':
      return `"${truncate(input?.query ?? '', 20)}"`;
    case 'mem_context':
      return input?.project ? `[${input.project}]` : '';
    case 'mem_get_observation':
    case 'mem_update':
    case 'mem_delete':
      return `#${input?.id ?? '?'}`;
    default:
      return '';
  }
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

// ── WebSocket Send ────────────────────────────────────────────────────────────

async function sendEvent(event) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}?role=publisher`);
    const timeout = setTimeout(() => {
      ws.close();
      resolve();
    }, 2000);

    ws.on('open', () => {
      ws.send(JSON.stringify(event));
      clearTimeout(timeout);
      ws.close();
      resolve();
    });

    ws.on('error', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

// ── Stdin Reader ──────────────────────────────────────────────────────────────

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on('end', () => resolve(data.trim()));
    // Timeout if no input
    setTimeout(() => resolve(data.trim()), 100);
  });
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((e) => {
  if (!SILENT) console.error('[orrery-hook] Error:', e.message);
  process.exit(0);
});
