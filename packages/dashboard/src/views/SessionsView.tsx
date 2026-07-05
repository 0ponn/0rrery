import { useEffect, useState } from 'react'
import { fetchSessions } from '../api'
import { fmtTime, fmtDuration } from '../format'
import type { ApiSession } from '../types'

export function SessionsView() {
  const [sessions, setSessions] = useState<ApiSession[]>([])
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [project, setProject] = useState('')
  const [debouncedProject, setDebouncedProject] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedProject(project), 300)
    return () => clearTimeout(t)
  }, [project])

  useEffect(() => {
    let cancelled = false
    const params: { status?: string; q?: string; project?: string } = {}
    if (status) params.status = status
    if (debouncedQuery) params.q = debouncedQuery
    if (debouncedProject) params.project = debouncedProject
    fetchSessions(params)
      .then(s => { if (!cancelled) { setSessions(s); setError('') } })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [status, debouncedQuery, debouncedProject])

  if (error) return <p className="error">{error}</p>
  return (
    <section>
      <header className="viewhead">
        <h1>Sessions</h1>
        <div className="filters">
          <input type="search" placeholder="search sessions…" value={query} onChange={e => setQuery(e.target.value)} />
          <input type="text" placeholder="project" value={project} onChange={e => setProject(e.target.value)} />
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">all</option>
            <option value="active">active</option>
            <option value="stale">stale</option>
            <option value="ended">ended</option>
          </select>
        </div>
      </header>
      <table>
        <thead><tr><th>Session</th><th>Project</th><th>Source</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id}>
              <td><a href={`#/session/${encodeURIComponent(s.id)}`}>{s.id.slice(0, 8)}</a></td>
              <td>{s.project ?? '—'}</td>
              <td>{s.source}</td>
              <td><span className={`badge ${s.effectiveStatus}`}>{s.effectiveStatus}</span></td>
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
