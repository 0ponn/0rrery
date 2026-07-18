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

/**
 * Full session detail. HAZARD: the session window
 * (`started_at`..`last_event_at`, and `wall_ms` in projectRollups) is
 * idle-inflated — a left-open span terminal stretches it across days
 * (0PO-517: 6/18 sampled sessions exceeded 24h, max 526h). Never use the
 * window for time attribution; call `sessionIntervals()` / GET
 * `/api/sessions/<id>/intervals` for the honest active-work boundary.
 */
export function getSessionDetail(db: Database, id: string): SessionDetail | null {
  const session = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | null
  if (!session) return null
  const spans = db.query('SELECT * FROM spans WHERE session_id = ? ORDER BY started_at, id').all(id) as SpanRow[]
  const events = db.query('SELECT * FROM events WHERE session_id = ? ORDER BY ts, id').all(id) as EventRow[]
  return { session, spans, events }
}

export type WorkInterval = { start: number; end: number; spanCount: number }

/**
 * Working intervals for a session: span timestamps segmented at silences of
 * `gapMs` or longer. A session's window (started_at..last_event_at) is
 * idle-inflated — a left-open terminal stretches it across days — so it must
 * never be used for time attribution (0PO-517). These intervals are the honest
 * boundary of active work; the same segmentation every consumer would otherwise
 * re-derive from the raw spans.
 */
export function sessionIntervals(db: Database, id: string, gapMs: number): WorkInterval[] {
  const spans = db
    .query('SELECT started_at, ended_at FROM spans WHERE session_id = ? ORDER BY started_at, id')
    .all(id) as { started_at: number; ended_at: number | null }[]
  const times: number[] = []
  for (const s of spans) {
    if (s.started_at != null) times.push(s.started_at)
    if (s.ended_at != null) times.push(s.ended_at)
  }
  times.sort((a, b) => a - b)
  const intervals: WorkInterval[] = []
  for (const t of times) {
    const last = intervals[intervals.length - 1]
    if (last && t - last.end <= gapMs) last.end = t
    else intervals.push({ start: t, end: t, spanCount: 0 })
  }
  for (const s of spans) {
    if (s.started_at == null) continue
    const iv = intervals.find(v => s.started_at >= v.start && s.started_at <= v.end)
    if (iv) iv.spanCount++
  }
  return intervals
}

export function sessionExists(db: Database, id: string): boolean {
  return db.query('SELECT 1 FROM sessions WHERE id = ?').get(id) != null
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
