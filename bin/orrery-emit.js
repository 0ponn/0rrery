#!/usr/bin/env node
/**
 * orrery-emit — Lightweight CLI to send events to the Orrery topology server.
 *
 * Usage:
 *   orrery-emit agent_spawn --id myagent --label "My Agent"
 *   orrery-emit agent_spawn --id myagent --label "My Agent" --parent orch
 *   orrery-emit agent_done --id myagent
 *   orrery-emit model_call --id call1 --parent myagent --label "gpt-4" --tokens 1500
 *   orrery-emit mcp_call --id mc1 --parent myagent --label "memory-mcp"
 *   orrery-emit ipc_message --source agent1 --target agent2 --message "hello"
 *   orrery-emit file_access --id f1 --parent myagent --label "src/main.rs"
 *   orrery-emit api_call --id api1 --parent myagent --label "OpenAI API"
 */

import WebSocket from 'ws';

const WS_URL = process.env.ORRERY_WS_URL ?? 'ws://localhost:4242';
const SESSION_ID = process.env.ORRERY_SESSION_ID ?? `cli-${process.ppid || 'manual'}`;

const args = process.argv.slice(2);
const type = args[0];

if (!type || type === '--help' || type === '-h') {
  console.log(`Usage: orrery-emit <event-type> [options]

Event types:
  agent_spawn   --id <id> --label <name> [--parent <id>]
  agent_done    --id <id>
  model_call    --id <id> --parent <id> --label <model> [--tokens <n>]
  mcp_call      --id <id> --parent <id> --label <tool>
  file_access   --id <id> --parent <id> --label <path>
  api_call      --id <id> --parent <id> --label <api>
  ipc_message   --source <id> --target <id> --message <text>
  handoff       --source <id> --target <id> --label <desc>

Options:
  --session <id>   Session ID (default: cli-<ppid>)
  --ws <url>       WebSocket URL (default: ws://localhost:4242)

Environment:
  ORRERY_WS_URL       WebSocket URL
  ORRERY_SESSION_ID   Session ID`);
  process.exit(0);
}

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const sessionId = getArg('session') || SESSION_ID;
const wsUrl = getArg('ws') || WS_URL;

const payload = { type, sessionId, timestamp: Date.now() };

// Build payload based on type
switch (type) {
  case 'agent_spawn':
  case 'model_call':
  case 'mcp_call':
  case 'file_access':
  case 'api_call':
  case 'permission_request':
    payload.id = getArg('id') || `${type}-${Date.now().toString(36)}`;
    payload.parentId = getArg('parent') || null;
    payload.label = getArg('label') || payload.id;
    if (type === 'model_call') {
      const tokens = getArg('tokens');
      if (tokens) payload.metadata = { tokens: parseInt(tokens, 10) };
    }
    if (type === 'permission_request') {
      payload.action = getArg('action') || 'Unknown action';
    }
    break;
  case 'agent_done':
    payload.id = getArg('id');
    if (!payload.id) { console.error('--id required'); process.exit(1); }
    break;
  case 'permission_resolve':
    payload.id = getArg('id');
    payload.status = getArg('status') || 'approved';
    break;
  case 'ipc_message':
    payload.source = getArg('source');
    payload.target = getArg('target');
    payload.message = getArg('message') || '';
    if (!payload.source || !payload.target) {
      console.error('--source and --target required');
      process.exit(1);
    }
    break;
  case 'handoff':
    payload.source = getArg('source');
    payload.target = getArg('target');
    payload.label = getArg('label') || 'handoff';
    if (!payload.source || !payload.target) {
      console.error('--source and --target required');
      process.exit(1);
    }
    break;
  default:
    console.error(`Unknown event type: ${type}`);
    process.exit(1);
}

// Send via WebSocket
const ws = new WebSocket(`${wsUrl}?role=publisher`);
const timeout = setTimeout(() => {
  console.error('Connection timeout');
  process.exit(1);
}, 3000);

ws.on('open', () => {
  clearTimeout(timeout);
  ws.send(JSON.stringify(payload));
  console.log(`Sent ${type}: ${payload.id || payload.source + '->' + payload.target}`);
  ws.close();
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  console.error(`Failed to connect to ${wsUrl}: ${err.message}`);
  process.exit(1);
});
