/**
 * LiveFeedView.jsx
 * Real-time event stream with type filtering and auto-scroll.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { C, EVTCOL } from './theme.js';

const EVTICON = {
  agent_spawn: '\u25C8', model_call: '\u25C9', file_access: '\u25A3',
  mcp_call: '\u25C6', api_call: '\u2295', permission_request: '\u26A0',
  ipc_message: '\u25C7', handoff: '\u21C6', agent_done: '\u25CB',
  system: '\u2022', permission_resolve: '\u2713',
};

const ALL_TYPES = [
  'agent_spawn', 'model_call', 'file_access', 'mcp_call', 'api_call',
  'permission_request', 'ipc_message', 'handoff', 'agent_done', 'system',
];

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function LiveFeedView({ events }) {
  const [enabledTypes, setEnabledTypes] = useState(() => new Set(ALL_TYPES));

  // Track which types have actual events
  const presentTypes = useMemo(() => {
    const set = new Set();
    events.forEach(e => set.add(e.type));
    return set;
  }, [events]);
  const [paused, setPaused] = useState(false);
  const containerRef = useRef(null);

  const filtered = useMemo(() => {
    return events.filter(e => enabledTypes.has(e.type)).slice(-500).reverse();
  }, [events, enabledTypes]);

  // Events per minute
  const epm = useMemo(() => {
    const now = Date.now();
    const oneMinAgo = now - 60_000;
    return events.filter(e => e.timestamp > oneMinAgo).length;
  }, [events]);

  // Auto-scroll
  useEffect(() => {
    if (!paused && containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [filtered, paused]);

  const toggleType = (type) => {
    setEnabledTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20 }}>
      {/* Filter bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {ALL_TYPES.map(type => {
          const active = enabledTypes.has(type);
          const hasEvents = presentTypes.has(type);
          const color = EVTCOL[type] || C.dimText;
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              style={{
                padding: '3px 10px', fontSize: 10, fontWeight: 500,
                border: `1px solid ${active && hasEvents ? color : C.border}`,
                borderRadius: 12, cursor: hasEvents ? 'pointer' : 'default',
                background: active && hasEvents ? `${color}20` : 'transparent',
                color: active && hasEvents ? color : C.dimText,
                opacity: hasEvents ? 1 : 0.3,
                transition: 'all 0.15s',
              }}
            >
              {EVTICON[type] || '\u2022'} {type.replace('_', ' ')}
            </button>
          );
        })}

        <div style={{ flex: 1 }} />

        {/* Events/min counter */}
        <span style={{ fontSize: 11, color: C.dimText, fontFamily: 'monospace' }}>
          {epm} evt/min
        </span>

        {/* Pause button */}
        <button
          onClick={() => setPaused(p => !p)}
          style={{
            padding: '4px 12px', fontSize: 11, border: `1px solid ${C.border}`,
            borderRadius: 4, cursor: 'pointer',
            background: paused ? C.amber + '20' : C.panel,
            color: paused ? C.amber : C.dimText,
          }}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {/* Event list */}
      <div
        ref={containerRef}
        style={{
          flex: 1, overflow: 'auto', background: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 6,
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: C.dimText, fontSize: 12 }}>
            {events.length === 0 ? 'No events yet -- waiting for agent activity' : 'No events match current filters'}
          </div>
        ) : (
          filtered.map((evt, i) => {
            const color = EVTCOL[evt.type] || C.dimText;
            return (
              <div
                key={`${evt.timestamp}-${evt.id || i}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '5px 12px',
                  borderBottom: `1px solid ${C.border}`,
                  borderLeft: `2px solid ${color}`,
                  fontSize: 11,
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = C.dim}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {/* Timestamp */}
                <span style={{ color: C.dimText, fontFamily: 'monospace', flexShrink: 0, width: 64 }}>
                  {formatTime(evt.timestamp)}
                </span>

                {/* Session badge */}
                {evt.sessionId && (
                  <span style={{
                    padding: '1px 6px', fontSize: 9, fontWeight: 500,
                    background: C.dim, borderRadius: 3, color: C.dimText,
                    fontFamily: 'monospace', flexShrink: 0, maxWidth: 80,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {evt.sessionId.replace(/^session-/, '').slice(0, 10)}
                  </span>
                )}

                {/* Type icon */}
                <span style={{ color, flexShrink: 0, width: 14, textAlign: 'center' }}>
                  {EVTICON[evt.type] || '\u2022'}
                </span>

                {/* Agent */}
                <span style={{ color: C.dimText, fontFamily: 'monospace', flexShrink: 0, width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {evt.parentId || evt.source || '--'}
                </span>

                {/* Label */}
                <span style={{ color: C.white, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {evt.label || evt.type}
                </span>

                {/* Tokens */}
                {evt.metadata?.tokens > 0 && (
                  <span style={{ color: C.dimText, fontFamily: 'monospace', flexShrink: 0 }}>
                    {evt.metadata.tokens.toLocaleString()} tok
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
