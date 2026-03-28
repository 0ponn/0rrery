# Orrery Session Recording & Playback

All agent workflow sessions are automatically recorded and can be replayed for analysis.

## Quick Start

1. **Start Orrery Server** (already running):
   ```bash
   cd ~/Documents/GitHub/orrery
   ./start.sh
   ```
   - WebSocket server: `ws://localhost:4242`
   - HTTP API: `http://localhost:4243`

2. **Run Any Agent Workflow** - Sessions auto-record:
   ```bash
   cd ~/Documents/GitHub/orrery/demo
   node multi-agent-research.js
   ```

3. **Open Playback Viewer**:
   ```bash
   # Option 1: Direct file
   firefox file:///home/mlayug/Documents/GitHub/orrery/playback.html

   # Option 2: Python server
   cd ~/Documents/GitHub/orrery
   python3 -m http.server 8080
   # Then open: http://localhost:8080/playback.html
   ```

## Features

### Automatic Session Recording

Every event published to the WebSocket server is automatically recorded:

- **Location**: `~/Documents/GitHub/orrery/sessions/`
- **Format**: JSON files named `{sessionId}.json`
- **Auto-save**: Every 10 seconds + on shutdown (Ctrl+C)
- **Session ID**: Extracted from `event.sessionId` field, defaults to "default"

### Session API

**List all sessions:**
```bash
curl http://localhost:4243/sessions | jq
```

Returns:
```json
[
  {
    "sessionId": "research-ahdusy",
    "filename": "research-ahdusy.json",
    "eventCount": 28,
    "startTime": 1711634669677,
    "duration": 44159,
    "lastEventTime": 1711634713836
  }
]
```

**Get session events:**
```bash
curl http://localhost:4243/sessions/research-ahdusy | jq
```

Returns full session with metadata and events array.

### Playback Viewer

**Controls:**
- **Session Selector**: Dropdown of all recorded sessions
- **Play/Pause**: Start/stop playback
- **Reset**: Return to start of session
- **Speed**: 0.5x, 1x, 2x, 5x, 10x
- **Progress Bar**: Click to seek to any point
- **Event Stream**: Live scrolling view of events as they replay

**Stats Dashboard:**
- Total events
- Duration
- Session ID
- Event type breakdown (agent_spawn, model_call, mcp_call, ipc_message, handoff)

## Session File Format

```json
{
  "sessionId": "research-ahdusy",
  "metadata": {
    "startTime": 1711634669677,
    "lastEventTime": 1711634713836,
    "savedAt": 1711634724159,
    "duration": 44159,
    "eventCount": 28
  },
  "events": [
    {
      "type": "agent_spawn",
      "id": "gemini-sim",
      "parentId": "claude-orch",
      "sessionId": "research-ahdusy",
      "timestamp": 1711634669677
    },
    ...
  ]
}
```

## Use Cases

### 1. Debug Multi-Agent Workflows
Replay sessions to identify:
- Communication failures between agents
- Missing IPC messages
- Handoff timing issues
- Agent spawn/exit sequences

### 2. Performance Analysis
Compare sessions:
- Event throughput rates
- Agent response times
- MCP call latencies
- Token usage patterns

### 3. Demo & Documentation
Record workflow executions to:
- Share with team members
- Create documentation screenshots
- Demonstrate system capabilities
- Reproduce specific scenarios

### 4. Regression Testing
Capture baseline sessions:
- Replay after code changes
- Verify event sequences match
- Detect unintended behavior changes

## Integration with Live Dashboard

The main Orrery dashboard at http://localhost:3000 shows **live** agent activity.
Use `playback.html` to **replay** recorded sessions.

Both tools complement each other:
- **Live Dashboard**: Monitor active workflows in real-time
- **Playback Viewer**: Analyze completed workflows at any speed

## Session Management

### List Sessions
```bash
ls -lh ~/Documents/GitHub/orrery/sessions/
```

### View Session Details
```bash
jq '.metadata' ~/Documents/GitHub/orrery/sessions/default.json
```

### Delete Old Sessions
```bash
rm ~/Documents/GitHub/orrery/sessions/session-*.json
```

### Export Session
```bash
cp ~/Documents/GitHub/orrery/sessions/research-ahdusy.json ~/backups/
```

## Troubleshooting

### No Sessions Appearing
- Check server logs: `tail -f /tmp/orrery-server.log`
- Verify events have `sessionId` field
- Ensure server has write permissions to `sessions/` directory

### Playback Not Loading
- Check CORS: Must serve `playback.html` via HTTP server, not `file://`
- Verify HTTP API accessible: `curl http://localhost:4243/sessions`
- Check browser console for errors

### Graph Still Drifting
Playback viewer only shows events - use live dashboard for graph visualization.
Graph drift fixed in live dashboard with these settings:
- alphaDecay: 0.15
- alphaMin: 0.01
- velocityDecay: 0.7

## Technical Details

### Recording Implementation
- WebSocket server intercepts all events
- Maps sessionId → session state (events array, metadata)
- Writes to disk every 10 seconds via `setInterval`
- Handles `SIGINT` to save on shutdown

### Playback Implementation
- Fetches session JSON via HTTP API
- Replays events in sequence using `setInterval`
- Adjustable speed by changing interval duration
- Progress bar calculated as `(index / total) * 100`

### Architecture
```
┌─────────────────┐
│  Agent Process  │
└────────┬────────┘
         │ WebSocket (ws://localhost:4242)
         ▼
┌─────────────────────┐
│  Orrery WS Server   │
│  ├─ Record events   │───► ~/orrery/sessions/*.json
│  └─ Broadcast live  │
└─────────┬───────────┘
          │
          ├─── Live Dashboard (http://localhost:3000)
          │
          └─── HTTP API (http://localhost:4243)
                   │
                   └─── Playback Viewer (playback.html)
```

## Examples

### Replay Texas RFQ Research Session
```bash
# Open playback viewer
firefox file:///home/mlayug/Documents/GitHub/orrery/playback.html

# Select "default" or "research-ahdusy" from dropdown
# Click "Load"
# Click "Play" (watch at 5x speed for faster review)
```

### Compare Two Sessions
```bash
# Terminal 1: View session A stats
curl http://localhost:4243/sessions/session-abc123 | jq '.metadata'

# Terminal 2: View session B stats
curl http://localhost:4243/sessions/session-def456 | jq '.metadata'

# Compare event counts, durations, types
diff <(curl -s http://localhost:4243/sessions/session-abc123 | jq -r '.events[].type' | sort | uniq -c) \
     <(curl -s http://localhost:4243/sessions/session-def456 | jq -r '.events[].type' | sort | uniq -c)
```

---

**Session recording makes Orrery valuable for real debugging and analysis.**
Every workflow execution is preserved for later review.
