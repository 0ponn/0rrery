/**
 * SessionListView.jsx
 * Filterable, sortable session table.
 */

import { useState, useMemo } from 'react';
import { C, AGENT_COLORS } from './theme.js';

function formatDuration(ms) {
  if (!ms || ms <= 0) return '--';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatTime(ts) {
  if (!ts) return '--';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

export function SessionListView({ sessions, onSelectSession }) {
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState('startTime');
  const [sortDir, setSortDir] = useState('desc');

  const filtered = useMemo(() => {
    let list = sessions;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(s => s.sessionId.toLowerCase().includes(q));
    }
    list = [...list].sort((a, b) => {
      const av = a[sortCol] ?? 0;
      const bv = b[sortCol] ?? 0;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return list;
  }, [sessions, search, sortCol, sortDir]);

  const totals = useMemo(() => ({
    events: filtered.reduce((s, r) => s + (r.eventCount || 0), 0),
  }), [filtered]);

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  };

  const cols = [
    { id: 'sessionId', label: 'Session ID', width: '1fr' },
    { id: 'startTime', label: 'Started', width: '160px' },
    { id: 'duration', label: 'Duration', width: '100px' },
    { id: 'eventCount', label: 'Events', width: '80px' },
  ];

  const SortArrow = ({ col }) => {
    if (sortCol !== col) return null;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20 }}>
      {/* Search */}
      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          placeholder="Filter by session ID..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width: 300, padding: '7px 12px', fontSize: 12,
            background: C.panel, border: `1px solid ${C.border}`, borderRadius: 4,
            color: C.white, outline: 'none', fontFamily: 'Inter, system-ui, sans-serif',
          }}
        />
      </div>

      {/* Table */}
      <div style={{
        flex: 1, overflow: 'auto', background: C.panel,
        border: `1px solid ${C.border}`, borderRadius: 6,
      }}>
        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: cols.map(c => c.width).join(' '),
          padding: '8px 12px',
          borderBottom: `1px solid ${C.border}`,
          position: 'sticky', top: 0, background: C.panel, zIndex: 1,
        }}>
          {cols.map(col => (
            <div
              key={col.id}
              onClick={() => toggleSort(col.id)}
              style={{
                fontSize: 11, fontWeight: 600, color: C.dimText, cursor: 'pointer',
                userSelect: 'none', display: 'flex', alignItems: 'center',
              }}
            >
              {col.label}<SortArrow col={col.id} />
            </div>
          ))}
        </div>

        {/* Rows */}
        {filtered.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: C.dimText, fontSize: 12 }}>
            {sessions.length === 0 ? 'No sessions recorded yet' : 'No sessions match filter'}
          </div>
        ) : (
          filtered.map(session => (
            <div
              key={session.sessionId}
              onClick={() => onSelectSession(session.sessionId)}
              style={{
                display: 'grid',
                gridTemplateColumns: cols.map(c => c.width).join(' '),
                padding: '8px 12px',
                borderBottom: `1px solid ${C.border}`,
                cursor: 'pointer',
                transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = C.dim}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ fontSize: 12, color: C.white, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.sessionId}
              </div>
              <div style={{ fontSize: 12, color: C.dimText }}>
                {formatTime(session.startTime)}
              </div>
              <div style={{ fontSize: 12, color: C.dimText, fontFamily: 'monospace' }}>
                {formatDuration(session.duration)}
              </div>
              <div style={{ fontSize: 12, color: C.white, fontFamily: 'monospace' }}>
                {session.eventCount}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        padding: '8px 0', fontSize: 11, color: C.dimText,
      }}>
        <span>{filtered.length} session{filtered.length !== 1 ? 's' : ''}</span>
        <span>{totals.events.toLocaleString()} total events</span>
      </div>
    </div>
  );
}
