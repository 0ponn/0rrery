import type { Database } from 'bun:sqlite'
import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'

export type QueryOpts = { now: number; staleAfterMs: number }
export type SessionFilter = { project?: string; status?: 'active' | 'ended' | 'stale'; limit?: number; offset?: number }

export function listSessions(db: Database, f: SessionFilter = {}, opts: QueryOpts): SessionRow[] {
  const cutoff = opts.now - opts.staleAfterMs
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.project) { where.push('project = ?'); params.push(f.project) }
  if (f.status === 'active') { where.push("status = 'active' AND last_event_at >= ?"); params.push(cutoff) }
  else if (f.status === 'stale') { where.push("status = 'active' AND last_event_at < ?"); params.push(cutoff) }
  else if (f.status === 'ended') { where.push("status = 'ended'") }
  else if (f.status) { where.push('0 = 1') }  // unknown status value: match nothing, never fail open
  const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY last_event_at DESC LIMIT ? OFFSET ?`
  params.push(f.limit ?? 50, f.offset ?? 0)
  return db.query(sql).all(...params) as SessionRow[]
}

export type SessionDetail = { session: SessionRow; spans: SpanRow[]; events: EventRow[] }

export function getSessionDetail(db: Database, id: string): SessionDetail | null {
  const session = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | null
  if (!session) return null
  const spans = db.query('SELECT * FROM spans WHERE session_id = ? ORDER BY started_at, id').all(id) as SpanRow[]
  const events = db.query('SELECT * FROM events WHERE session_id = ? ORDER BY ts, id').all(id) as EventRow[]
  return { session, spans, events }
}

export function getStats(db: Database, opts: QueryOpts) {
  const cutoff = opts.now - opts.staleAfterMs
  const one = (sql: string, ...p: (string | number)[]) => (db.query(sql).get(...p) as { c: number }).c
  return {
    sessions: one('SELECT COUNT(*) c FROM sessions'),
    activeSessions: one("SELECT COUNT(*) c FROM sessions WHERE status = 'active' AND last_event_at >= ?", cutoff),
    staleSessions: one("SELECT COUNT(*) c FROM sessions WHERE status = 'active' AND last_event_at < ?", cutoff),
    spans: one('SELECT COUNT(*) c FROM spans'),
    events: one('SELECT COUNT(*) c FROM events'),
  }
}
