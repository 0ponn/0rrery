/**
 * AgentTopologyDashboard.jsx
 * PostHog-style observability platform for Orrery agent topology.
 * View router + WebSocket connection + REST polling.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTopologySocket } from './useTopologySocket.js';
import { OverviewView } from './OverviewView.jsx';
import { SessionListView } from './SessionListView.jsx';
import { SessionDetailView } from './SessionDetailView.jsx';
import { LiveFeedView } from './LiveFeedView.jsx';
import { TopologyView } from './TopologyView.jsx';
import { C, STATUS_COLOR, AGENT_COLORS } from './theme.js';

const WS_URL = 'ws://localhost:4242';
const API_URL = 'http://localhost:4243';
const POLL_INTERVAL = 10_000;

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'topology', label: 'Topology' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'live-feed', label: 'Live Feed' },
];

export function OrreryDashboard() {
  const [currentView, setCurrentView] = useState('overview');
  const [selectedSessionId, setSelectedSessionId] = useState(null);

  // Data from WebSocket
  const [events, setEvents] = useState([]);
  const eventsRef = useRef([]);

  // Data from REST polling
  const [sessions, setSessions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [stats, setStats] = useState({
    activeAgents: 0, totalEvents: 0, totalTokens: 0,
    estimatedCost: 0, eventsPerMinute: 0, totalSessions: 0, agentsByType: {},
  });

  // Process incoming WebSocket events
  const handleEventBatch = useCallback((batch) => {
    const incoming = batch.filter(e => e.type !== 'session_list' && e.type !== 'agents_list');
    if (incoming.length === 0) return;

    // Stamp timestamps
    const now = Date.now();
    const stamped = incoming.map(e => ({
      ...e,
      timestamp: e.timestamp || now,
    }));

    eventsRef.current = [...eventsRef.current, ...stamped].slice(-2000);
    setEvents([...eventsRef.current]);
  }, []);

  const { status } = useTopologySocket(WS_URL, handleEventBatch);

  // REST polling
  useEffect(() => {
    const fetchAll = () => {
      fetch(`${API_URL}/sessions`).then(r => r.json()).then(setSessions).catch(() => {});
      fetch(`${API_URL}/agents`).then(r => r.json()).then(setAgents).catch(() => {});
      fetch(`${API_URL}/stats`).then(r => r.json()).then(setStats).catch(() => {});
    };
    fetchAll();
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  // Navigation helpers
  const navigateToSession = useCallback((sessionId) => {
    setSelectedSessionId(sessionId);
    setCurrentView('session-detail');
  }, []);

  const navigateBack = useCallback(() => {
    setSelectedSessionId(null);
    setCurrentView('sessions');
  }, []);

  // Render current view
  const renderView = () => {
    switch (currentView) {
      case 'overview':
        return (
          <OverviewView
            events={events}
            agents={agents}
            stats={stats}
            onSelectSession={navigateToSession}
          />
        );
      case 'topology':
        return <TopologyView agents={agents} events={events} sessions={sessions} />;
      case 'sessions':
        return (
          <SessionListView
            sessions={sessions}
            onSelectSession={navigateToSession}
          />
        );
      case 'session-detail':
        return (
          <SessionDetailView
            sessionId={selectedSessionId}
            apiUrl={API_URL}
            events={events}
            onBack={navigateBack}
          />
        );
      case 'live-feed':
        return <LiveFeedView events={events} />;
      default:
        return null;
    }
  };

  return (
    <div style={{
      width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column',
      background: C.bg, color: C.white, fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* Navbar */}
      <nav style={{
        display: 'flex', alignItems: 'center', height: 48,
        background: C.panel, borderBottom: `1px solid ${C.border}`,
        padding: '0 16px', flexShrink: 0,
      }}>
        <div style={{
          fontSize: 14, fontWeight: 700, color: C.white, marginRight: 32,
          letterSpacing: '-0.02em',
        }}>
          Orrery
        </div>

        <div style={{ display: 'flex', gap: 2 }}>
          {VIEWS.map(v => (
            <button
              key={v.id}
              onClick={() => { setCurrentView(v.id); setSelectedSessionId(null); }}
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 500,
                border: 'none', borderRadius: 4, cursor: 'pointer',
                background: currentView === v.id ? C.bg : 'transparent',
                color: currentView === v.id ? C.white : C.dimText,
                transition: 'all 0.15s',
              }}
            >
              {v.label}
            </button>
          ))}
          {currentView === 'session-detail' && (
            <button
              style={{
                padding: '6px 14px', fontSize: 12, fontWeight: 500,
                border: 'none', borderRadius: 4, cursor: 'default',
                background: C.bg, color: C.white,
              }}
            >
              Session Detail
            </button>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Connection status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: STATUS_COLOR[status] || C.dimText,
          }} />
          <span style={{ color: C.dimText, textTransform: 'capitalize' }}>{status}</span>
        </div>
      </nav>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {renderView()}
      </div>
    </div>
  );
}
