/**
 * TopologyView.jsx
 * Live agent topology — shows agents grouped by type around a central hub,
 * with session connections and real-time activity pulses.
 *
 * Structure:
 *   Hub (center) → Agent nodes (by type) → Session nodes (per agent)
 *   Activity rings pulse on nodes receiving events
 */

import { useRef, useEffect, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { C, AGENT_COLORS, EVTCOL, TYPE_COLORS } from './theme.js';

const AGENT_ICONS = {
  claude: '\u25C8', gemini: '\u25C9', codex: '\u25A3',
  cursor: '\u25C6', detector: '\u2B21', unknown: '\u25CB',
};

const EVENT_ICONS = {
  agent_spawn: '\u25B6', agent_done: '\u25A0', model_call: '\u2726',
  file_access: '\u25A3', mcp_call: '\u25C6', api_call: '\u2295',
  ipc_message: '\u21C4', handoff: '\u2192', permission_request: '\u26A0',
  system: '\u25CF',
};

export function TopologyView({ agents, events, sessions }) {
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const simRef = useRef(null);
  const zoomTransformRef = useRef(d3.zoomIdentity);
  const [tick, setTick] = useState(0);
  const [hoveredNode, setHoveredNode] = useState(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const centerRef = useRef({ x: 400, y: 300 });

  // Count recent events per agent (last 60s) for activity rings
  const activityMap = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    const map = new Map();
    events.filter(e => e.timestamp > cutoff).forEach(e => {
      // Map events to agent IDs
      const keys = [e.sessionId, e.parentId, e.id, e.source, e.target].filter(Boolean);
      keys.forEach(k => {
        // Match against agent IDs
        agents.forEach(a => {
          if (k === a.sessionId || k === a.id || k.includes(a.id)) {
            map.set(a.id, (map.get(a.id) || 0) + 1);
          }
        });
      });
    });
    return map;
  }, [events, agents]);

  // Build graph: hub → agent type groups → individual agents → sessions
  useEffect(() => {
    const nodeMap = new Map();
    const linkList = [];

    // Measure container for centering
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      centerRef.current = { x: rect.width / 2, y: rect.height / 2 };
    }
    const cx = centerRef.current.x;
    const cy = centerRef.current.y;

    // Central hub — fixed at center of viewport
    nodeMap.set('hub', {
      id: 'hub', type: 'hub', label: 'Orrery',
      r: 28, color: C.teal, fx: cx, fy: cy,
    });

    // Group agents by type
    const typeGroups = new Map();
    const realAgents = agents.filter(a => a.agentType !== 'detector');
    realAgents.forEach(a => {
      const type = a.agentType || 'unknown';
      if (!typeGroups.has(type)) typeGroups.set(type, []);
      typeGroups.get(type).push(a);
    });

    // Create type group nodes and agent nodes
    const types = [...typeGroups.keys()];
    types.forEach((type, i) => {
      const groupId = `group-${type}`;
      const color = AGENT_COLORS[type] || AGENT_COLORS.unknown;
      const agentsOfType = typeGroups.get(type);

      // Group node
      nodeMap.set(groupId, {
        id: groupId, type: 'group', agentType: type,
        label: `${type} (${agentsOfType.length})`,
        r: 20, color,
      });
      linkList.push({ source: 'hub', target: groupId, type: 'group' });

      // Individual agent nodes
      agentsOfType.forEach(a => {
        const activity = activityMap.get(a.id) || 0;
        nodeMap.set(a.id, {
          id: a.id, type: 'agent', agentType: a.agentType,
          label: a.label || a.id,
          status: a.status,
          r: 14 + Math.min(activity, 20) * 0.3,
          color,
          activity,
          pid: a.pid,
          sessionId: a.sessionId,
        });
        linkList.push({ source: groupId, target: a.id, type: 'agent' });
      });
    });

    // Preserve positions
    const oldPos = new Map();
    nodesRef.current.forEach(n => oldPos.set(n.id, { x: n.x, y: n.y }));

    const nodes = [...nodeMap.values()].map(n => {
      const old = oldPos.get(n.id);
      if (n.fx !== undefined) return n; // hub stays fixed
      return old ? { ...n, x: old.x, y: old.y } : n;
    });

    const links = linkList;
    nodesRef.current = nodes;
    linksRef.current = links;

    if (!simRef.current) {
      simRef.current = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id)
          .distance(d => d.type === 'group' ? 180 : 100)
          .strength(d => d.type === 'group' ? 0.8 : 0.5))
        .force('charge', d3.forceManyBody()
          .strength(d => d.type === 'hub' ? -600 : d.type === 'group' ? -300 : -150))
        .force('center', d3.forceCenter(cx, cy).strength(0.1))
        .force('collide', d3.forceCollide().radius(d => d.r + 20))
        .alphaDecay(0.15)
        .velocityDecay(0.7)
        .on('tick', () => setTick(t => t + 1));
      // Stop after initial layout
      setTimeout(() => simRef.current?.stop(), 800);
    } else {
      simRef.current.nodes(nodes);
      simRef.current.force('link').links(links);
      simRef.current.force('center', d3.forceCenter(cx, cy).strength(0.1));
      simRef.current.alpha(0.3).restart();
      setTimeout(() => simRef.current?.stop(), 500);
    }
  }, [agents, activityMap]);

  // Zoom
  const zoomRef = useRef(null);
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const zoom = d3.zoom()
      .scaleExtent([0.2, 4])
      .filter((event) => {
        // Let drag handle mousedown on nodes; zoom handles everything else
        return !event.target.closest('.topo-node');
      })
      .on('zoom', (e) => { zoomTransformRef.current = e.transform; setTick(t => t + 1); });
    svg.call(zoom);
    zoomRef.current = zoom;
    svg.on('dblclick.zoom', () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity));
    return () => { simRef.current?.stop(); };
  }, []);

  // Drag behavior — applied to node <g> elements after each render
  useEffect(() => {
    if (!svgRef.current || !simRef.current) return;
    const svg = d3.select(svgRef.current);

    const drag = d3.drag()
      .on('start', (event, d) => {
        // Reheat sim so other nodes react
        simRef.current.alphaTarget(0.1).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        // Account for zoom transform
        const t = zoomTransformRef.current;
        d.fx = (event.sourceEvent.offsetX - t.x) / t.k;
        d.fy = (event.sourceEvent.offsetY - t.y) / t.k;
        setTick(k => k + 1);
      })
      .on('end', (event, d) => {
        simRef.current.alphaTarget(0);
        setTimeout(() => simRef.current?.stop(), 400);
        // Release fixed position unless it's the hub
        if (d.type !== 'hub') {
          d.fx = null;
          d.fy = null;
        }
      });

    // Bind drag to all node groups
    svg.selectAll('.topo-node').each(function () {
      const el = d3.select(this);
      const nodeId = el.attr('data-id');
      const node = nodesRef.current.find(n => n.id === nodeId);
      if (node) {
        el.datum(node).call(drag);
      }
    });
  }, [tick]); // Re-bind when nodes update

  // Recent event feed for sidebar
  const recentEvents = useMemo(() => {
    const filtered = hoveredNode
      ? events.filter(e => {
          const n = hoveredNode;
          return e.sessionId === n.sessionId || e.parentId === n.id || e.id === n.id ||
                 e.source === n.id || e.target === n.id;
        }).slice(-15)
      : events.slice(-15);
    return filtered.reverse();
  }, [events, hoveredNode]);

  const nodes = nodesRef.current;
  const links = linksRef.current;
  const transform = zoomTransformRef.current;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', background: C.bg }}>
      {/* SVG area */}
      <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <defs>
            <pattern id="tg" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.4" fill={C.border} opacity="0.2" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#tg)" />
        </svg>

        <svg ref={svgRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', cursor: 'grab' }}>
          <defs>
            {/* Animated pulse for active agents */}
            <style>{`
              @keyframes topo-pulse { 0% { r: 0; opacity: 0.5; } 100% { r: 30; opacity: 0; } }
              .topo-pulse { animation: topo-pulse 2s ease-out infinite; }
            `}</style>
          </defs>
          <g transform={transform.toString()}>
            {/* Links */}
            {links.map((l, i) => {
              const src = typeof l.source === 'object' ? l.source : nodes.find(n => n.id === l.source);
              const tgt = typeof l.target === 'object' ? l.target : nodes.find(n => n.id === l.target);
              if (!src?.x || !tgt?.x) return null;
              const isGroup = l.type === 'group';
              return (
                <line key={i}
                  x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                  stroke={tgt.color || C.border}
                  strokeWidth={isGroup ? 2 : 1}
                  strokeOpacity={isGroup ? 0.3 : 0.15}
                  strokeDasharray={isGroup ? undefined : '4 3'}
                />
              );
            })}

            {/* Nodes */}
            {nodes.map(n => {
              if (!n.x) return null;
              const isHub = n.type === 'hub';
              const isGroup = n.type === 'group';
              const isAgent = n.type === 'agent';
              const isActive = n.status === 'active';
              const isHovered = hoveredNode?.id === n.id;
              const color = n.color || C.dimText;
              const activity = n.activity || 0;

              return (
                <g key={n.id}
                  className="topo-node"
                  data-id={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: 'grab' }}
                  onMouseEnter={() => isAgent && setHoveredNode(n)}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  {/* Activity pulse ring for active agents */}
                  {isAgent && isActive && activity > 0 && (
                    <circle className="topo-pulse" r={n.r} fill="none" stroke={color} strokeWidth={1.5} />
                  )}

                  {/* Hover highlight */}
                  {isHovered && <circle r={n.r + 12} fill={color} opacity={0.08} />}

                  {/* Activity ring (size = event count) */}
                  {isAgent && activity > 0 && (
                    <circle r={n.r + 4} fill="none" stroke={color}
                      strokeWidth={Math.min(activity / 3, 4)}
                      strokeOpacity={0.25}
                    />
                  )}

                  {/* Main circle */}
                  <circle r={n.r}
                    fill={isHub ? C.teal + '15' : C.panel}
                    stroke={color}
                    strokeWidth={isHub ? 3 : isGroup ? 2 : isHovered ? 2.5 : 1.5}
                    opacity={isAgent && !isActive ? 0.4 : 1}
                  />

                  {/* Icon / text */}
                  {isHub ? (
                    <text textAnchor="middle" dominantBaseline="central"
                      fontSize={11} fill={C.teal} fontWeight={700}
                      style={{ userSelect: 'none' }}
                    >{'\u2B21'}</text>
                  ) : isGroup ? (
                    <text textAnchor="middle" dominantBaseline="central"
                      fontSize={14} fill={color}
                      style={{ fontFamily: 'monospace', userSelect: 'none', fontWeight: 600 }}
                    >{AGENT_ICONS[n.agentType] || AGENT_ICONS.unknown}</text>
                  ) : (
                    <>
                      <text textAnchor="middle" dominantBaseline="central"
                        fontSize={n.r * 0.7} fill={color}
                        style={{ fontFamily: 'monospace', userSelect: 'none' }}
                      >{AGENT_ICONS[n.agentType] || AGENT_ICONS.unknown}</text>
                      {/* Status dot */}
                      <circle cx={n.r - 1} cy={-n.r + 1} r={3.5}
                        fill={isActive ? '#98c379' : C.dimText}
                        stroke={C.panel} strokeWidth={1.5}
                      />
                    </>
                  )}

                  {/* Label */}
                  <text textAnchor="middle" y={n.r + 13}
                    fontSize={isHub ? 11 : isGroup ? 10 : 9}
                    fill={isHovered ? C.white : isGroup ? color : C.dimText}
                    fontWeight={isHub || isGroup ? 600 : 400}
                  >
                    {isHub ? 'Orrery' : isGroup ? n.agentType : n.label}
                  </text>

                  {/* Activity count badge */}
                  {isAgent && activity > 0 && (
                    <g transform={`translate(${-n.r + 1}, ${n.r - 1})`}>
                      <circle r={7} fill={color} />
                      <text textAnchor="middle" dominantBaseline="central"
                        fontSize={8} fill={C.bg} fontWeight={700}
                      >{activity > 99 ? '99+' : activity}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {/* Controls */}
        <div style={{
          position: 'absolute', top: 12, right: 12, background: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px',
          fontSize: 10, color: C.dimText, lineHeight: 1.6,
        }}>
          Drag to pan / Scroll to zoom / Hover agent for details
        </div>
      </div>

      {/* Right sidebar — agent detail or legend */}
      <div style={{
        width: 260, borderLeft: `1px solid ${C.border}`, background: C.panel,
        display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
      }}>
        {hoveredNode && hoveredNode.type === 'agent' ? (
          <>
            {/* Agent detail header */}
            <div style={{ padding: 16, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: hoveredNode.status === 'active' ? '#98c379' : C.dimText,
                }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: C.white }}>
                  {hoveredNode.label}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Pill label={hoveredNode.agentType} color={hoveredNode.color} />
                <Pill label={hoveredNode.status} color={hoveredNode.status === 'active' ? '#98c379' : C.dimText} />
                {hoveredNode.activity > 0 && (
                  <Pill label={`${hoveredNode.activity} events/min`} color={C.teal} />
                )}
              </div>
            </div>

            {/* Recent events for this agent */}
            <div style={{ padding: '8px 0', fontSize: 10, color: C.dimText, fontWeight: 600, paddingLeft: 16 }}>
              Recent Activity
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '0 8px' }}>
              {recentEvents.length === 0 && (
                <div style={{ padding: 16, fontSize: 11, color: C.dimText, textAlign: 'center' }}>
                  No recent events
                </div>
              )}
              {recentEvents.map((e, i) => (
                <div key={i} style={{
                  padding: '6px 8px', borderBottom: `1px solid ${C.border}30`,
                  display: 'flex', gap: 8, alignItems: 'flex-start',
                }}>
                  <span style={{
                    color: EVTCOL[e.type] || TYPE_COLORS[e.type] || C.dimText,
                    fontSize: 11, fontFamily: 'monospace', flexShrink: 0,
                  }}>
                    {EVENT_ICONS[e.type] || '\u25CF'}
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {e.label || e.type}
                    </div>
                    <div style={{ fontSize: 9, color: C.dimText }}>
                      {e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {/* Legend */}
            <div style={{ padding: 16, borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.white, marginBottom: 12 }}>Agent Types</div>
              {Object.entries(AGENT_COLORS).filter(([k]) => k !== 'unknown').map(([type, color]) => {
                const count = agents.filter(a => a.agentType === type).length;
                return (
                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{ color, fontSize: 14, fontFamily: 'monospace' }}>{AGENT_ICONS[type]}</span>
                    <span style={{ fontSize: 11, color: C.white, textTransform: 'capitalize', flex: 1 }}>{type}</span>
                    <span style={{ fontSize: 11, color: C.dimText }}>{count}</span>
                  </div>
                );
              })}
            </div>

            <div style={{ padding: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.white, marginBottom: 12 }}>Activity</div>
              <div style={{ fontSize: 11, color: C.dimText, lineHeight: 1.8 }}>
                <div>Ring thickness = event frequency</div>
                <div>Pulse = receiving events now</div>
                <div>Badge = events in last 60s</div>
                <div>Green dot = active</div>
                <div style={{ marginTop: 8, color: C.teal }}>Hover an agent for details</div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Pill({ label, color }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 500,
      background: color + '20', color, border: `1px solid ${color}40`,
      textTransform: 'capitalize',
    }}>
      {label}
    </span>
  );
}
