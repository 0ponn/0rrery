import { useEffect, useMemo, useState } from 'react'
import { fetchSession, liveSocket } from '../api'
import { buildSpanTree, tokenRollup, type SpanNode } from '../tree'
import { fmtDuration, fmtTime, fmtTokens } from '../format'
import { permissionStatus, eventDetail, type PermStatus } from '../perms'
import { TopologyTab } from './TopologyTab'
import type { SessionDetail, EventRow } from '../types'

function prettyAttrs(attrs: string): string {
  try { return JSON.stringify(JSON.parse(attrs), null, 2) } catch { return attrs }
}

function WaterfallRow({ node, t0, total, perms }: { node: SpanNode; t0: number; total: number; perms: Map<string, PermStatus> }) {
  const [open, setOpen] = useState(false)
  const s = node.span
  const end = s.ended_at ?? t0 + total
  const left = total ? ((s.started_at - t0) / total) * 100 : 0
  const width = total ? Math.max(0.5, ((end - s.started_at) / total) * 100) : 100
  return (
    <>
      <div className="wf-row" onClick={() => setOpen(!open)}>
        <span className="wf-name" style={{ paddingLeft: node.depth * 16 }}>
          <span className={`kind kind-${s.kind}`}>{s.kind}</span> {s.name}
          {perms.has(s.id) && <span className={`perm-badge ${perms.get(s.id)}`}>{perms.get(s.id)}</span>}
        </span>
        <span className="wf-track">
          <span className={`wf-bar st-${s.status}`} style={{ left: `${left}%`, width: `${width}%` }} />
        </span>
        <span className="wf-dur">{s.ended_at ? fmtDuration(s.ended_at - s.started_at) : 'running'}</span>
      </div>
      {open && <pre className="attrs">{prettyAttrs(s.attrs)}</pre>}
      {node.children.map(c => <WaterfallRow key={c.span.id} node={c} t0={t0} total={total} perms={perms} />)}
    </>
  )
}

export function SessionDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'trace' | 'events' | 'topology'>('trace')

  useEffect(() => {
    let ws: WebSocket | null = null
    let cancelled = false
    let recheck: ReturnType<typeof setTimeout> | null = null
    const load = () => fetchSession(id).then(d => {
      if (cancelled) return
      setError('')
      setDetail(d)
      if (d.session.effectiveStatus === 'active' && !ws) ws = liveSocket(id, () => load())
      else if (d.session.effectiveStatus === 'stale' && !ws) recheck = setTimeout(load, 30_000)
    }).catch(e => {
      if (cancelled) return
      setError(String(e))
    })
    load()
    return () => {
      cancelled = true
      ws?.close()
      if (recheck) clearTimeout(recheck)
    }
  }, [id])

  const tree = useMemo(() => detail ? buildSpanTree(detail.spans) : [], [detail])
  const perms = useMemo(() => detail ? permissionStatus(detail.events, detail.spans) : new Map<string, PermStatus>(), [detail])
  if (error) return <p className="error">{error}</p>
  if (!detail) return <p className="empty">loading…</p>

  const { session, spans, events } = detail
  const t0 = session.started_at
  const total = Math.max(1, session.last_event_at - t0)
  const tokens = tokenRollup(spans)

  return (
    <section>
      <header className="viewhead">
        <h1><a href="#/">Sessions</a> / {session.id.slice(0, 8)}</h1>
        <div className="rollup">
          <span className={`badge ${session.effectiveStatus}`}>{session.effectiveStatus}</span>
          <span>{session.project ?? ''}</span>
          <span>{fmtDuration(total)}</span>
          <span>{fmtTokens(tokens.input)} in / {fmtTokens(tokens.output)} out</span>
        </div>
      </header>
      <div className="tabs">
        <button className={tab === 'trace' ? 'active' : ''} onClick={() => setTab('trace')}>Trace ({spans.length})</button>
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events ({events.length})</button>
        <button className={tab === 'topology' ? 'active' : ''} onClick={() => setTab('topology')}>Topology</button>
      </div>
      {tab === 'trace' && (
        <div className="waterfall">
          {tree.map(n => <WaterfallRow key={n.span.id} node={n} t0={t0} total={total} perms={perms} />)}
          {tree.length === 0 && <p className="empty">No spans recorded.</p>}
        </div>
      )}
      {tab === 'events' && (
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Detail</th></tr></thead>
          <tbody>
            {events.map((e: EventRow) => (
              <tr key={e.id}>
                <td>{fmtTime(e.ts)}</td>
                <td>{e.type}</td>
                <td className="attrs-cell">{eventDetail(e.attrs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'topology' && <TopologyTab spans={spans} />}
    </section>
  )
}
