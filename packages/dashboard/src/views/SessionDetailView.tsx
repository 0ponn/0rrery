import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchSession, liveSocket } from '../api'
import { buildSpanTree, flattenTree, tokenRollup, type SpanNode } from '../tree'
import { fmtDuration, fmtTime, fmtTokens } from '../format'
import { permissionStatus, eventDetail, type PermStatus } from '../perms'
import { displayKind } from '@0rrery/schema/src/names'
import { ROW_H, useVirtualRows } from '../virtual'
import { TopologyTab } from './TopologyTab'
import { SpanPanel } from './SpanPanel'
import type { SessionDetail, EventRow, SpanRow } from '../types'

function WaterfallRow({ node, t0, total, perms, selected, onSelect }: {
  node: SpanNode; t0: number; total: number; perms: Map<string, PermStatus>
  selected: boolean; onSelect: (id: string) => void
}) {
  const s = node.span
  const end = s.ended_at ?? t0 + total
  const left = total ? ((s.started_at - t0) / total) * 100 : 0
  const width = total ? Math.max(0.5, ((end - s.started_at) / total) * 100) : 100
  return (
    <div className={`wf-row${selected ? ' selected' : ''}`} style={{ height: ROW_H }} onClick={() => onSelect(s.id)}>
      <span className="wf-name" style={{ paddingLeft: node.depth * 16 }}>
        <span className={`kind kind-${displayKind(s.kind, s.name)}`}>{displayKind(s.kind, s.name)}</span> {s.name}
        {perms.has(s.id) && <span className={`perm-badge ${perms.get(s.id)}`}>{perms.get(s.id)}</span>}
      </span>
      <span className="wf-track">
        <span className={`wf-bar st-${s.status}`} style={{ left: `${left}%`, width: `${width}%` }} />
      </span>
      <span className="wf-dur">{s.ended_at ? fmtDuration(s.ended_at - s.started_at) : 'running'}</span>
    </div>
  )
}

function EventsList({ events }: { events: EventRow[] }) {
  const v = useVirtualRows(events.length)
  return (
    <div className="feed vlist" ref={v.ref} onScroll={v.onScroll}>
      <div style={{ height: v.padTop }} />
      {events.slice(v.start, v.end).map(e => (
        <div key={e.id} className="feed-row" style={{ height: ROW_H }}>
          <span className="feed-ts">{fmtTime(e.ts)}</span>
          <span className="feed-sid">{e.type}</span>
          <span className="ev-detail">{eventDetail(e.attrs)}</span>
        </div>
      ))}
      <div style={{ height: v.padBottom }} />
      {events.length === 0 && <p className="empty">No events.</p>}
    </div>
  )
}

export function SessionDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'trace' | 'events' | 'topology'>('trace')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const lastFetch = useRef(0)
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let cancelled = false
    let recheck: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      const now = Date.now()
      if (now - lastFetch.current < 2000) {
        if (!trailing.current) trailing.current = setTimeout(() => { trailing.current = null; load() }, 2000 - (now - lastFetch.current))
        return
      }
      lastFetch.current = now
      fetchSession(id).then(d => {
        if (cancelled) return
        setError('')
        setDetail(d)
        if (d.session.effectiveStatus === 'active' && !ws) ws = liveSocket(id, () => load())
        else if (d.session.effectiveStatus === 'stale' && !ws) recheck = setTimeout(load, 30_000)
      }).catch(e => {
        if (cancelled) return
        setError(String(e))
      })
    }
    load()
    return () => {
      cancelled = true
      ws?.close()
      if (recheck) clearTimeout(recheck)
      if (trailing.current) { clearTimeout(trailing.current); trailing.current = null }
    }
  }, [id])

  const tree = useMemo(() => detail ? buildSpanTree(detail.spans) : [], [detail])
  const flat = useMemo(() => flattenTree(tree), [tree])
  const perms = useMemo(() => detail ? permissionStatus(detail.events, detail.spans) : new Map<string, PermStatus>(), [detail])
  const v = useVirtualRows(flat.length)

  if (error) return <p className="error">{error}</p>
  if (!detail) return <p className="empty">loading…</p>

  const { session, spans, events } = detail
  const t0 = session.started_at
  const total = Math.max(1, session.last_event_at - t0)
  const tokens = tokenRollup(spans)
  const selected: SpanRow | null = selectedId ? spans.find(s => s.id === selectedId) ?? null : null
  const parent: SpanRow | null = selected?.parent_id ? spans.find(s => s.id === selected.parent_id) ?? null : null

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
        <div className="trace-split">
          <div className="waterfall vlist" ref={v.ref} onScroll={v.onScroll}>
            <div style={{ height: v.padTop }} />
            {flat.slice(v.start, v.end).map(n => (
              <WaterfallRow key={n.span.id} node={n} t0={t0} total={total} perms={perms}
                selected={n.span.id === selectedId} onSelect={setSelectedId} />
            ))}
            <div style={{ height: v.padBottom }} />
            {flat.length === 0 && <p className="empty">No spans recorded.</p>}
          </div>
          {selected && (
            <SpanPanel span={selected} events={events.filter(e => e.span_id === selected.id)}
              parent={parent} onClose={() => setSelectedId(null)} onSelectParent={setSelectedId} />
          )}
        </div>
      )}
      {tab === 'events' && <EventsList events={events} />}
      {tab === 'topology' && <TopologyTab spans={spans} />}
    </section>
  )
}
