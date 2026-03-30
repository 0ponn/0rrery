/**
 * OverviewView.jsx
 * PostHog-style dashboard overview: metric cards, active agents, recent activity.
 */

import { useMemo } from 'react';
import { C, AGENT_COLORS, EVTCOL, getAgentColor } from './theme.js';

const EVTICON = {
  agent_spawn: '\u25C8', model_call: '\u25C9', file_access: '\u25A3',
  mcp_call: '\u25C6', api_call: '\u2295', permission_request: '\u26A0',
  ipc_message: '\u25C7', handoff: '\u21C6', agent_done: '\u25CB',
  system: '\u2022', permission_resolve: '\u2713',
};

function formatUptime(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function OverviewView({ events, agents, stats, onSelectSession }) {
  const recentEvents = useMemo(() => {
    return events.slice(-20).reverse();
  }, [events]);

  const activeAgents = useMemo(() => {
    return agents.filter(a => a.status === 'active');
  }, [agents]);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 20 }}>
      {/* Metric cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <MetricCard label="Active Agents" value={stats.activeAgents} color={C.teal} />
        <MetricCard label="Total Events" value={stats.totalEvents.toLocaleString()} color={C.blue} />
        <MetricCard
          label="Token Usage"
          value={stats.totalTokens?.toLocaleString() || '0'}
          sub={`$${(stats.estimatedCost || 0).toFixed(4)}`}
          color={C.purple}
        />
        <MetricCard
          label="Events / min"
          value={stats.eventsPerMinute || 0}
          color={C.green}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Active Agents */}
        <Panel title={`Active Agents (${activeAgents.length})`}>
          {activeAgents.length === 0 ? (
            <Empty text="No active agents" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {agents.map(agent => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  onClickSession={() => agent.sessionId && onSelectSession(agent.sessionId)}
                />
              ))}
            </div>
          )}
        </Panel>

        {/* Recent Activity */}
        <Panel title="Recent Activity">
          {recentEvents.length === 0 ? (
            <Empty text="No events yet" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {recentEvents.map((evt, i) => (
                <div
                  key={`${evt.timestamp}-${i}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '4px 8px', borderRadius: 3, fontSize: 11,
                  }}
                >
                  <span style={{ color: C.dimText, fontFamily: 'monospace', flexShrink: 0 }}>
                    {formatTime(evt.timestamp)}
                  </span>
                  <span style={{ color: EVTCOL[evt.type] || C.dimText, flexShrink: 0, width: 14, textAlign: 'center' }}>
                    {EVTICON[evt.type] || '\u2022'}
                  </span>
                  <span style={{ color: C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {evt.label || evt.type}
                  </span>
                  {evt.metadata?.tokens && (
                    <span style={{ color: C.dimText, marginLeft: 'auto', fontFamily: 'monospace', flexShrink: 0 }}>
                      {evt.metadata.tokens.toLocaleString()} tok
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function MetricCard({ label, value, sub, color }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 16,
    }}>
      <div style={{ fontSize: 11, color: C.dimText, marginBottom: 6, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: 'monospace' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.dimText, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6,
      padding: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column',
      maxHeight: 400,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: C.white, marginBottom: 12 }}>{title}</div>
      <div style={{ overflow: 'auto', flex: 1 }}>{children}</div>
    </div>
  );
}

function AgentRow({ agent, onClickSession }) {
  const now = Date.now();
  const agentType = agent.agentType || 'unknown';
  const color = getAgentColor(agentType);
  const isActive = agent.status === 'active';

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 8px', borderRadius: 4, cursor: 'pointer',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = C.dim}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      onClick={onClickSession}
    >
      {/* Color dot */}
      <div style={{
        width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
      }} />
      {/* Agent name + PID */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {agent.label || agent.id}
        </div>
        {agent.pid && (
          <div style={{ fontSize: 10, color: C.dimText, fontFamily: 'monospace' }}>PID {agent.pid}</div>
        )}
      </div>
      {/* Status badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: '50%',
          background: isActive ? C.green : C.dimText,
        }} />
        <span style={{ fontSize: 10, color: isActive ? C.green : C.dimText }}>
          {agent.status}
        </span>
      </div>
      {/* Uptime */}
      <span style={{ fontSize: 10, color: C.dimText, fontFamily: 'monospace', flexShrink: 0, width: 48, textAlign: 'right' }}>
        {formatUptime(now - agent.firstSeen)}
      </span>
    </div>
  );
}

function Empty({ text }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: C.dimText, fontSize: 12 }}>
      {text}
    </div>
  );
}
