/**
 * MetricsView.jsx
 * Aggregated metrics and analytics for agent workflows.
 */

import { useMemo } from 'react';
import { C, TYPE_COLORS } from './theme.js';

export function MetricsView({ events, permissions, metrics }) {
  const analytics = useMemo(() => {
    const eventsByType = {};
    const tokensByModel = {};
    const agentActivity = {};

    events.forEach(e => {
      // Count by type
      eventsByType[e.type] = (eventsByType[e.type] || 0) + 1;

      // Track tokens by model
      if (e.type === 'model_call') {
        const model = e.label || 'unknown';
        tokensByModel[model] = (tokensByModel[model] || 0) + (e.metadata?.tokens || 0);
      }

      // Track agent activity
      const agent = e.parentId || e.source || 'system';
      agentActivity[agent] = (agentActivity[agent] || 0) + 1;
    });

    const permissionRate = permissions.length > 0
      ? (permissions.filter(p => p.status === 'approved').length / permissions.length) * 100
      : 100;

    return {
      eventsByType,
      tokensByModel,
      agentActivity,
      permissionRate,
      totalEvents: events.length,
    };
  }, [events, permissions]);

  const topAgents = useMemo(() => {
    return Object.entries(analytics.agentActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
  }, [analytics.agentActivity]);

  const topModels = useMemo(() => {
    return Object.entries(analytics.tokensByModel)
      .sort((a, b) => b[1] - a[1]);
  }, [analytics.tokensByModel]);

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', background: C.bg, padding: 24 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>

        {/* Summary Cards */}
        <MetricCard
          title="Total Events"
          value={analytics.totalEvents}
          color={C.blue}
        />
        <MetricCard
          title="Total Tokens"
          value={metrics.tokens.toLocaleString()}
          subtitle={`$${metrics.cost.toFixed(4)}`}
          color={C.purple}
        />
        <MetricCard
          title="Agents Spawned"
          value={metrics.agents}
          color={C.teal}
        />
        <MetricCard
          title="Permission Rate"
          value={`${analytics.permissionRate.toFixed(0)}%`}
          subtitle={`${permissions.length} requests`}
          color={analytics.permissionRate === 100 ? C.green : C.yellow}
        />

        {/* Events by Type */}
        <div style={{ gridColumn: '1 / -1', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: C.white, marginBottom: 16 }}>Events by Type</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Object.entries(analytics.eventsByType)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 120, fontSize: 11, color: C.dimText, textTransform: 'capitalize' }}>
                    {type.replace('_', ' ')}
                  </div>
                  <div style={{ flex: 1, height: 24, background: C.dim, borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        height: '100%',
                        width: `${(count / analytics.totalEvents) * 100}%`,
                        background: TYPE_COLORS[type] || C.blue,
                        borderRadius: 3,
                        transition: 'width 0.3s ease',
                      }}
                    />
                    <div style={{ position: 'absolute', left: 8, top: 0, height: '100%', display: 'flex', alignItems: 'center', fontSize: 11, fontWeight: 600, color: C.white }}>
                      {count}
                    </div>
                  </div>
                  <div style={{ width: 50, fontSize: 11, color: C.dimText, textAlign: 'right' }}>
                    {((count / analytics.totalEvents) * 100).toFixed(1)}%
                  </div>
                </div>
              ))}
          </div>
        </div>

        {/* Token Usage by Model */}
        {topModels.length > 0 && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: C.white, marginBottom: 16 }}>Token Usage by Model</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {topModels.map(([model, tokens]) => (
                <div key={model}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: C.white }}>{model}</span>
                    <span style={{ fontSize: 11, color: C.dimText }}>{tokens.toLocaleString()}</span>
                  </div>
                  <div style={{ height: 6, background: C.dim, borderRadius: 3, overflow: 'hidden' }}>
                    <div
                      style={{
                        height: '100%',
                        width: `${(tokens / metrics.tokens) * 100}%`,
                        background: C.purple,
                        borderRadius: 3,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top Agents by Activity */}
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 20 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: C.white, marginBottom: 16 }}>Most Active Agents</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {topAgents.map(([agent, count], i) => (
              <div key={agent} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: C.dim, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: C.teal }}>
                  {i + 1}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: C.white, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent}</div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 600, color: C.teal }}>{count}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Permission Breakdown */}
        {permissions.length > 0 && (
          <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 20 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: C.white, marginBottom: 16 }}>Permissions</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <PermissionStat
                label="Approved"
                count={permissions.filter(p => p.status === 'approved').length}
                total={permissions.length}
                color={C.green}
              />
              <PermissionStat
                label="Denied"
                count={permissions.filter(p => p.status === 'denied').length}
                total={permissions.length}
                color={C.red}
              />
              <PermissionStat
                label="Pending"
                count={permissions.filter(p => p.status === 'pending').length}
                total={permissions.length}
                color={C.yellow}
              />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

function MetricCard({ title, value, subtitle, color }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: 20 }}>
      <div style={{ fontSize: 11, color: C.dimText, marginBottom: 8, fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, marginBottom: subtitle ? 4 : 0 }}>{value}</div>
      {subtitle && <div style={{ fontSize: 11, color: C.dimText }}>{subtitle}</div>}
    </div>
  );
}

function PermissionStat({ label, count, total, color }) {
  const percent = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C.white }}>{label}</span>
        <span style={{ fontSize: 11, color: C.dimText }}>{count} ({percent.toFixed(0)}%)</span>
      </div>
      <div style={{ height: 6, background: C.dim, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${percent}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}
