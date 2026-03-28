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

// ─── CONFIG — edit these ──────────────────────────────────────────────────────

const WS_URL        = 'ws://localhost:4242';   // ← your ws-server address
const NODE_TTL_MS   = 60_000;                  // cull nodes inactive > 60s
const CULL_INTERVAL = 5_000;                   // culling check frequency (ms)
const PERMANENT_IDS = new Set(['orch']);        // nodes that are never culled

// ─── THEME ───────────────────────────────────────────────────────────────────

const C = {
  bg: '#04080f', panel: '#060c17', border: '#0c1e38',
  teal: '#00e5c8', amber: '#ffb347', purple: '#b388ff',
  green: '#4ade80', red: '#f87171', blue: '#5eabff',
  magenta: '#f472b6', yellow: '#ffd60a', coral: '#ff6b6b',
  white: '#dde6f8', dim: '#0f1f35', dimText: '#3a587a',
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
  { t: 500,   type: 'agent_spawn',        id: 'ag1',  parentId: 'orch', label: 'Main Agent' },
  { t: 1100,  type: 'model_call',         id: 'md1',  parentId: 'ag1',  label: 'claude-sonnet', metadata: { tokens: 1800 } },
  { t: 1700,  type: 'permission_request', id: 'pm1',  parentId: 'ag1',  label: 'Read: /src',        action: 'Directory read' },
  { t: 2400,  type: 'permission_resolve', id: 'pm1',  status: 'approved' },
  { t: 2700,  type: 'file_access',        id: 'f1',   parentId: 'ag1',  label: 'src/index.ts' },
  { t: 3200,  type: 'api_call',           id: 'api1', parentId: 'ag1',  label: 'GitHub API' },
  { t: 3800,  type: 'agent_spawn',        id: 'ag2',  parentId: 'ag1',  label: 'Code Agent' },
  { t: 3900,  type: 'handoff',            source: 'ag1', target: 'ag2', label: 'task context' },
  { t: 4600,  type: 'model_call',         id: 'md2',  parentId: 'ag2',  label: 'claude-opus',  metadata: { tokens: 3200 } },
  { t: 5200,  type: 'permission_request', id: 'pm2',  parentId: 'ag2',  label: 'Execute: npm test', action: 'Shell command' },
  { t: 6000,  type: 'permission_resolve', id: 'pm2',  status: 'approved' },
  { t: 6300,  type: 'mcp_call',           id: 'mc1',  parentId: 'ag2',  label: 'memory-mcp' },
  { t: 6900,  type: 'agent_spawn',        id: 'ag3',  parentId: 'ag1',  label: 'Review Agent' },
  { t: 7300,  type: 'ipc_message',        source: 'ag2', target: 'ag3', message: 'task data' },
  { t: 7900,  type: 'model_call',         id: 'md3',  parentId: 'ag3',  label: 'gpt-4o',       metadata: { tokens: 1100 } },
  { t: 8300,  type: 'handoff',            source: 'md2', target: 'md3', label: 'model handoff' },
  { t: 8700,  type: 'api_call',           id: 'api2', parentId: 'ag3',  label: 'Slack API' },
  { t: 9100,  type: 'permission_request', id: 'pm3',  parentId: 'ag3',  label: 'Write: output.md',  action: 'File write' },
  { t: 9900,  type: 'permission_resolve', id: 'pm3',  status: 'denied' },
  { t: 10300, type: 'mcp_call',           id: 'mc2',  parentId: 'ag2',  label: 'proxy-mcp' },
  { t: 10800, type: 'ipc_message',        source: 'ag3', target: 'ag1', message: 'result' },
  { t: 11200, type: 'agent_spawn',        id: 'ag4',  parentId: 'ag2',  label: 'Test Agent' },
  { t: 11600, type: 'handoff',            source: 'ag2', target: 'ag4', label: 'test suite' },
  { t: 12000, type: 'model_call',         id: 'md4',  parentId: 'ag4',  label: 'claude-haiku', metadata: { tokens: 560 } },
  { t: 12400, type: 'mcp_call',           id: 'mc3',  parentId: 'ag4',  label: 'ipc-mcp' },
  { t: 12900, type: 'handoff',            source: 'ag4', target: 'orch', label: 'final result' },
  { t: 13500, type: 'agent_done',         id: 'ag4' },
  { t: 14000, type: 'agent_done',         id: 'ag3' },
];

// ─── GRAPH CANVAS SIZE ────────────────────────────────────────────────────────

const W = 600, H = 460;

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function AgentTopologyDashboard() {
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

  // React UI state
  const [tick,           setTick]          = useState(0);
  const [permissions,    setPermissions]   = useState([]);
  const [events,         setEvents]        = useState([]);
  const [metrics,        setMetrics]       = useState({ tokens: 0, cost: 0, agents: 0, calls: 0, perms: 0 });
  const [activeNodes,    setActiveNodes]   = useState(new Set());
  const [demoRunning,    setDemoRunning]   = useState(false);
  const [promptText,     setPromptText]    = useState('');
  const [promptDisplay,  setPromptDisplay] = useState('');

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

  const refreshSim = useCallback((alpha = 0.3) => {
    simRef.current.nodes(nodesRef.current);
    simRef.current.force('link').links(linksRef.current);
    simRef.current.alpha(alpha).restart();
  }, []);

  // ── Core event router — processes batches from WebSocket or demo ──────────
  const handleIncomingEvents = useCallback((batch) => {
    let needsRefresh = false;
    const now = Date.now();

    const processEvent = (payload) => {
      const { type, id } = payload;

      // Orphan queue — hold events whose parent hasn't arrived yet
      if (payload.parentId && !nodesRef.current.some(n => n.id === payload.parentId)) {
        orphanQueueRef.current.set(id ?? Math.random(), payload);
        return;
      }

      // ── Spawn node types ─────────────────────────────────────────────────
      if (TYPE_MAP[type]) {
        const nodeType = TYPE_MAP[type];
        const existing = nodesRef.current.find(n => n.id === id);
        if (existing) { existing.lastActive = now; return; }

        nodesRef.current.push({
          id, type: nodeType,
          label:      payload.label || id,
          lastActive: now,
          completed:  false,
          x: W/2 + (Math.random() - 0.5) * 120,
          y: H/2 + (Math.random() - 0.5) * 120,
        });

        if (payload.parentId) linksRef.current.push({ source: payload.parentId, target: id });
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
    if (needsRefresh) refreshSim(0.3);
  }, [flash, addLog, startRaf, refreshSim]);

  // ── Initialize D3 simulation ──────────────────────────────────────────────
  useEffect(() => {
    const orch = {
      id: 'orch', type: 'orchestrator', label: 'Orchestrator',
      x: W/2, y: H/2, fx: W/2, fy: H/2, lastActive: Date.now(), completed: false,
    };
    nodesRef.current    = [orch];
    linksRef.current    = [];
    ipcRef.current      = [];
    handoffsRef.current = [];

    simRef.current = d3.forceSimulation(nodesRef.current)
      .force('link', d3.forceLink(linksRef.current).id(d => d.id).distance(100).strength(0.5))
      .force('charge', d3.forceManyBody().strength(-280))
      .force('center', d3.forceCenter(W/2, H/2))
      .force('collide', d3.forceCollide().radius(d => (NSTYLE[d.type]?.r ?? 14) + 24))
      .alphaDecay(0.022)
      .on('tick', () => setTick(k => k + 1));

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
        PERMANENT_IDS.has(n.id) || (n.lastActive ?? 0) > cutoff
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
    refreshSim(0.9);

    setTick(0);
    setEvents([]);
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
  const nodes    = nodesRef.current;
  const links    = linksRef.current;
  const ipcEdges = ipcRef.current;
  const handoffs = handoffsRef.current;
  const easeIO   = t => t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t;
  const statusCol = STATUS_COLOR[socketStatus] ?? C.dimText;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        @keyframes dashFlow  { to { stroke-dashoffset:-24; } }
        @keyframes ipcFlow   { to { stroke-dashoffset:-32; } }
        @keyframes fadeSlide { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes blink     { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes rippleOut { 0%{transform:scale(1);opacity:0.9} 100%{transform:scale(3.5);opacity:0} }
        .link-tree { stroke-dasharray:7 5; animation:dashFlow 0.65s linear infinite; }
        .link-ipc  { stroke-dasharray:12 6; animation:ipcFlow 0.8s linear infinite; }
        .evt-row   { animation:fadeSlide 0.2s ease; }
        .blinker   { animation:blink 1.1s ease-in-out infinite; }
        .ripple-el { animation:rippleOut 1.5s ease-out forwards; transform-box:fill-box; transform-origin:center; }
        .perm-ring { animation:blink 0.9s ease-in-out infinite; }
        ::-webkit-scrollbar { width:3px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:#0f1f35; border-radius:2px; }
      `}</style>

      <div style={{ width:'100%', minHeight:'100vh', background:C.bg, fontFamily:"'Share Tech Mono',monospace", color:C.white, display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* ── HEADER ── */}
        <header style={{ padding:'10px 18px', borderBottom:`1px solid ${C.border}`, background:C.panel, display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <svg width="30" height="30" viewBox="0 0 30 30">
              <polygon points="15,2 26,8.5 26,21.5 15,28 4,21.5 4,8.5" fill="none" stroke={C.teal} strokeWidth="1.5" style={{ filter:`drop-shadow(0 0 4px ${C.teal})` }}/>
              <polygon points="15,8 21,11.5 21,18.5 15,22 9,18.5 9,11.5" fill={C.teal} opacity="0.12"/>
              <circle cx="15" cy="15" r="3" fill={C.teal} style={{ filter:`drop-shadow(0 0 3px ${C.teal})` }}/>
            </svg>
            <div>
              <div style={{ fontFamily:"'Orbitron',monospace", fontSize:11, color:C.teal, letterSpacing:3.5, fontWeight:700 }}>AGENT TOPOLOGY</div>
              <div style={{ fontSize:8, color:C.dimText, letterSpacing:2 }}>REAL · TIME · WORKFLOW · MONITOR</div>
            </div>
          </div>

          <div style={{ display:'flex', gap:20 }}>
            {[
              ['TOKENS', metrics.tokens.toLocaleString(), C.teal],
              ['COST',   `$${metrics.cost.toFixed(4)}`,  C.amber],
              ['AGENTS', metrics.agents,                  C.blue],
              ['LLM',    metrics.calls,                   C.purple],
              ['PERMS',  metrics.perms,                   C.yellow],
            ].map(([l, v, col]) => (
              <div key={l} style={{ textAlign:'center' }}>
                <div style={{ fontSize:7, color:C.dimText, letterSpacing:2, marginBottom:2 }}>{l}</div>
                <div style={{ fontFamily:"'Orbitron',monospace", fontSize:14, color:col, fontWeight:700, transition:'all 0.3s' }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div className={['connecting','reconnecting'].includes(socketStatus) ? 'blinker' : ''} style={{ width:8, height:8, borderRadius:'50%', background:statusCol, boxShadow:`0 0 8px ${statusCol}60`, transition:'all 0.4s' }}/>
            <span style={{ fontSize:9, color:statusCol, letterSpacing:2, textTransform:'uppercase' }}>{socketStatus}</span>
          </div>
        </header>

        {/* ── BODY ── */}
        <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>

          {/* LEFT: Node registry */}
          <aside style={{ width:168, borderRight:`1px solid ${C.border}`, background:C.panel, overflow:'auto', flexShrink:0 }}>
            <div style={{ padding:'10px 12px 6px', fontSize:7.5, color:C.dimText, letterSpacing:2, borderBottom:`1px solid ${C.border}` }}>NODE REGISTRY</div>
            {nodes.map(n => {
              const s      = NSTYLE[n.type] ?? NSTYLE.agent;
              const col    = n.completed ? C.dimText : n.resolved === 'approved' ? C.green : n.resolved === 'denied' ? C.red : s.color;
              const isActive = activeNodes.has(n.id);
              return (
                <div key={n.id} style={{ padding:'5px 12px', display:'flex', alignItems:'center', gap:8, borderLeft:`2px solid ${isActive ? col : 'transparent'}`, background:isActive ? `${col}10` : 'transparent', transition:'all 0.35s', opacity:n.completed ? 0.4 : 1 }}>
                  <span style={{ color:col, fontSize:13, flexShrink:0 }}>{n.completed ? '◻' : NICON[n.type]}</span>
                  <div style={{ minWidth:0, flex:1 }}>
                    <div style={{ fontSize:10, color:isActive ? col : C.white, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', transition:'color 0.35s' }}>{n.label}</div>
                    <div style={{ fontSize:7.5, color:C.dimText, textTransform:'uppercase', letterSpacing:1 }}>{n.completed ? 'done' : n.type}</div>
                  </div>
                  {isActive && <div style={{ width:4, height:4, borderRadius:'50%', background:col, boxShadow:`0 0 6px ${col}`, flexShrink:0 }}/>}
                </div>
              );
            })}
          </aside>

          {/* CENTER: D3 force graph */}
          <main style={{ flex:1, position:'relative', overflow:'hidden', minWidth:0 }}>
            {/* CRT scanlines */}
            <div style={{ position:'absolute', inset:0, pointerEvents:'none', zIndex:8, background:'repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,229,200,0.012) 3px,rgba(0,229,200,0.012) 4px)' }}/>
            {/* Dot grid */}
            <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%' }}>
              <defs><pattern id="dots" x="0" y="0" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="0.9" fill={C.dim}/></pattern></defs>
              <rect width="100%" height="100%" fill="url(#dots)"/>
            </svg>

            {/* Main graph SVG */}
            <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%' }} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
              <defs>
                {Object.keys(NSTYLE).map(type => (
                  <filter key={type} id={`glow-${type}`} x="-60%" y="-60%" width="220%" height="220%">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/>
                    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                  </filter>
                ))}
                <marker id="arr-ipc" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill={C.magenta} opacity="0.85"/>
                </marker>
              </defs>

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
                  <g key={n.id} transform={`translate(${Math.round(n.x)},${Math.round(n.y)})`} opacity={n.completed ? 0.3 : 1} style={{ transition:'opacity 1.2s' }}>
                    {isActive  && <circle className="ripple-el" r={s.r} fill="none" stroke={col} strokeWidth={2}/>}
                    {isPending && <circle className="perm-ring" r={s.r + 11} fill="none" stroke={C.yellow} strokeWidth={1.2} opacity={0.5}/>}
                    <circle r={s.r + 14} fill={col} opacity={isActive ? 0.14 : 0.04} style={{ transition:'opacity 0.5s' }}/>
                    <circle r={s.r + 5}  fill="none" stroke={col} strokeWidth={0.6} opacity={isActive ? 0.45 : 0.1} style={{ transition:'opacity 0.5s' }}/>
                    <circle r={s.r}      fill={C.bg} stroke={col} strokeWidth={isActive ? 2.5 : 1.5} filter={`url(#glow-${n.type})`} style={{ transition:'all 0.4s' }}/>
                    <text textAnchor="middle" dominantBaseline="central" fontSize={s.r * 0.85} fill={col} style={{ fontFamily:'monospace', userSelect:'none' }}>{n.completed ? '◻' : NICON[n.type]}</text>
                    <text textAnchor="middle" y={s.r + 14} fontSize={8.5} fill={isActive ? col : C.dimText} style={{ fontFamily:"'Share Tech Mono',monospace", transition:'fill 0.4s' }}>{n.label}</text>
                  </g>
                );
              })}
            </svg>

            {/* Prompt display */}
            {promptDisplay && (
              <div style={{ position:'absolute', bottom:12, left:'50%', transform:'translateX(-50%)', padding:'5px 16px', borderRadius:3, background:'rgba(4,8,15,0.9)', border:`1px solid ${C.border}`, fontSize:9, color:C.dimText, maxWidth:'76%', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', backdropFilter:'blur(8px)', zIndex:10 }}>
                <span style={{ color:C.teal }}>▶ </span>{promptDisplay}
              </div>
            )}

            {/* Edge legend */}
            <div style={{ position:'absolute', top:10, left:10, background:'rgba(4,8,15,0.88)', border:`1px solid ${C.border}`, padding:'9px 12px', borderRadius:3, backdropFilter:'blur(6px)', zIndex:10 }}>
              <div style={{ fontSize:7, color:C.dimText, letterSpacing:2, marginBottom:7 }}>EDGE TYPES</div>
              {[
                { label:'parent → child', color:C.blue,    dash:'7 5', w:1.5 },
                { label:'IPC channel',    color:C.magenta, dash:'12 6', w:2.5 },
                { label:'handoff packet', color:C.teal,    dot:true },
              ].map(e => (
                <div key={e.label} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
                  <svg width="28" height="10">
                    {e.dot
                      ? <><line x1="0" y1="5" x2="28" y2="5" stroke={e.color} strokeWidth="1" strokeDasharray="4 4" opacity="0.3"/><circle cx="14" cy="5" r="3.5" fill={e.color} opacity="0.9"/></>
                      : <line x1="0" y1="5" x2="28" y2="5" stroke={e.color} strokeWidth={e.w} strokeDasharray={e.dash}/>
                    }
                  </svg>
                  <span style={{ fontSize:8, color:C.dimText }}>{e.label}</span>
                </div>
              ))}
            </div>

            {/* Node type legend */}
            <div style={{ position:'absolute', top:10, right:10, background:'rgba(4,8,15,0.88)', border:`1px solid ${C.border}`, padding:'9px 12px', borderRadius:3, backdropFilter:'blur(6px)', zIndex:10 }}>
              <div style={{ fontSize:7, color:C.dimText, letterSpacing:2, marginBottom:7 }}>NODE TYPES</div>
              {Object.entries(NSTYLE).map(([type, s]) => (
                <div key={type} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:5, fontSize:8.5, color:C.dimText }}>
                  <span style={{ color:s.color, fontSize:11 }}>{NICON[type]}</span>
                  <span style={{ textTransform:'uppercase', letterSpacing:1 }}>{type}</span>
                </div>
              ))}
            </div>
          </main>

          {/* RIGHT: Permissions + Event stream */}
          <aside style={{ width:235, borderLeft:`1px solid ${C.border}`, display:'flex', flexDirection:'column', background:C.panel, flexShrink:0 }}>

            {/* Permissions panel */}
            <div style={{ flexShrink:0, borderBottom:`1px solid ${C.border}`, maxHeight:'44%', overflow:'auto' }}>
              <div style={{ padding:'9px 12px 5px', fontSize:7.5, color:C.dimText, letterSpacing:2, position:'sticky', top:0, background:C.panel, zIndex:1 }}>
                PERMISSIONS
                {permissions.some(p => p.status === 'pending') &&
                  <span className="blinker" style={{ color:C.yellow, marginLeft:8 }}>● PENDING</span>
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
              <div style={{ padding:'9px 12px 5px', fontSize:7.5, color:C.dimText, letterSpacing:2, borderBottom:`1px solid ${C.border}`, flexShrink:0 }}>EVENT STREAM</div>
              <div style={{ flex:1, overflow:'auto', padding:'4px 0' }}>
                {events.length === 0 &&
                  <div style={{ padding:'22px 12px', fontSize:9.5, color:C.dimText, textAlign:'center', lineHeight:1.9 }}>
                    Run demo or connect<br/>WebSocket to begin
                  </div>
                }
                {events.map(e => (
                  <div key={e.id} className="evt-row" style={{ padding:'4px 12px', borderBottom:`1px solid ${C.dim}40` }}>
                    <div style={{ fontSize:7.5, color:C.dimText, marginBottom:1 }}>{e.t}</div>
                    <div style={{ fontSize:9.5, lineHeight:1.5, color:EVTCOL[e.type] ?? C.white, wordBreak:'break-all' }}>{e.msg}</div>
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
        </div>

        {/* ── FOOTER / PROMPT BAR ── */}
        <footer style={{ padding:'10px 18px', borderTop:`1px solid ${C.border}`, display:'flex', gap:12, alignItems:'center', background:C.panel, flexShrink:0 }}>
          <span style={{ color:C.teal, fontSize:17, flexShrink:0, lineHeight:1 }}>$</span>
          <input
            value={promptText}
            onChange={e => setPromptText(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !demoRunning && runDemo()}
            placeholder="describe workflow for demo — or set WS_URL for live data..."
            style={{ flex:1, background:'transparent', border:'none', outline:'none', color:C.white, fontFamily:"'Share Tech Mono',monospace", fontSize:13, caretColor:C.teal }}
          />
          <button
            onClick={runDemo}
            disabled={demoRunning}
            style={{ padding:'7px 18px', borderRadius:3, cursor:demoRunning ? 'not-allowed' : 'pointer', background:demoRunning ? 'transparent' : `${C.teal}18`, border:`1px solid ${demoRunning ? C.dimText : C.teal}`, color:demoRunning ? C.dimText : C.teal, fontFamily:"'Share Tech Mono',monospace", fontSize:9, letterSpacing:2.5, transition:'all 0.25s', flexShrink:0 }}
          >
            {demoRunning ? 'RUNNING...' : 'RUN DEMO ▶'}
          </button>
        </footer>
      </div>
    </>
  );
}
