/**
 * EventTable.jsx
 * Sortable table of events within a session.
 */

import { useState, useMemo } from 'react';
import { C, EVTCOL } from './theme.js';

const EVTICON = {
  agent_spawn: '\u25C8', model_call: '\u25C9', file_access: '\u25A3',
  mcp_call: '\u25C6', api_call: '\u2295', permission_request: '\u26A0',
  ipc_message: '\u25C7', handoff: '\u21C6', agent_done: '\u25CB',
  system: '\u2022', permission_resolve: '\u2713',
};

function relativeTime(ts, baseTs) {
  if (!ts || !baseTs) return '--';
  const diff = ts - baseTs;
  if (diff < 1000) return `+${diff}ms`;
  if (diff < 60_000) return `+${(diff / 1000).toFixed(1)}s`;
  return `+${Math.floor(diff / 60_000)}m${Math.floor((diff % 60_000) / 1000)}s`;
}

export function EventTable({ events }) {
  const [sortCol, setSortCol] = useState('timestamp');
  const [sortDir, setSortDir] = useState('asc');

  const baseTs = useMemo(() => {
    if (events.length === 0) return 0;
    return Math.min(...events.filter(e => e.timestamp).map(e => e.timestamp));
  }, [events]);

  const sorted = useMemo(() => {
    return [...events].sort((a, b) => {
      let av, bv;
      switch (sortCol) {
        case 'timestamp': av = a.timestamp || 0; bv = b.timestamp || 0; break;
        case 'type': av = a.type || ''; bv = b.type || ''; break;
        case 'agent': av = a.parentId || a.source || ''; bv = b.parentId || b.source || ''; break;
        case 'label': av = a.label || ''; bv = b.label || ''; break;
        case 'tokens': av = a.metadata?.tokens || 0; bv = b.metadata?.tokens || 0; break;
        default: av = 0; bv = 0;
      }
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
  }, [events, sortCol, sortDir]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const cols = [
    { id: 'timestamp', label: 'Time', width: '90px' },
    { id: 'type', label: 'Type', width: '140px' },
    { id: 'agent', label: 'Agent', width: '1fr' },
    { id: 'label', label: 'Label', width: '2fr' },
    { id: 'tokens', label: 'Tokens', width: '80px' },
  ];

  const SortArrow = ({ col }) => {
    if (sortCol !== col) return null;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  if (events.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: C.dimText, fontSize: 12 }}>
        No events in this session
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: cols.map(c => c.width).join(' '),
        padding: '6px 10px',
        borderBottom: `1px solid ${C.border}`,
        position: 'sticky', top: 0, background: C.panel, zIndex: 1,
      }}>
        {cols.map(col => (
          <div
            key={col.id}
            onClick={() => toggleSort(col.id)}
            style={{
              fontSize: 10, fontWeight: 600, color: C.dimText, cursor: 'pointer',
              userSelect: 'none', display: 'flex', alignItems: 'center',
            }}
          >
            {col.label}<SortArrow col={col.id} />
          </div>
        ))}
      </div>

      {/* Rows */}
      {sorted.map((evt, i) => {
        const color = EVTCOL[evt.type] || C.dimText;
        return (
          <div
            key={`${evt.id || evt.timestamp}-${i}`}
            style={{
              display: 'grid',
              gridTemplateColumns: cols.map(c => c.width).join(' '),
              padding: '4px 10px',
              borderBottom: `1px solid ${C.border}`,
              borderLeft: `2px solid ${color}`,
              fontSize: 11,
              transition: 'background 0.1s',
            }}
            onMouseEnter={e => e.currentTarget.style.background = C.dim}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <div style={{ fontFamily: 'monospace', color: C.dimText }}>
              {relativeTime(evt.timestamp, baseTs)}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color, fontSize: 12 }}>{EVTICON[evt.type] || '\u2022'}</span>
              <span style={{ color }}>{evt.type}</span>
            </div>
            <div style={{ fontFamily: 'monospace', color: C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {evt.parentId || evt.source || '--'}
            </div>
            <div style={{ color: C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {evt.label || evt.id || '--'}
            </div>
            <div style={{ fontFamily: 'monospace', color: C.dimText, textAlign: 'right' }}>
              {evt.metadata?.tokens ? evt.metadata.tokens.toLocaleString() : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
