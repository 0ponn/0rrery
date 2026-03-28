#!/usr/bin/env bash
#
# start.sh — Start Orrery WebSocket server
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
TEAL='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[0;90m'
NC='\033[0m'

WS_PORT="${WS_PORT:-4242}"

echo -e "${TEAL}"
echo "  ┌─────────────────────────────────────────┐"
echo "  │              ORRERY                     │"
echo "  │   Agent Workflow Topology Visualizer   │"
echo "  └─────────────────────────────────────────┘"
echo -e "${NC}"

# Check dependencies
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}Node.js not found. Please install Node.js 18+.${NC}"
    exit 1
fi

# Install if needed
if [ ! -d "node_modules" ]; then
    echo -e "${DIM}Installing dependencies...${NC}"
    npm install --silent
fi

# Start WebSocket server in background
echo -e "${GREEN}Starting WebSocket server...${NC}"
node ws-server.js &
WS_PID=$!

# Wait for server to start
sleep 1

# Check if server is running
if kill -0 $WS_PID 2>/dev/null; then
    echo ""
    echo -e "${TEAL}WebSocket Server Running${NC}"
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "  ${GREEN}Server URL:${NC}      ws://localhost:${WS_PORT}"
    echo ""
    echo -e "  ${DIM}Publishers:${NC}      ws://localhost:${WS_PORT}?role=publisher"
    echo -e "  ${DIM}Subscribers:${NC}     ws://localhost:${WS_PORT}?role=subscriber"
    echo ""
    echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo -e "${YELLOW}Next Steps:${NC}"
    echo ""
    echo -e "  1. ${DIM}Mount the dashboard:${NC}"
    echo "     cd dashboard && npm install && npm run dev"
    echo ""
    echo -e "  2. ${DIM}Add instrumentation to your tools:${NC}"
    echo "     - PPR:      import { setupPprEmitter } from './instrumentation/ppr-emitter.js'"
    echo "     - RTK:      import { handleToolCall } from './instrumentation/rtk-hook.js'"
    echo "     - Headroom: import { handleCompress } from './instrumentation/headroom-emitter.js'"
    echo "     - Engram:   import { handleMemoryOp } from './instrumentation/engram-emitter.js'"
    echo ""
    echo -e "  3. ${DIM}Or run the demo in the dashboard UI${NC}"
    echo ""
    echo -e "${DIM}Press Ctrl+C to stop the server${NC}"
    echo ""

    # Wait for server
    wait $WS_PID
else
    echo -e "${YELLOW}Failed to start WebSocket server${NC}"
    exit 1
fi
