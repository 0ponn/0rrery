import { useEffect, useRef, useState } from 'react'
import { fetchSessions, liveSocket } from '../api'
import { fmtTime } from '../format'
import type { SessionRow } from '../types'

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

export function LiveView() {
  const [active, setActive] = useState<SessionRow[]>([])
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    let cancelled = false

    const refresh = () => fetchSessions({ status: 'active' }).then(sessions => {
      if (!cancelled) setActive(sessions)
    }).catch(() => {})
    refresh()
    const ws = liveSocket('*', ops => {
      if (pausedRef.current) return
      const items = ops.map(opToFeedItem).filter(Boolean) as FeedItem[]
      setFeed(prev => [...items.reverse(), ...prev].slice(0, 500))
      if (ops.some((o: any) => o.op === 'session.start' || o.op === 'session.end')) refresh()
    })
    return () => {
      cancelled = true
      ws.close()
    }
  }, [])

  return (
    <section>
      <header className="viewhead">
        <h1>Live</h1>
        <button className="pause" onClick={() => setPaused(!paused)}>{paused ? 'resume' : 'pause'}</button>
      </header>
      <h2 className="subhead">Active sessions ({active.length})</h2>
      <div className="chips">
        {active.map(s => <a key={s.id} className="chip" href={`#/session/${encodeURIComponent(s.id)}`}>{s.project ?? s.id.slice(0, 8)}</a>)}
        {active.length === 0 && <span className="empty">none</span>}
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
