# Orrery

Real-time agent workflow topology visualizer for Claude Code.

Orrery watches what happens when you submit a prompt and visualizes the entire workflow as a live force-directed graph: agents spawning, model calls, MCP interactions, IPC messages, handoffs between agents/models, API calls, and permission requests/resolutions.

---

## Architecture

```
Claude Code Agents
       ↓
  ┌─────────────────────────────────────────────────┐
  │              Instrumentation Layer              │
  ├─────────────┬─────────────┬─────────────┬───────┤
  │ PPR Emitter │  RTK Hook   │  Headroom   │Engram │
  └─────────────┴─────────────┴─────────────┴───────┘
       ↓                ↓             ↓          ↓
  mcp-emitter.js  ──────────────────────────────────→  ws-server.js  ──→  Dashboard
```

---

## Project Structure

```
orrery/
├── README.md                     # This file
├── package.json                  # Dependencies
├── orrery.config.js              # Central configuration
├── ws-server.js                  # WebSocket broadcast server
├── mcp-emitter.js                # TopologyEmitter class
├── start.sh                      # Startup script
├── dashboard/
│   ├── index.html                # Vite entry point
│   ├── main.jsx                  # React mount
│   ├── vite.config.js            # Vite configuration
│   ├── useTopologySocket.js      # React WebSocket hook
│   └── AgentTopologyDashboard.jsx # Dashboard component
├── hooks/
│   └── orrery-hook.js            # Claude Code PreToolUse hook
└── instrumentation/
    ├── index.js                  # Unified entry point
    ├── ppr-emitter.js            # PPR message routing
    ├── rtk-hook.js               # RTK PreToolUse hook
    ├── headroom-emitter.js       # Headroom context tracking
    └── engram-emitter.js         # Engram memory operations
```

---

## Quick Start

### 1. Start the WebSocket server

```bash
cd orrery
./start.sh

# Or manually:
npm install
node ws-server.js
```

### 2. Start the dashboard

```bash
cd dashboard
npm install
npm run dev
# Opens http://localhost:3000
```

### 3. Run the demo

Click "RUN DEMO" in the dashboard to see a simulated workflow.

### 4. Interactive controls

- **Drag** to pan the canvas
- **Scroll/pinch** to zoom in/out
- **Double-click** to reset zoom
- Use **zoom buttons** (bottom-right) for precise control

### 5. Multi-session support

When multiple Claude Code sessions connect, a session switcher appears in the header. Switch between sessions to see their individual topology graphs.

### 6. Permission visualization

Orrery now infers permissions from your `autoApproveToolUsePatterns` setting:
- Tools matching auto-approve patterns → show as **permission_request** + instant **approved**
- Tools not in patterns → show as **permission_request** (would require manual approval)
- Watch the **Permissions** panel (right side) for all permission activity

### 7. Multiple visualization modes

Switch between three complementary views using the tabs in the header:

#### **Graph View** (default)
- Force-directed node graph showing topology and relationships
- Interactive: drag, zoom, pan
- Real-time updates with visual feedback
- Best for: Understanding structure and dependencies

#### **Timeline View**
- Horizontal swimlanes showing temporal execution
- Bars represent operation duration
- Arrows show handoffs and IPC between agents
- Best for: Understanding parallelism, bottlenecks, and timing

#### **Metrics View**
- Aggregated analytics and statistics
- Event breakdown by type
- Token usage by model
- Most active agents
- Permission approval rates
- Best for: Understanding performance and resource usage

Each view shows the same data from different perspectives, revealing different insights about your agent workflows.

---

## Auto-Instrumentation (Recommended)

Add the Orrery hook to your Claude Code settings for automatic instrumentation of all tool calls.

### Option 1: Claude Code Hook (Zero Config)

Add to your `~/.config/claude-code/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": ["node ~/Documents/GitHub/orrery/hooks/orrery-hook.js"]
      }
    ]
  }
}
```

That's it. Every tool call will now appear in your dashboard.

### Option 2: Programmatic (Advanced)

Use the unified instrumentation API in your own code:

```js
import { createOrreryHooks } from 'orrery/instrumentation';

const hooks = createOrreryHooks({
  wsUrl: 'ws://localhost:4242',
  defaultAgentId: 'my-agent',
});

// Auto-route any tool call
hooks.onToolUse('mcp__engram__mem_save', { title: 'Fixed auth bug' });

// Manual events
hooks.onAgentSpawn({ id: 'sub-1', label: 'Code Agent' });
hooks.onModelCall({ model: 'claude-sonnet', inputTokens: 1200, outputTokens: 800 });
hooks.onAgentDone('sub-1');
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORRERY_WS_URL` | `ws://localhost:4242` | WebSocket server URL |
| `ORRERY_AGENT_ID` | `orch` | Current agent ID |
| `ORRERY_SILENT` | `false` | Suppress hook console output |

---

## Manual Instrumentation

Each file in `instrumentation/` hooks into a specific tool in your stack.

### PPR (Parallax Process Runtime)

**Location:** `~/Documents/GitHub/Dev/parallax-process-runtime-master/build/bin/mcp_server`
**Hook point:** Inter-process message routing
**Event type:** `ipc_message`

```js
import { TopologyEmitter } from './mcp-emitter.js';
import { setupPprEmitter, emitPprMessage } from './instrumentation/ppr-emitter.js';

const emitter = new TopologyEmitter('ws://localhost:4242');
setupPprEmitter(emitter);

// In your PPR message handler:
emitPprMessage(emitter, { source: 'agent-a', target: 'agent-b', topic: 'task.request' });
```

### RTK (Rust Token Killer)

**Location:** `~/.cargo/bin/rtk`
**Hook point:** Claude Code PreToolUse hook
**Event types:** `mcp_call`, `file_access`, `api_call`

```js
import { TopologyEmitter } from './mcp-emitter.js';
import { handleToolCall, handleAgentSpawn } from './instrumentation/rtk-hook.js';

const emitter = new TopologyEmitter('ws://localhost:4242');

// In your PreToolUse hook:
handleToolCall(emitter, 'Read', { file_path: '/src/main.ts' }, 'agent-1');

// When Task tool spawns an agent:
handleAgentSpawn(emitter, { agentId: 'ag2', parentId: 'ag1', description: 'Code Agent' });
```

### Headroom

**Hook point:** MCP tools (`headroom_compress`, `headroom_retrieve`)
**Event types:** `model_call` (with token counts), `handoff`

```js
import { TopologyEmitter } from './mcp-emitter.js';
import { handleCompress, handleRetrieve, handleContextHandoff } from './instrumentation/headroom-emitter.js';

const emitter = new TopologyEmitter('ws://localhost:4242');

// On compress:
handleCompress(emitter, {
  agentId: 'ag1',
  content: largeText,
  hash: 'abc123',
  originalTokens: 5000,
  compressedTokens: 1500
});

// On retrieve (may trigger handoff if different agent):
handleRetrieve(emitter, { agentId: 'ag2', hash: 'abc123' });

// Explicit handoff:
handleContextHandoff(emitter, { sourceAgent: 'ag1', targetAgent: 'ag2', tokens: 3000 });
```

### Engram

**Location:** `~/go/bin/engram`
**Hook point:** MCP tools (`mem_save`, `mem_search`, etc.)
**Event types:** `mcp_call` (labeled `engram:read` or `engram:write`)

```js
import { TopologyEmitter } from './mcp-emitter.js';
import { handleMemoryOp, handleMemorySave, handleMemorySearch } from './instrumentation/engram-emitter.js';

const emitter = new TopologyEmitter('ws://localhost:4242');

// Generic operation:
handleMemoryOp(emitter, 'mem_search', { query: 'auth patterns' }, 'ag1');

// Specific save:
handleMemorySave(emitter, {
  agentId: 'ag1',
  title: 'JWT auth middleware',
  type: 'decision'
});

// Specific search:
handleMemorySearch(emitter, {
  agentId: 'ag1',
  query: 'auth patterns',
  resultCount: 5
});
```

---

## Configuration

Edit `orrery.config.js`:

```js
export default {
  wsPort: 4242,
  wsUrl: 'ws://localhost:4242',
  nodeTtlMs: 60000,           // Node inactivity TTL
  cullIntervalMs: 5000,       // Culling check frequency
  orchestratorId: 'orch',     // Root node ID
  permanentIds: ['orch'],     // Nodes never culled

  tools: {
    ppr: '~/Documents/GitHub/Dev/parallax-process-runtime-master/build/bin/mcp_server',
    rtk: '~/.cargo/bin/rtk',
    engram: '~/go/bin/engram',
  },

  labels: {
    engram: { read: 'engram:read', write: 'engram:write' },
    headroom: { compress: 'headroom:compress', retrieve: 'headroom:retrieve' },
  },
};
```

Override paths with environment variables:
- `WS_PORT` — WebSocket server port
- `WS_URL` — WebSocket URL for dashboard
- `PPR_BIN` — PPR binary path
- `RTK_BIN` — RTK binary path
- `ENGRAM_BIN` — Engram binary path

---

## Event Types

| Event Type           | Source          | Description                           |
|----------------------|-----------------|---------------------------------------|
| `agent_spawn`        | Agent Teams     | Sub-agent created                     |
| `agent_done`         | Agent Teams     | Agent task complete                   |
| `model_call`         | Headroom/RTK    | LLM invocation with token count       |
| `file_access`        | RTK             | File read/write/edit                  |
| `mcp_call`           | RTK/Engram      | MCP tool invocation                   |
| `api_call`           | RTK             | External API call                     |
| `ipc_message`        | PPR             | Inter-agent message                   |
| `handoff`            | Headroom        | Context transfer between agents       |
| `permission_request` | RTK             | User permission required              |
| `permission_resolve` | RTK             | Permission approved/denied            |

---

## Dashboard Features

- **Force-directed graph** — Agents, models, MCP calls as nodes
- **Animated edges** — Parent→child, IPC channels, traveling handoffs
- **Node registry** — Left sidebar lists all active nodes
- **Event stream** — Right sidebar shows chronological events
- **Permissions panel** — Pending/resolved permission requests
- **Metrics** — Token count, cost estimate, agent/call counts
- **Connection status** — WebSocket health indicator
- **Demo mode** — Built-in simulation for testing

---

## License

MIT
