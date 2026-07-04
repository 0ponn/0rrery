import type { Database } from 'bun:sqlite'
import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'

export type SessionFilter = { project?: string; status?: 'active' | 'ended'; limit?: number; offset?: number }

export function listSessions(db: Database, f: SessionFilter = {}): SessionRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.project) { where.push('project = ?'); params.push(f.project) }
  if (f.status) { where.push('status = ?'); params.push(f.status) }
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

export function getStats(db: Database) {
  const one = (sql: string) => (db.query(sql).get() as { c: number }).c
  return {
    sessions: one('SELECT COUNT(*) c FROM sessions'),
    activeSessions: one("SELECT COUNT(*) c FROM sessions WHERE status = 'active'"),
    spans: one('SELECT COUNT(*) c FROM spans'),
    events: one('SELECT COUNT(*) c FROM events'),
  }
}
