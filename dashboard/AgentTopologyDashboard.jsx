/**
 * AgentTopologyDashboard.jsx
 * Real-time Claude Code agent workflow visualizer.
 *
 * Dependencies: react, d3
 * Companion files: useTopologySocket.js, ws-server.js, mcp-emitter.js
 *
 * To connect to live data:
 *   1. Start ws-server.js
 *   2. Add mcp-emitter.js to your proxy/IPC MCPs
 *   3. Set WS_URL below to your server address
 *   4. Delete DEMO_STEPS if desired (or keep for offline testing)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as d3 from 'd3';
import { useTopologySocket } from './useTopologySocket.js';
import { TimelineView } from './TimelineView.jsx';
import { MetricsView } from './MetricsView.jsx';
import PlaybackView from './PlaybackView.jsx';

// ─── CONFIG — edit these ──────────────────────────────────────────────────────

const WS_URL        = 'ws://localhost:4242';   // ← your ws-server address
const NODE_TTL_MS   = 60_000;                  // cull nodes inactive > 60s
const CULL_INTERVAL = 5_000;                   // culling check frequency (ms)

// ─── THEME ───────────────────────────────────────────────────────────────────

const C = {
  bg: '#1a1d23', panel: '#21252b', border: '#3e4451',
  teal: '#56b6c2', amber: '#d19a66', purple: '#c678dd',
  green: '#98c379', red: '#e06c75', blue: '#61afef',
  magenta: '#c678dd', yellow: '#e5c07b', coral: '#e06c75',
  white: '#abb2bf', dim: '#282c34', dimText: '#5c6370',
};

const NSTYLE = {
  orchestrator: { color: C.teal,    r: 22 },
  agent:        { color: C.blue,    r: 17 },
  model:        { color: C.purple,  r: 14 },
  file:         { color: C.amber,   r: 11 },
  mcp:          { color: C.green,   r: 13 },
  api:          { color: C.coral,   r: 12 },
  permission:   { color: C.yellow,  r: 13 },
};

const NICON = {
  orchestrator: '⬡', agent: '◈', model: '◉',
  file: '▣', mcp: '◆', api: '⊕', permission: '⚠',
};

// Maps incoming event type → D3 node type
const TYPE_MAP = {
  agent_spawn:        'agent',
  model_call:         'model',
  file_access:        'file',
  mcp_call:           'mcp',
  api_call:           'api',
  permission_request: 'permission',
};

const STATUS_COLOR = {
  connected:    C.green,
  connecting:   C.amber,
  disconnected: C.red,
  failed:       C.red,
  'no-url':     C.dimText,
};

const EVTCOL = {
  agent_spawn: C.blue, model_call: C.purple, file_access: C.amber,
  mcp_call: C.green, api_call: C.coral, permission: C.yellow,
  ipc: C.magenta, handoff: C.teal, system: C.teal, agent_done: C.dimText,
};

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
// Mirrors the exact payload shape emitted by mcp-emitter.js.
// Delete or comment out if running against live data only.

const DEMO_STEPS = [
  { t: 500,   type: 'agent_spawn',        id: 'ag1',  sessionId: 'demo', label: 'Main Agent' },
  { t: 1100,  type: 'model_call',         id: 'md1',  sessionId: 'demo', parentId: 'ag1',  label: 'claude-sonnet', metadata: { tokens: 1800 } },
  { t: 1700,  type: 'permission_request', id: 'pm1',  sessionId: 'demo', parentId: 'ag1',  label: 'Read: /src',        action: 'Directory read' },
  { t: 2400,  type: 'permission_resolve', id: 'pm1',  sessionId: 'demo', status: 'approved' },
  { t: 2700,  type: 'file_access',        id: 'f1',   sessionId: 'demo', parentId: 'ag1',  label: 'src/index.ts' },
  { t: 3200,  type: 'api_call',           id: 'api1', sessionId: 'demo', parentId: 'ag1',  label: 'GitHub API' },
  { t: 3800,  type: 'agent_spawn',        id: 'ag2',  sessionId: 'demo', parentId: 'ag1',  label: 'Code Agent' },
  { t: 3900,  type: 'handoff',            sessionId: 'demo', source: 'ag1', target: 'ag2', label: 'task context' },
  { t: 4600,  type: 'model_call',         id: 'md2',  sessionId: 'demo', parentId: 'ag2',  label: 'claude-opus',  metadata: { tokens: 3200 } },
  { t: 5200,  type: 'permission_request', id: 'pm2',  sessionId: 'demo', parentId: 'ag2',  label: 'Execute: npm test', action: 'Shell command' },
  { t: 6000,  type: 'permission_resolve', id: 'pm2',  sessionId: 'demo', status: 'approved' },
  { t: 6300,  type: 'mcp_call',           id: 'mc1',  sessionId: 'demo', parentId: 'ag2',  label: 'memory-mcp' },
  { t: 6900,  type: 'agent_spawn',        id: 'ag3',  sessionId: 'demo', parentId: 'ag1',  label: 'Review Agent' },
  { t: 7300,  type: 'ipc_message',        sessionId: 'demo', source: 'ag2', target: 'ag3', message: 'task data' },
  { t: 7900,  type: 'model_call',         id: 'md3',  sessionId: 'demo', parentId: 'ag3',  label: 'gpt-4o',       metadata: { tokens: 1100 } },
  { t: 8300,  type: 'handoff',            sessionId: 'demo', source: 'md2', target: 'md3', label: 'model handoff' },
  { t: 8700,  type: 'api_call',           id: 'api2', sessionId: 'demo', parentId: 'ag3',  label: 'Slack API' },
  { t: 9100,  type: 'permission_request', id: 'pm3',  sessionId: 'demo', parentId: 'ag3',  label: 'Write: output.md',  action: 'File write' },
  { t: 9900,  type: 'permission_resolve', id: 'pm3',  sessionId: 'demo', status: 'denied' },
  { t: 10300, type: 'mcp_call',           id: 'mc2',  sessionId: 'demo', parentId: 'ag2',  label: 'proxy-mcp' },
  { t: 10800, type: 'ipc_message',        sessionId: 'demo', source: 'ag3', target: 'ag1', message: 'result' },
  { t: 11200, type: 'agent_spawn',        id: 'ag4',  sessionId: 'demo', parentId: 'ag2',  label: 'Test Agent' },
  { t: 11600, type: 'handoff',            sessionId: 'demo', source: 'ag2', target: 'ag4', label: 'test suite' },
  { t: 12000, type: 'model_call',         id: 'md4',  sessionId: 'demo', parentId: 'ag4',  label: 'claude-haiku', metadata: { tokens: 560 } },
  { t: 12400, type: 'mcp_call',           id: 'mc3',  sessionId: 'demo', parentId: 'ag4',  label: 'ipc-mcp' },
  { t: 12900, type: 'handoff',            sessionId: 'demo', source: 'ag4', target: 'orch-demo', label: 'final result' },
  { t: 13500, type: 'agent_done',         id: 'ag4',  sessionId: 'demo' },
  { t: 14000, type: 'agent_done',         id: 'ag3',  sessionId: 'demo' },
];

// ─── GRAPH CANVAS SIZE ────────────────────────────────────────────────────────

const W = 600, H = 460;

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export function OrreryDashboard() {
  // D3 state — MUST stay in refs, never useState (would cause 60fps re-render storm)
  const simRef         = useRef(null);
  const nodesRef       = useRef([]);
  const linksRef       = useRef([]);
  const ipcRef         = useRef([]);
  const handoffsRef    = useRef([]);
  const orphanQueueRef = useRef(new Map());
  const rafRef         = useRef(null);
  const demoTimersRef  = useRef([]);
  const permMapRef     = useRef({});
  const svgRef         = useRef(null);
  const zoomRef        = useRef(null);

  // Session state
  const sessionsRef    = useRef(new Map()); // sessionId -> { nodes, links, ipc, handoffs }
  const [activeSessions, setActiveSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);

  // React UI state
  const [tick,           setTick]          = useState(0);
  const [permissions,    setPermissions]   = useState([]);
  const [events,         setEvents]        = useState([]);
  const [rawEvents,      setRawEvents]     = useState([]); // Full event objects for timeline
  const [metrics,        setMetrics]       = useState({ tokens: 0, cost: 0, agents: 0, calls: 0, perms: 0 });
  const [activeNodes,    setActiveNodes]   = useState(new Set());
  const [demoRunning,    setDemoRunning]   = useState(false);
  const [promptText,     setPromptText]    = useState('');
  const [promptDisplay,  setPromptDisplay] = useState('');
  const [currentView,    setCurrentView]   = useState('graph'); // graph | timeline | metrics | playback
  const [simFrozen,      setSimFrozen]     = useState(true);  // ← START FROZEN to prevent drift
  const [sessions,       setSessions]      = useState([]);
  const [playbackSession, setPlaybackSession] = useState(null);
  const [playbackState,  setPlaybackState] = useState('stopped'); // stopped | playing | paused
  const [playbackSpeed,  setPlaybackSpeed] = useState(1);
  const [playbackIndex,  setPlaybackIndex] = useState(0);

  // ── Fetch available sessions ──────────────────────────────────────────────
  useEffect(() => {
    fetch('http://localhost:4243/sessions')
      .then(r => r.json())
      .then(data => setSessions(data))
      .catch(err => console.error('Failed to load sessions:', err));
  }, []);

  // ── Playback logic ────────────────────────────────────────────────────────
  const loadSession = useCallback((session) => {
    // Clear current topology
    nodesRef.current = [];
    linksRef.current = [];
    ipcRef.current = [];
    handoffsRef.current = [];
    setEvents([]);

    // Replay all events from session
    if (session && session.events) {
      handleIncomingEvents(session.events);
    }

    addLog(`Loaded session with ${session?.events?.length || 0} events`, 'info');
  }, []);

  // Playback logic now handled by PlaybackView component

  // ── RAF loop — hardened per Gemini review ─────────────────────────────────
  const startRaf = useCallback(() => {
    if (rafRef.current) return;
    const loop = () => {
      const now = Date.now();
      handoffsRef.current = handoffsRef.current
        .map(h => ({ ...h, progress: (now - h.startTime) / h.duration }))
        .filter(h => h.progress < 1.0);
      setTick(t => t + 1);
      if (handoffsRef.current.length > 0) rafRef.current = requestAnimationFrame(loop);
      else rafRef.current = null;
    };
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const flash = useCallback((id, dur = 1800) => {
    setActiveNodes(prev => new Set([...prev, id]));
    setTimeout(() => setActiveNodes(prev => { const s = new Set(prev); s.delete(id); return s; }), dur);
  }, []);

  const addLog = useCallback((msg, type = 'system') => {
    const t = new Date().toLocaleTimeString('en-US', { hour12: false });
    setEvents(prev => [{ id: Math.random(), msg, type, t }, ...prev].slice(0, 150));
  }, []);

  const refreshSim = useCallback((alpha = 0.05) => {
    if (!simRef.current || simFrozen) return;
    simRef.current.nodes(nodesRef.current);
    simRef.current.force('link').links(linksRef.current);
    simRef.current.alpha(Math.min(alpha, 0.05)).restart();

    // IMMEDIATE stop after 200ms - just enough to position new nodes
    setTimeout(() => {
      if (simRef.current) simRef.current.stop();
    }, 200);
  }, [simFrozen]);

  // ── Core event router — processes batches from WebSocket or demo ──────────
  const handleIncomingEvents = useCallback((batch) => {
    let needsRefresh = false;
    const now = Date.now();

    const processEvent = (payload) => {
      const { type, id, sessionId = 'default' } = payload;

      // Store raw event for timeline/metrics (with all metadata)
      setRawEvents(prev => [...prev, { ...payload, timestamp: payload.timestamp || now }].slice(-500));

      // Track active sessions and create session-specific orchestrator
      if (!sessionsRef.current.has(sessionId)) {
        const orchId = `orch-${sessionId}`;
        const orchNode = {
          id: orchId,
          type: 'orchestrator',
          label: `Orchestrator (${sessionId})`,
          sessionId,
          x: W/2 + (sessionsRef.current.size * 80),
          y: H/2,
          fx: W/2 + (sessionsRef.current.size * 80),
          fy: H/2,
          lastActive: now,
          completed: false,
        };

        sessionsRef.current.set(sessionId, {
          id: sessionId,
          orchestratorId: orchId,
          startTime: now,
          lastActivity: now,
        });

        // Add orchestrator node for this session
        nodesRef.current.push(orchNode);
        needsRefresh = true;

        setActiveSessions(Array.from(sessionsRef.current.keys()));
        if (!currentSession) setCurrentSession(sessionId);

        addLog(`◉ New session: ${sessionId}`, 'system');
        flash(orchId, 1200);
      } else {
        const session = sessionsRef.current.get(sessionId);
        session.lastActivity = now;
      }

      // Filter events by current session (if multi-session mode is active)
      if (currentSession && sessionId !== currentSession && activeSessions.length > 1) {
        return; // Skip events from other sessions
      }

      // Orphan queue — hold events whose parent hasn't arrived yet
      // BUT: if parentId is generic 'orch', don't orphan - we'll map it to session orchestrator
      const isGenericOrch = payload.parentId === 'orch';
      if (payload.parentId && !isGenericOrch && !nodesRef.current.some(n => n.id === payload.parentId)) {
        orphanQueueRef.current.set(id ?? Math.random(), payload);
        return;
      }

      // ── Spawn node types ─────────────────────────────────────────────────
      if (TYPE_MAP[type]) {
        const nodeType = TYPE_MAP[type];
        const existing = nodesRef.current.find(n => n.id === id);
        if (existing) { existing.lastActive = now; return; }

        // Get session orchestrator ID
        const session = sessionsRef.current.get(sessionId);
        const orchId = session?.orchestratorId || 'orch';

        // Use session orchestrator if no explicit parent provided
        // Map generic 'orch' to session-specific orchestrator
        const parentId = (!payload.parentId || payload.parentId === 'orch') ? orchId : payload.parentId;

        nodesRef.current.push({
          id, type: nodeType,
          label:      payload.label || id,
          sessionId,
          lastActive: now,
          completed:  false,
          x: W/2 + (Math.random() - 0.5) * 120,
          y: H/2 + (Math.random() - 0.5) * 120,
        });

        if (parentId) linksRef.current.push({ source: parentId, target: id, sessionId });
        needsRefresh = true;
        flash(id);

        if (type === 'permission_request') {
          permMapRef.current[id] = id;
          setPermissions(prev => [...prev, {
            id, nodeId: id, agentId: payload.parentId,
            label:  payload.label,
            action: payload.action || 'Unknown',
            status: 'pending',
            t: new Date().toLocaleTimeString('en-US', { hour12: false }),
          }]);
          setMetrics(prev => ({ ...prev, perms: prev.perms + 1 }));
          addLog(`⚠  Permission: ${payload.action} — "${payload.label}"`, 'permission');
        } else {
          const icons = { agent: '↳', model: '⚡', file: '📂', mcp: '🔧', api: '🌐' };
          const tokens = payload.metadata?.tokens ?? 0;
          addLog(
            `${icons[nodeType] ?? '·'} ${payload.label}${tokens ? `  ←  ${tokens.toLocaleString()} tok` : ''}`,
            type
          );
          setMetrics(prev => ({
            tokens: prev.tokens + tokens,
            cost:   +((prev.tokens + tokens) * 0.0000028).toFixed(5),
            agents: prev.agents + (nodeType === 'agent' ? 1 : 0),
            calls:  prev.calls  + (nodeType === 'model'  ? 1 : 0),
            perms:  prev.perms,
          }));
        }
      }

      // ── Permission resolve ────────────────────────────────────────────────
      else if (type === 'permission_resolve') {
        const node = nodesRef.current.find(n => n.id === id);
        if (node) { node.resolved = payload.status; node.lastActive = now; flash(id, 900); }
        setPermissions(prev => prev.map(p => p.id === id ? { ...p, status: payload.status } : p));
        addLog(
          `${payload.status === 'approved' ? '✓' : '✗'}  Permission ${payload.status}`,
          payload.status === 'approved' ? 'system' : 'permission'
        );
      }

      // ── Agent done ────────────────────────────────────────────────────────
      else if (type === 'agent_done') {
        const node = nodesRef.current.find(n => n.id === id);
        if (node) { node.completed = true; node.lastActive = now; }
        addLog(`◻  Agent done: ${id}`, 'agent_done');
        setTick(t => t + 1);
      }

      // ── IPC message (bidirectional lateral edge) ──────────────────────────
      else if (type === 'ipc_message') {
        const { source, target } = payload;
        const src = nodesRef.current.find(n => n.id === source);
        const tgt = nodesRef.current.find(n => n.id === target);
        if (src) src.lastActive = now;
        if (tgt) tgt.lastActive = now;
        // Deduplicate — one IPC edge per agent pair, expires after 30s
        if (!ipcRef.current.some(e => e.fromId === source && e.toId === target)) {
          ipcRef.current.push({ id: Math.random(), fromId: source, toId: target, expiresAt: now + 30_000 });
        }
        addLog(`⇄  IPC: ${source} → ${target}  ·  ${payload.message ?? ''}`, 'ipc');
        setTick(t => t + 1);
      }

      // ── Handoff traveling packet ──────────────────────────────────────────
      else if (type === 'handoff') {
        const { source, target } = payload;
        const src = nodesRef.current.find(n => n.id === source);
        const tgt = nodesRef.current.find(n => n.id === target);
        if (src) src.lastActive = now;
        if (tgt) tgt.lastActive = now;
        handoffsRef.current.push({
          id: Math.random(), fromId: source, toId: target,
          label: payload.label, startTime: now, duration: 1500, progress: 0,
        });
        startRaf();
        addLog(`→  Handoff: ${source} → ${target}  ·  ${payload.label ?? ''}`, 'handoff');
      }

      // ── System messages from ws-server ────────────────────────────────────
      else if (type === 'system') {
        addLog(`◉  ${payload.label ?? payload.message ?? ''}`, 'system');
      }
    };

    batch.forEach(processEvent);

    // Retry orphans after full batch is processed
    if (orphanQueueRef.current.size > 0) {
      orphanQueueRef.current.forEach((payload, key) => {
        if (nodesRef.current.some(n => n.id === payload.parentId)) {
          orphanQueueRef.current.delete(key);
          processEvent(payload);
          needsRefresh = true;
        }
      });
    }

    // Single D3 restart per batch — not per event
    if (needsRefresh) refreshSim(0.05);
  }, [flash, addLog, startRaf, refreshSim]);

  // ── Initialize D3 simulation ──────────────────────────────────────────────
  useEffect(() => {
    // Don't create orchestrator here - it will be created per-session when first event arrives
    nodesRef.current    = [];
    linksRef.current    = [];
    ipcRef.current      = [];
    handoffsRef.current = [];

    simRef.current = d3.forceSimulation(nodesRef.current)
      .force('link', d3.forceLink(linksRef.current).id(d => d.id).distance(100).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-200))
      .force('center', d3.forceCenter(W/2, H/2).strength(0.02))
      .force('collide', d3.forceCollide().radius(d => (NSTYLE[d.type]?.r ?? 14) + 20))
      .alphaDecay(0.5)        // ← VERY AGGRESSIVE: Stop in ~5 ticks
      .alphaMin(0.1)          // ← Stop very early
      .velocityDecay(0.95)    // ← EXTREME friction
      .on('tick', () => setTick(k => k + 1))
      .stop();  // ← STOP IMMEDIATELY - don't auto-run

    // Add zoom/pan behavior to SVG
    if (svgRef.current) {
      const svg = d3.select(svgRef.current);
      const g = svg.select('g');

      const zoom = d3.zoom()
        .scaleExtent([0.3, 3])
        .on('zoom', (event) => {
          g.attr('transform', event.transform);
        });

      svg.call(zoom);
      zoomRef.current = zoom;

      // Add double-click to reset zoom
      svg.on('dblclick.zoom', () => {
        svg.transition().duration(750).call(zoom.transform, d3.zoomIdentity);
      });
    }

    return () => {
      simRef.current?.stop();
      cancelAnimationFrame(rafRef.current);
      handoffsRef.current = []; // explicit unmount cleanup (Gemini)
    };
  }, []);

  // ── TTL node culling (Gemini spec) — setInterval, NOT sim tick ───────────
  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = Date.now() - NODE_TTL_MS;
      const before = nodesRef.current.length;

      nodesRef.current = nodesRef.current.filter(n =>
        n.type === 'orchestrator' || (n.lastActive ?? 0) > cutoff
      );
      ipcRef.current = ipcRef.current.filter(e =>
        !e.expiresAt || e.expiresAt > Date.now()
      );
      const alive = new Set(nodesRef.current.map(n => n.id));
      linksRef.current = linksRef.current.filter(l => {
        const s = typeof l.source === 'object' ? l.source.id : l.source;
        const t = typeof l.target === 'object' ? l.target.id : l.target;
        return alive.has(s) && alive.has(t);
      });

      if (nodesRef.current.length !== before) {
        simRef.current.nodes(nodesRef.current);
        simRef.current.force('link').links(linksRef.current);
        simRef.current.alpha(0.3).restart(); // small kick to close visual gaps
      }
    }, CULL_INTERVAL);

    return () => clearInterval(interval);
  }, []);

  // ── WebSocket connection ───────────────────────────────────────────────────
  const { status: socketStatus } = useTopologySocket(WS_URL, handleIncomingEvents);

  // ── Demo runner — uses real event router, same path as live WS ───────────
  const runDemo = useCallback(() => {
    if (demoRunning) return;
    setDemoRunning(true);
    demoTimersRef.current.forEach(clearTimeout);
    permMapRef.current = {};
    orphanQueueRef.current.clear();

    const orch = {
      id: 'orch', type: 'orchestrator', label: 'Orchestrator',
      x: W/2, y: H/2, fx: W/2, fy: H/2, lastActive: Date.now(), completed: false,
    };
    nodesRef.current    = [orch];
    linksRef.current    = [];
    ipcRef.current      = [];
    handoffsRef.current = [];
    refreshSim(0.05);

    setTick(0);
    setEvents([]);
    setRawEvents([]);
    setPermissions([]);
    setMetrics({ tokens: 0, cost: 0, agents: 0, calls: 0, perms: 0 });
    flash('orch', 600);

    const display = promptText.trim() || 'analyze repo · spawn agents · generate PR review';
    setPromptDisplay(display);
    addLog(`▶  ${display}`, 'system');

    DEMO_STEPS.forEach(step => {
      const tid = setTimeout(() => handleIncomingEvents([step]), step.t);
      demoTimersRef.current.push(tid);
    });

    const last = DEMO_STEPS[DEMO_STEPS.length - 1].t;
    demoTimersRef.current.push(setTimeout(() => {
      addLog('✓  Demo complete — wire WS_URL for live data', 'system');
      if (nodesRef.current[0]) { nodesRef.current[0].fx = null; nodesRef.current[0].fy = null; }
      setDemoRunning(false);
    }, last + 1400));
  }, [demoRunning, promptText, flash, addLog, handleIncomingEvents, refreshSim]);

  // ─── Render ───────────────────────────────────────────────────────────────
  // Filter by current session if multi-session mode is active
  const shouldShowNode = (n) => {
    if (!currentSession || activeSessions.length === 1) return true;
    return n.sessionId === currentSession;
  };

  const nodes    = nodesRef.current.filter(shouldShowNode);
  const links    = linksRef.current.filter(l => {
    if (!currentSession || activeSessions.length === 1) return true;
    return l.sessionId === currentSession;
  });
  const ipcEdges = ipcRef.current.filter(e => {
    if (!currentSession || activeSessions.length === 1) return true;
    const fromNode = nodesRef.current.find(n => n.id === e.fromId);
    return fromNode?.sessionId === currentSession;
  });
  const handoffs = handoffsRef.current.filter(h => {
    if (!currentSession || activeSessions.length === 1) return true;
    const fromNode = nodesRef.current.find(n => n.id === h.fromId);
    return fromNode?.sessionId === currentSession;
  });
  const easeIO   = t => t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
  const statusCol = STATUS_COLOR[socketStatus] ?? C.dimText;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        @keyframes dashFlow  { to { stroke-dashoffset:-24; } }
        @keyframes ipcFlow   { to { stroke-dashoffset:-32; } }
        @keyframes fadeSlide { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse     { 0%,100%{opacity:1} 50%{opacity:0.5} }
        .link-tree { stroke-dasharray:7 5; animation:dashFlow 0.65s linear infinite; }
        .link-ipc  { stroke-dasharray:12 6; animation:ipcFlow 0.8s linear infinite; }
        .evt-row   { animation:fadeSlide 0.2s ease; }
        .blinker   { animation:pulse 1.2s ease-in-out infinite; }
        ::-webkit-scrollbar { width:8px; }
        ::-webkit-scrollbar-track { background:${C.dim}; }
        ::-webkit-scrollbar-thumb { background:${C.dimText}; border-radius:4px; }
        ::-webkit-scrollbar-thumb:hover { background:${C.border}; }
      `}</style>

      <div style={{ width:'100%', minHeight:'100vh', background:C.bg, fontFamily:"'Inter',sans-serif", color:C.white, display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* ── HEADER ── */}
        <header style={{ padding:'12px 20px', borderBottom:`1px solid ${C.border}`, background:C.panel, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <svg width="28" height="28" viewBox="0 0 30 30">
              <polygon points="15,2 26,8.5 26,21.5 15,28 4,21.5 4,8.5" fill="none" stroke={C.teal} strokeWidth="2"/>
              <circle cx="15" cy="15" r="4" fill={C.teal}/>
            </svg>
            <div>
              <div style={{ fontSize:16, color:C.white, fontWeight:600, letterSpacing:0.5 }}>Orrery</div>
              <div style={{ fontSize:11, color:C.dimText, fontWeight:400 }}>Agent Workflow Topology</div>
            </div>
          </div>

          <div style={{ display:'flex', gap:24 }}>
            {[
              ['Tokens', metrics.tokens.toLocaleString(), C.teal],
              ['Cost',   `$${metrics.cost.toFixed(4)}`,  C.amber],
              ['Agents', metrics.agents,                  C.blue],
              ['Calls', metrics.calls,                   C.purple],
              ['Perms',  metrics.perms,                   C.yellow],
            ].map(([l, v, col]) => (
              <div key={l} style={{ textAlign:'center' }}>
                <div style={{ fontSize:10, color:C.dimText, fontWeight:500, marginBottom:3 }}>{l}</div>
                <div style={{ fontSize:15, color:col, fontWeight:600, transition:'all 0.3s' }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:16 }}>
            {/* View switcher */}
            <div style={{ display:'flex', gap:4, background:C.dim, borderRadius:4, padding:3 }}>
              {['graph', 'timeline', 'metrics', 'playback'].map(view => (
                <button
                  key={view}
                  onClick={() => setCurrentView(view)}
                  style={{
                    padding:'6px 14px',
                    borderRadius:3,
                    border:'none',
                    background:currentView === view ? C.teal : 'transparent',
                    color:currentView === view ? C.bg : C.white,
                    fontSize:11,
                    fontWeight:600,
                    cursor:'pointer',
                    textTransform:'capitalize',
                    transition:'all 0.2s',
                  }}
                >
                  {view}
                </button>
              ))}
            </div>

            {/* Session switcher */}
            {activeSessions.length > 1 && (
              <select
                value={currentSession || ''}
                onChange={e => setCurrentSession(e.target.value)}
                style={{ padding:'6px 12px', borderRadius:4, background:C.dim, border:`1px solid ${C.border}`, color:C.white, fontSize:11, fontWeight:500, cursor:'pointer' }}
              >
                {activeSessions.map(sid => (
                  <option key={sid} value={sid}>{sid}</option>
                ))}
              </select>
            )}

            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <div className={['connecting','reconnecting'].includes(socketStatus) ? 'blinker' : ''} style={{ width:8, height:8, borderRadius:'50%', background:statusCol, transition:'all 0.4s' }}/>
              <span style={{ fontSize:11, color:statusCol, fontWeight:500, textTransform:'capitalize' }}>{socketStatus}</span>
            </div>
          </div>
        </header>

        {/* ── BODY ── */}
        <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>

          {/* Render based on current view */}
          {currentView === 'timeline' && (
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <TimelineView events={rawEvents} nodes={nodes} width={1400} height={800} />
            </div>
          )}

          {currentView === 'metrics' && (
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <MetricsView events={rawEvents} permissions={permissions} metrics={metrics} />
            </div>
          )}

          {currentView === 'playback' && (
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <PlaybackView onLoadSession={loadSession} C={C} />
            </div>
          )}

          {currentView === 'graph' && (
            <>
          {/* LEFT: Node registry */}
          <aside style={{ width:180, borderRight:`1px solid ${C.border}`, background:C.panel, overflow:'auto', flexShrink:0 }}>
            <div style={{ padding:'12px 14px 8px', fontSize:11, color:C.dimText, fontWeight:600, borderBottom:`1px solid ${C.border}` }}>Nodes</div>
            {nodes.map(n => {
              const s      = NSTYLE[n.type] ?? NSTYLE.agent;
              const col    = n.completed ? C.dimText : n.resolved === 'approved' ? C.green : n.resolved === 'denied' ? C.red : s.color;
              const isActive = activeNodes.has(n.id);
              return (
                <div key={n.id} style={{ padding:'8px 14px', display:'flex', alignItems:'center', gap:10, borderLeft:`3px solid ${isActive ? col : 'transparent'}`, background:isActive ? `${col}15` : 'transparent', transition:'all 0.3s', opacity:n.completed ? 0.5 : 1 }}>
                  <span style={{ color:col, fontSize:14, flexShrink:0, fontWeight:500 }}>{n.completed ? '◻' : NICON[n.type]}</span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:11, color:isActive ? col : C.white, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', transition:'color 0.3s', fontWeight:isActive ? 600 : 400 }}>{n.label}</div>
                    <div style={{ fontSize:9, color:C.dimText, textTransform:'capitalize', marginTop:1 }}>{n.completed ? 'done' : n.type}</div>
                  </div>
                  {isActive && <div style={{ width:6, height:6, borderRadius:'50%', background:col, flexShrink:0 }}/>}
                </div>
              );
            })}
          </aside>

          {/* CENTER: D3 force graph */}
          <main style={{ flex:1, position:'relative', overflow:'hidden', minWidth:0 }}>
            {/* Subtle grid */}
            <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%' }}>
              <defs><pattern id="grid" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.5" fill={C.border} opacity="0.3"/></pattern></defs>
              <rect width="100%" height="100%" fill="url(#grid)"/>
            </svg>

            {/* Main graph SVG */}
            <svg ref={svgRef} style={{ position:'absolute', inset:0, width:'100%', height:'100%', cursor:'grab' }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
              <defs>
                <marker id="arr-ipc" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill={C.magenta} opacity="0.7"/>
                </marker>
              </defs>

              <g>
              {/* Tree links */}
              {links.map((l, i) => {
                const src = typeof l.source === 'object' ? l.source : nodes.find(n => n.id === l.source);
                const tgt = typeof l.target === 'object' ? l.target : nodes.find(n => n.id === l.target);
                if (!src?.x || !tgt?.x) return null;
                const col = tgt.completed ? C.dimText : tgt.resolved === 'approved' ? C.green : tgt.resolved === 'denied' ? C.red : NSTYLE[tgt.type]?.color ?? C.teal;
                return <line key={i} className="link-tree" x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={col} strokeWidth={1.5} strokeOpacity={tgt.completed ? 0.1 : 0.38} style={{ animationDuration:`${0.55 + (i % 4) * 0.12}s` }}/>;
              })}

              {/* IPC edges — bidirectional magenta */}
              {ipcEdges.map(e => {
                const src = nodes.find(n => n.id === e.fromId);
                const tgt = nodes.find(n => n.id === e.toId);
                if (!src?.x || !tgt?.x) return null;
                return (
                  <g key={e.id}>
                    <line className="link-ipc" x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={C.magenta} strokeWidth={2.5} strokeOpacity={0.55} markerEnd="url(#arr-ipc)"/>
                    <line className="link-ipc" x1={tgt.x} y1={tgt.y} x2={src.x} y2={src.y} stroke={C.magenta} strokeWidth={2.5} strokeOpacity={0.55} markerEnd="url(#arr-ipc)" style={{ animationDirection:'reverse' }}/>
                  </g>
                );
              })}

              {/* Handoff traveling packets */}
              {handoffs.map(h => {
                const src = nodes.find(n => n.id === h.fromId);
                const tgt = nodes.find(n => n.id === h.toId);
                if (!src?.x || !tgt?.x) return null;
                const p  = easeIO(Math.min(h.progress, 1));
                const x  = src.x + (tgt.x - src.x) * p;
                const y  = src.y + (tgt.y - src.y) * p;
                const op = h.progress < 0.15 ? h.progress / 0.15 : h.progress > 0.85 ? (1 - h.progress) / 0.15 : 1;
                return (
                  <g key={h.id}>
                    <line x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y} stroke={C.teal} strokeWidth={1} strokeOpacity={0.18} strokeDasharray="4 4"/>
                    <circle cx={x} cy={y} r={9} fill={C.teal} opacity={op * 0.18}/>
                    <circle cx={x} cy={y} r={5} fill={C.teal} opacity={op * 0.92} style={{ filter:`drop-shadow(0 0 5px ${C.teal})` }}/>
                  </g>
                );
              })}

              {/* Nodes */}
              {nodes.map(n => {
                if (!n.x) return null;
                const s        = NSTYLE[n.type] ?? NSTYLE.agent;
                const col      = n.completed ? C.dimText : n.resolved === 'approved' ? C.green : n.resolved === 'denied' ? C.red : s.color;
                const isActive  = activeNodes.has(n.id);
                const isPending = n.type === 'permission' && !n.resolved;
                return (
                  <g key={n.id} transform={`translate(${Math.round(n.x)},${Math.round(n.y)})`} opacity={n.completed ? 0.4 : 1} style={{ transition:'opacity 0.8s' }}>
                    {isPending && <circle className="blinker" r={s.r + 8} fill="none" stroke={C.yellow} strokeWidth={1.5} opacity={0.6}/>}
                    {isActive && <circle r={s.r + 10} fill={col} opacity={0.15}/>}
                    <circle r={s.r} fill={C.panel} stroke={col} strokeWidth={isActive ? 2.5 : 2} style={{ transition:'all 0.3s' }}/>
                    <text textAnchor="middle" dominantBaseline="central" fontSize={s.r * 0.8} fill={col} style={{ fontFamily:'monospace', userSelect:'none', fontWeight:500 }}>{n.completed ? '◻' : NICON[n.type]}</text>
                    <text textAnchor="middle" y={s.r + 16} fontSize={10} fill={isActive ? col : C.dimText} fontWeight={isActive ? 600 : 400} style={{ transition:'all 0.3s' }}>{n.label}</text>
                  </g>
                );
              })}
              </g>
            </svg>

            {/* Zoom controls */}
            <div style={{ position:'absolute', bottom:12, right:12, display:'flex', flexDirection:'column', gap:6, zIndex:10 }}>
              <button
                onClick={() => {
                  const svg = d3.select(svgRef.current);
                  svg.transition().duration(300).call(zoomRef.current.scaleBy, 1.3);
                }}
                style={{ width:36, height:36, borderRadius:4, background:C.panel, border:`1px solid ${C.border}`, color:C.white, fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}
                title="Zoom in"
              >+</button>
              <button
                onClick={() => {
                  const svg = d3.select(svgRef.current);
                  svg.transition().duration(300).call(zoomRef.current.scaleBy, 0.7);
                }}
                style={{ width:36, height:36, borderRadius:4, background:C.panel, border:`1px solid ${C.border}`, color:C.white, fontSize:18, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}
                title="Zoom out"
              >−</button>
              <button
                onClick={() => {
                  const svg = d3.select(svgRef.current);
                  svg.transition().duration(750).call(zoomRef.current.transform, d3.zoomIdentity);
                }}
                style={{ width:36, height:36, borderRadius:4, background:C.panel, border:`1px solid ${C.border}`, color:C.white, fontSize:14, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center' }}
                title="Reset zoom"
              >⊙</button>
              <div style={{ height:1, background:C.border, margin:'4px 0' }}/>
              <button
                onClick={() => {
                  setSimFrozen(!simFrozen);
                  if (!simFrozen) {
                    // Freeze: stop simulation
                    simRef.current?.stop();
                  } else {
                    // Unfreeze: restart with low alpha
                    refreshSim(0.1);
                  }
                }}
                style={{ width:36, height:36, borderRadius:4, background:simFrozen ? C.teal : C.panel, border:`1px solid ${simFrozen ? C.teal : C.border}`, color:simFrozen ? C.bg : C.white, fontSize:16, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:600 }}
                title={simFrozen ? "Unfreeze simulation" : "Freeze simulation"}
              >{simFrozen ? '❄' : '▶'}</button>
            </div>

            {/* Prompt display */}
            {promptDisplay && (
              <div style={{ position:'absolute', bottom:12, left:'50%', transform:'translateX(-50%)', padding:'5px 16px', borderRadius:3, background:'rgba(4,8,15,0.9)', border:`1px solid ${C.border}`, fontSize:9, color:C.dimText, maxWidth:'76%', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', backdropFilter:'blur(8px)', zIndex:10 }}>
                <span style={{ color:C.teal }}>▶ </span>{promptDisplay}
              </div>
            )}

            {/* Controls help */}
            <div style={{ position:'absolute', top:12, left:12, background:C.panel, border:`1px solid ${C.border}`, padding:'10px 14px', borderRadius:4, zIndex:10 }}>
              <div style={{ fontSize:10, color:C.dimText, fontWeight:600, marginBottom:6 }}>Controls</div>
              <div style={{ fontSize:10, color:C.white, marginBottom:8, lineHeight:1.5 }}>
                • Drag to pan<br/>
                • Scroll to zoom<br/>
                • Double-click to reset<br/>
                • {simFrozen ? '❄' : '▶'} Freeze layout
              </div>
              <div style={{ fontSize:10, color:C.dimText, fontWeight:600, marginBottom:6, marginTop:10 }}>Edges</div>
              {[
                { label:'Hierarchy', color:C.blue,    dash:'7 5', w:1.5 },
                { label:'IPC', color:C.magenta, dash:'12 6', w:2.5 },
                { label:'Handoff', color:C.teal,    dot:true },
              ].map(e => (
                <div key={e.label} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                  <svg width="32" height="10">
                    {e.dot
                      ? <><line x1="0" y1="5" x2="32" y2="5" stroke={e.color} strokeWidth="1" strokeDasharray="4 4" opacity="0.3"/><circle cx="16" cy="5" r="3" fill={e.color} opacity="0.8"/></>
                      : <line x1="0" y1="5" x2="32" y2="5" stroke={e.color} strokeWidth={e.w} strokeDasharray={e.dash}/>
                    }
                  </svg>
                  <span style={{ fontSize:11, color:C.white }}>{e.label}</span>
                </div>
              ))}
            </div>

            {/* Node type legend */}
            <div style={{ position:'absolute', top:12, right:12, background:C.panel, border:`1px solid ${C.border}`, padding:'10px 14px', borderRadius:4, zIndex:10 }}>
              <div style={{ fontSize:10, color:C.dimText, fontWeight:600, marginBottom:8 }}>Node Types</div>
              {Object.entries(NSTYLE).map(([type, s]) => (
                <div key={type} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6, fontSize:11, color:C.white }}>
                  <span style={{ color:s.color, fontSize:12 }}>{NICON[type]}</span>
                  <span style={{ textTransform:'capitalize' }}>{type}</span>
                </div>
              ))}
            </div>
          </main>

          {/* RIGHT: Permissions + Event stream */}
          <aside style={{ width:260, borderLeft:`1px solid ${C.border}`, display:'flex', flexDirection:'column', background:C.panel, flexShrink:0 }}>

            {/* Permissions panel */}
            <div style={{ flexShrink:0, borderBottom:`1px solid ${C.border}`, maxHeight:'44%', overflow:'auto' }}>
              <div style={{ padding:'12px 14px 8px', fontSize:11, color:C.dimText, fontWeight:600, position:'sticky', top:0, background:C.panel, zIndex:1, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <span>Permissions</span>
                {permissions.some(p => p.status === 'pending') &&
                  <span className="blinker" style={{ color:C.yellow, fontSize:10, fontWeight:500 }}>● Pending</span>
                }
              </div>
              {permissions.length === 0
                ? <div style={{ padding:'8px 12px 12px', fontSize:9, color:C.dimText }}>None requested</div>
                : permissions.map(p => {
                    const col  = p.status === 'approved' ? C.green : p.status === 'denied' ? C.red : C.yellow;
                    const icon = p.status === 'approved' ? '✓' : p.status === 'denied' ? '✗' : '⚠';
                    return (
                      <div key={p.id} style={{ padding:'6px 12px', borderBottom:`1px solid ${C.dim}60`, borderLeft:`2px solid ${col}`, background:`${col}08`, transition:'all 0.5s' }}>
                        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                          <span style={{ fontSize:9, color:col, fontWeight:'bold' }}>{icon} {p.status.toUpperCase()}</span>
                          <span style={{ fontSize:7.5, color:C.dimText }}>{p.t}</span>
                        </div>
                        <div style={{ fontSize:9.5, color:C.white, lineHeight:1.4 }}>{p.action}</div>
                        <div style={{ fontSize:8.5, color:C.dimText, wordBreak:'break-all', marginTop:2 }}>{p.label}</div>
                      </div>
                    );
                  })
              }
            </div>

            {/* Event stream */}
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
              <div style={{ padding:'12px 14px 8px', fontSize:11, color:C.dimText, fontWeight:600, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>Events</div>
              <div style={{ flex:1, overflow:'auto', padding:'6px 0' }}>
                {events.length === 0 &&
                  <div style={{ padding:'24px 14px', fontSize:11, color:C.dimText, textAlign:'center', lineHeight:1.6 }}>
                    Run demo or connect WebSocket to begin
                  </div>
                }
                {events.map(e => (
                  <div key={e.id} className="evt-row" style={{ padding:'6px 14px', borderBottom:`1px solid ${C.border}40` }}>
                    <div style={{ fontSize:9, color:C.dimText, marginBottom:2, fontWeight:500 }}>{e.t}</div>
                    <div style={{ fontSize:11, lineHeight:1.4, color:EVTCOL[e.type] ?? C.white, wordBreak:'break-all' }}>{e.msg}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Token burn bar */}
            <div style={{ padding:'8px 12px', borderTop:`1px solid ${C.border}`, flexShrink:0 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4, fontSize:7.5, color:C.dimText }}>
                <span>TOKEN BURN</span>
                <span style={{ color:C.teal }}>{metrics.tokens.toLocaleString()}</span>
              </div>
              <div style={{ height:3, background:C.dim, borderRadius:2, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${Math.min(100, (metrics.tokens / 14000) * 100)}%`, background:`linear-gradient(90deg,${C.teal},${C.blue})`, transition:'width 0.5s ease', boxShadow:`0 0 8px ${C.teal}60` }}/>
              </div>
            </div>
          </aside>
            </>
          )}
        </div>

        {/* ── FOOTER / PROMPT BAR ── */}
        <footer style={{ padding:'12px 20px', borderTop:`1px solid ${C.border}`, display:'flex', gap:12, alignItems:'center', background:C.panel, flexShrink:0 }}>
          <span style={{ color:C.teal, fontSize:18, flexShrink:0, lineHeight:1, fontWeight:600 }}>$</span>
          <input
            value={promptText}
            onChange={e => setPromptText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !demoRunning && runDemo()}
            placeholder="Describe workflow for demo..."
            style={{ flex:1, background:'transparent', border:'none', outline:'none', color:C.white, fontSize:13, caretColor:C.teal }}
          />
          <button
            onClick={runDemo}
            disabled={demoRunning}
            style={{ padding:'8px 20px', borderRadius:4, cursor:demoRunning ? 'not-allowed' : 'pointer', background:demoRunning ? 'transparent' : C.teal, border:`1px solid ${demoRunning ? C.dimText : C.teal}`, color:demoRunning ? C.dimText : C.bg, fontSize:11, fontWeight:600, transition:'all 0.2s', flexShrink:0 }}
          >
            {demoRunning ? 'Running...' : 'Run Demo'}
          </button>
        </footer>
      </div>
    </>
  );
}

export default OrreryDashboard;
