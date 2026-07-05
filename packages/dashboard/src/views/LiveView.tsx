import { useEffect, useRef, useState } from 'react'
import { fetchFleet, liveSocket } from '../api'
import { fmtTime, fmtDuration, fmtTokens, fmtCost } from '../format'
import type { FleetCard } from '../types'

type FeedItem = { key: string; ts: number; sessionId: string; label: string }

function opToFeedItem(op: any, i: number): FeedItem | null {
  const base = { key: `${op.id ?? op.sessionId}:${i}:${op.ts}`, ts: op.ts, sessionId: op.sessionId ?? '' }
  switch (op.op) {
    case 'session.start': return { ...base, label: `session started (${op.project ?? op.sessionId})` }
    case 'session.end': return { ...base, label: 'session ended' }
    case 'span.start': return { ...base, label: `▶ ${op.kind}: ${op.name}` }
    case 'span.end': return { ...base, sessionId: '', label: `■ span ${op.status}` }
    case 'event': return { ...base, label: op.type }
    default: return null
  }
}

function Card({ c, extra }: { c: FleetCard; extra: number }) {
  const idle = c.idle_ms + extra
  return (
    <a className={`fleet-card${c.stuck ? ' stuck' : ''}`} href={`#/session/${encodeURIComponent(c.id)}`}>
      <header>
        <strong>{c.project ?? c.id.slice(0, 8)}</strong>
        <span className={`badge ${c.stuck ? 'stuck' : c.effective}`}>{c.stuck ? 'stuck' : c.effective}</span>
      </header>
      <div className="fleet-now">
        {c.current
          ? <>▶ {c.current.name} · {fmtDuration(c.current.running_ms + extra)}</>
          : <>idle {fmtDuration(idle)}</>}
      </div>
      {c.pending_permissions.map((p, i) => (
        <div key={i} className="perm-banner">⏳ {p.tool} awaiting approval {fmtDuration(p.waiting_ms + extra)}</div>
      ))}
      <footer className="fleet-foot">
        {fmtTokens(c.tokens_in)} in / {fmtTokens(c.tokens_out)} out
        {c.est_cost !== null && <> · {fmtCost(c.est_cost)} est.</>}
      </footer>
    </a>
  )
}

export function LiveView() {
  const [fleet, setFleet] = useState<FleetCard[] | null>(null)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [paused, setPaused] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const [, tick] = useState(0)
  const fetchedAt = useRef(Date.now())
  const lastFetch = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      const now = Date.now()
      if (now - lastFetch.current < 1000) return
      lastFetch.current = now
      fetchFleet().then(cards => {
        if (cancelled) return
        setFleet(cards)
        fetchedAt.current = Date.now()
        setDisconnected(false)
      }).catch(() => { if (!cancelled) setDisconnected(true) })
    }
    refresh()
    const poll = setInterval(refresh, 5000)
    const timers = setInterval(() => tick(t => t + 1), 1000)
    const onOps = (ops: unknown[]) => {
      refresh()
      if (pausedRef.current) return
      const items = ops.map(opToFeedItem).filter(Boolean) as FeedItem[]
      setFeed(prev => [...items.reverse(), ...prev].slice(0, 500))
    }
    let ws: WebSocket
    let reconnect: ReturnType<typeof setTimeout> | null = null
    const connect = () => {
      ws = liveSocket('*', onOps)
      // The 5s fleet poll already covers data; this just keeps the live feed flowing again.
      ws.onclose = () => { if (!cancelled) reconnect = setTimeout(connect, 5000) }
    }
    connect()
    return () => {
      cancelled = true
      clearInterval(poll); clearInterval(timers)
      if (reconnect) clearTimeout(reconnect)
      ws.onclose = null
      ws.close()
    }
  }, [])

  const extra = Date.now() - fetchedAt.current

  return (
    <section>
      <header className="viewhead">
        <h1>Live</h1>
        {disconnected && <span className="empty">disconnected — retrying</span>}
        <button className="pause" onClick={() => setPaused(!paused)}>{paused ? 'resume' : 'pause'}</button>
      </header>
      <div className="fleet-grid">
        {(fleet ?? []).map(c => <Card key={c.id} c={c} extra={extra} />)}
        {fleet !== null && fleet.length === 0 && <p className="empty">no live sessions</p>}
      </div>
      <h2 className="subhead">Feed</h2>
      <div className="feed">
        {feed.map(f => (
          <div key={f.key} className="feed-row">
            <span className="feed-ts">{fmtTime(f.ts)}</span>
            <span className="feed-sid">{f.sessionId.slice(0, 8)}</span>
            <span>{f.label}</span>
          </div>
        ))}
        {feed.length === 0 && <p className="empty">Waiting for events…</p>}
      </div>
    </section>
  )
}
