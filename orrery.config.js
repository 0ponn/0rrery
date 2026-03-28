/**
 * orrery.config.js
 * Central configuration for Orrery — agent workflow topology visualizer.
 */

import { homedir } from 'os';
import { join } from 'path';

// Resolve ~ to home directory
const expandHome = (p) => p.startsWith('~') ? join(homedir(), p.slice(1)) : p;

export default {
  // WebSocket server configuration
  wsPort: parseInt(process.env.WS_PORT ?? '4242', 10),
  wsUrl: process.env.WS_URL ?? 'ws://localhost:4242',

  // Node lifecycle
  nodeTtlMs: 60000,       // Cull nodes inactive > 60s
  cullIntervalMs: 5000,   // Culling check frequency

  // Root node
  orchestratorId: 'orch',
  permanentIds: ['orch'], // Nodes that are never culled

  // Tool binary paths — override with env vars
  tools: {
    ppr: expandHome(
      process.env.PPR_BIN ?? '~/Documents/GitHub/Dev/parallax-process-runtime-master/build/bin/mcp_server'
    ),
    rtk: expandHome(
      process.env.RTK_BIN ?? '~/.cargo/bin/rtk'
    ),
    engram: expandHome(
      process.env.ENGRAM_BIN ?? '~/go/bin/engram'
    ),
  },

  // Instrumentation labels
  labels: {
    engram: {
      read: 'engram:read',
      write: 'engram:write',
    },
    headroom: {
      compress: 'headroom:compress',
      retrieve: 'headroom:retrieve',
    },
  },
};
