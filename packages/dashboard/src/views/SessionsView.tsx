import { useEffect, useState } from 'react'
import { fetchSessions } from '../api'
import { fmtTime, fmtDuration } from '../format'
import type { SessionRow } from '../types'

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSessions(status ? { status } : {}).then(setSessions).catch(e => setError(String(e)))
  }, [status])

  if (error) return <p className="error">{error}</p>
  return (
    <section>
      <header className="viewhead">
        <h1>Sessions</h1>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">all</option>
          <option value="active">active</option>
          <option value="ended">ended</option>
        </select>
      </header>
      <table>
        <thead><tr><th>Session</th><th>Project</th><th>Source</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id}>
              <td><a href={`#/session/${encodeURIComponent(s.id)}`}>{s.id.slice(0, 8)}</a></td>
              <td>{s.project ?? '—'}</td>
              <td>{s.source}</td>
              <td><span className={`badge ${s.status}`}>{s.status}</span></td>
              <td>{fmtTime(s.started_at)}</td>
              <td>{fmtDuration(s.last_event_at - s.started_at)}</td>
            </tr>
          ))}
          {sessions.length === 0 && <tr><td colSpan={6} className="empty">No sessions yet. Run `0rrery install`, then use Claude Code.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
