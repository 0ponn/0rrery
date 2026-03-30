/**
 * SessionDetailView.jsx
 * Deep dive into a single session: Timeline, Events table, Export.
 */

import { useState, useEffect, useMemo } from 'react';
import { C, AGENT_COLORS } from './theme.js';
import { TimelineView } from './TimelineView.jsx';
import { EventTable } from './EventTable.jsx';
import { exportCSV, exportMarkdown } from './export.js';

function formatDuration(ms) {
  if (!ms || ms <= 0) return '--';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'events', label: 'Events' },
  { id: 'export', label: 'Export' },
];

export function SessionDetailView({ sessionId, apiUrl, events: allEvents, onBack }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('timeline');

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    fetch(`${apiUrl}/sessions/${sessionId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { setSession(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [sessionId, apiUrl]);

  const sessionEvents = useMemo(() => {
    if (session?.events) return session.events;
    return allEvents.filter(e => e.sessionId === sessionId);
  }, [session, allEvents, sessionId]);

  const metadata = useMemo(() => {
    if (!session && sessionEvents.length === 0) return null;
    const evts = sessionEvents;
    const tokens = evts.reduce((s, e) => s + (e.metadata?.tokens || 0), 0);
    const start = session?.metadata?.startTime || evts[0]?.timestamp;
    const end = session?.metadata?.lastEventTime || evts[evts.length - 1]?.timestamp;
    const duration = start && end ? end - start : 0;
    return { start, duration, eventCount: evts.length, tokens, cost: tokens * 0.000003 };
  }, [session, sessionEvents]);

  if (loading) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dimText, fontSize: 13 }}>
        Loading session...
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button
          onClick={onBack}
          style={{
            padding: '4px 10px', fontSize: 12, border: `1px solid ${C.border}`,
            borderRadius: 4, background: C.panel, color: C.white, cursor: 'pointer',
          }}
        >
          ← Back
        </button>
        <div style={{ fontSize: 14, fontWeight: 700, fontFamily: 'monospace', color: C.white }}>
          {sessionId}
        </div>
        {metadata && (
          <>
            <Pill label={`${metadata.eventCount} events`} />
            <Pill label={formatDuration(metadata.duration)} />
            <Pill label={`${metadata.tokens.toLocaleString()} tok`} />
          </>
        )}
      </div>

      {/* Tab bar + Sidebar layout */}
      <div style={{ flex: 1, display: 'flex', gap: 12, overflow: 'hidden' }}>
        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tabs */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 12 }}>
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 500,
                  border: 'none', borderRadius: 4, cursor: 'pointer',
                  background: activeTab === tab.id ? C.panel : 'transparent',
                  color: activeTab === tab.id ? C.white : C.dimText,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{
            flex: 1, overflow: 'auto', background: C.panel,
            border: `1px solid ${C.border}`, borderRadius: 6,
          }}>
            {activeTab === 'timeline' && (
              <TimelineView events={sessionEvents} nodes={[]} />
            )}
            {activeTab === 'events' && (
              <EventTable events={sessionEvents} />
            )}
            {activeTab === 'export' && (
              <div style={{ padding: 24 }}>
                <div style={{ fontSize: 13, color: C.white, marginBottom: 16 }}>
                  Export session data
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <ExportButton
                    label="Export CSV"
                    onClick={() => exportCSV({ sessionId, events: sessionEvents })}
                  />
                  <ExportButton
                    label="Export Markdown"
                    onClick={() => exportMarkdown({
                      sessionId, events: sessionEvents,
                      metadata: { duration: metadata?.duration },
                    })}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        {metadata && (
          <div style={{
            width: 200, flexShrink: 0, background: C.panel,
            border: `1px solid ${C.border}`, borderRadius: 6, padding: 16,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.dimText, marginBottom: 12 }}>
              Session Metadata
            </div>
            <SidebarField label="Start" value={metadata.start ? new Date(metadata.start).toLocaleTimeString('en-US', { hour12: false }) : '--'} />
            <SidebarField label="Duration" value={formatDuration(metadata.duration)} />
            <SidebarField label="Events" value={metadata.eventCount} />
            <SidebarField label="Tokens" value={metadata.tokens.toLocaleString()} />
            <SidebarField label="Est. Cost" value={`$${metadata.cost.toFixed(4)}`} />
          </div>
        )}
      </div>
    </div>
  );
}

function Pill({ label }) {
  return (
    <span style={{
      padding: '2px 8px', fontSize: 10, fontWeight: 500,
      background: C.dim, border: `1px solid ${C.border}`, borderRadius: 10,
      color: C.dimText, fontFamily: 'monospace',
    }}>
      {label}
    </span>
  );
}

function SidebarField({ label, value }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: C.dimText }}>{label}</div>
      <div style={{ fontSize: 12, color: C.white, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function ExportButton({ label, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '8px 16px', fontSize: 12, border: `1px solid ${C.border}`,
        borderRadius: 4, background: C.panel, color: C.white, cursor: 'pointer',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = C.dim}
      onMouseLeave={e => e.currentTarget.style.background = C.panel}
    >
      {label}
    </button>
  );
}
