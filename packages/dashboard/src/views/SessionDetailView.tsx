import { useEffect, useMemo, useState } from 'react'
import { fetchSession, liveSocket } from '../api'
import { buildSpanTree, tokenRollup, type SpanNode } from '../tree'
import { fmtDuration, fmtTime, fmtTokens } from '../format'
import type { SessionDetail, EventRow } from '../types'

function WaterfallRow({ node, t0, total }: { node: SpanNode; t0: number; total: number }) {
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
        </span>
        <span className="wf-track">
          <span className={`wf-bar st-${s.status}`} style={{ left: `${left}%`, width: `${width}%` }} />
        </span>
        <span className="wf-dur">{s.ended_at ? fmtDuration(s.ended_at - s.started_at) : 'running'}</span>
      </div>
      {open && <pre className="attrs">{JSON.stringify(JSON.parse(s.attrs), null, 2)}</pre>}
      {node.children.map(c => <WaterfallRow key={c.span.id} node={c} t0={t0} total={total} />)}
    </>
  )
}

export function SessionDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'trace' | 'events'>('trace')

  useEffect(() => {
    let ws: WebSocket | null = null
    let cancelled = false
    const load = () => fetchSession(id).then(d => {
      if (cancelled) return
      setError('')
      setDetail(d)
      if (d.session.status === 'active' && !ws) ws = liveSocket(id, () => load())
    }).catch(e => {
      if (cancelled) return
      setError(String(e))
    })
    load()
    return () => {
      cancelled = true
      ws?.close()
    }
  }, [id])

  const tree = useMemo(() => detail ? buildSpanTree(detail.spans) : [], [detail])
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
          <span className={`badge ${session.status}`}>{session.status}</span>
          <span>{session.project ?? ''}</span>
          <span>{fmtDuration(total)}</span>
          <span>{fmtTokens(tokens.input)} in / {fmtTokens(tokens.output)} out</span>
        </div>
      </header>
      <div className="tabs">
        <button className={tab === 'trace' ? 'active' : ''} onClick={() => setTab('trace')}>Trace ({spans.length})</button>
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events ({events.length})</button>
      </div>
      {tab === 'trace' && (
        <div className="waterfall">
          {tree.map(n => <WaterfallRow key={n.span.id} node={n} t0={t0} total={total} />)}
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
                <td className="attrs-cell">{(() => { try { return JSON.parse(e.attrs).preview ?? JSON.parse(e.attrs).message ?? '' } catch { return '' } })()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
