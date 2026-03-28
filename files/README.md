# Agent Topology Dashboard

Real-time visualization of Claude Code agent workflows — sub-agents, model calls,
MCP interactions, IPC messages, handoffs, API calls, and permission requests.

---

## File Structure

```
agent-topology/
├── README.md                     ← this file
├── package.json                  ← ws-server dependencies
├── ws-server.js                  ← WebSocket broadcast server
├── mcp-emitter.js                ← plug into your proxy MCP / IPC MCP
├── useTopologySocket.js          ← React hook (import into dashboard)
└── AgentTopologyDashboard.jsx    ← React dashboard component
```

---

## How It Works

```
Claude Code agents
       ↓
  Your Proxy MCP  ──→  mcp-emitter.js  ──→  ws-server.js  ──→  Dashboard
  Your IPC MCP    ──→  mcp-emitter.js  ──┘
```

The emitter is a thin module you drop into your existing MCPs.
The WebSocket server is a standalone Node process.
The dashboard subscribes and renders everything in real time.

---

## Setup

### 1. Install and start the WebSocket server

```bash
# In your agent-topology/ directory
npm install
node ws-server.js

# Default: ws://localhost:4242
# Override: WS_PORT=9000 node ws-server.js
```

### 2. Add the emitter to your Proxy MCP

```js
// At the top of your proxy MCP
import { TopologyEmitter } from './mcp-emitter.js';
const emitter = new TopologyEmitter('ws://localhost:4242');

// Then wrap your existing model call handler:
emitter.modelCall({ id, parentId, label: model, tokens });
emitter.fileAccess({ id, parentId, label: filePath });
emitter.apiCall({ id, parentId, label: apiName });
```

### 3. Add the emitter to your IPC MCP

```js
// Emit IPC messages as they route between agents
emitter.ipcMessage({ source: fromAgentId, target: toAgentId, message: summary });
```

### 4. Emit Claude Code lifecycle events

Hook into agent spawn/done and permission events from your orchestration layer:

```js
emitter.agentSpawn({ id, parentId, label });
emitter.agentDone({ id });
emitter.permissionRequest({ id, parentId, label: resource, action });
emitter.permissionResolve({ id, status: 'approved' | 'denied' });
emitter.handoff({ source, target, label });
```

### 5. Mount the dashboard

The dashboard is a standard React component. Mount it in any React app:

```jsx
import Dashboard from './AgentTopologyDashboard.jsx';

// Set WS_URL at the top of AgentTopologyDashboard.jsx:
// const WS_URL = 'ws://localhost:4242';

export default function App() {
  return <Dashboard />;
}
```

Or run it standalone with Vite:

```bash
npm create vite@latest topology-ui -- --template react
cd topology-ui
cp ../AgentTopologyDashboard.jsx src/App.jsx
cp ../useTopologySocket.js src/useTopologySocket.js
npm install d3
npm run dev
```

---

## Event Payload Reference

Every event shares a base shape:

```json
{ "type": "event_type", "id": "unique-id", "timestamp": 1234567890 }
```

| Event Type           | Additional Fields                          |
|----------------------|--------------------------------------------|
| `agent_spawn`        | `parentId`, `label`                        |
| `agent_done`         | —                                          |
| `model_call`         | `parentId`, `label` (model name), `metadata.tokens` |
| `file_access`        | `parentId`, `label` (file path)            |
| `mcp_call`           | `parentId`, `label` (mcp name)             |
| `api_call`           | `parentId`, `label` (api name)             |
| `ipc_message`        | `source`, `target`, `message`              |
| `handoff`            | `source`, `target`, `label`               |
| `permission_request` | `parentId`, `label` (resource), `action`  |
| `permission_resolve` | `status` (`approved` \| `denied`)          |

---

## Configuration

| Constant        | File                         | Default   | Description                    |
|-----------------|------------------------------|-----------|--------------------------------|
| `WS_PORT`       | `ws-server.js` (env)         | `4242`    | WebSocket server port          |
| `WS_URL`        | `AgentTopologyDashboard.jsx` | localhost | Dashboard WebSocket endpoint   |
| `NODE_TTL_MS`   | `AgentTopologyDashboard.jsx` | `60000`   | Node inactivity TTL (ms)       |
| `CULL_INTERVAL` | `AgentTopologyDashboard.jsx` | `5000`    | How often to run node culling  |

---

## Architecture Notes

- **D3 state lives in refs** — do not move node/link data into React useState
- **handleIncomingEvents** processes batches, not individual events — the WebSocket
  hook buffers at 50ms intervals to prevent D3/React collision under high event volume
- **Orphan queue** holds events whose parentId hasn't arrived yet, retried each batch
- **TTL culling** runs every 5s via setInterval — not tied to D3 tick
- **RAF loop** for handoff packets shuts down when queue is empty to avoid idle CPU drain
- **IPC edges** expire after 30s — they are not permanent topology
