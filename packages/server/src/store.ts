import { Database } from 'bun:sqlite'
import type { IngestOp } from '@0rrery/schema'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT, cwd TEXT, git_branch TEXT,
  started_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT,
  kind TEXT NOT NULL, name TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running', attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, span_id TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_event_at);
`

export class Store {
  db: Database
  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  applyOps(ops: IngestOp[]): void {
    const tx = this.db.transaction((batch: IngestOp[]) => {
      for (const op of batch) this.applyOne(op)
    })
    tx(ops)
  }

  private touchSession(sessionId: string, ts: number) {
    if (!sessionId) return
    this.db.run(
      `INSERT INTO sessions (id, source, started_at, last_event_at) VALUES (?, 'api', ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_event_at = MAX(last_event_at, excluded.last_event_at)`,
      [sessionId, ts, ts],
    )
  }

  private applyOne(op: IngestOp) {
    switch (op.op) {
      case 'session.start':
        this.db.run(
          `INSERT INTO sessions (id, source, project, cwd, git_branch, started_at, last_event_at, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source = excluded.source, project = COALESCE(excluded.project, project),
             cwd = COALESCE(excluded.cwd, cwd), git_branch = COALESCE(excluded.git_branch, git_branch),
             started_at = MIN(started_at, excluded.started_at),
             last_event_at = MAX(last_event_at, excluded.last_event_at),
             status = CASE WHEN excluded.last_event_at >= last_event_at THEN 'active' ELSE status END`,
          [op.sessionId, op.source, op.project ?? null, op.cwd ?? null, op.gitBranch ?? null, op.ts, op.ts, JSON.stringify(op.meta ?? {})],
        )
        break
      case 'session.end':
        this.touchSession(op.sessionId, op.ts)
        this.db.run(`UPDATE sessions SET status = 'ended', last_event_at = MAX(last_event_at, ?) WHERE id = ?`, [op.ts, op.sessionId])
        break
      case 'span.start': {
        this.touchSession(op.sessionId, op.ts)
        const existing = this.db.query('SELECT session_id, parent_id, started_at, attrs FROM spans WHERE id = ?').get(op.id) as
          { session_id: string; parent_id: string | null; started_at: number; attrs: string } | null
        if (!existing) {
          this.db.run(
            `INSERT INTO spans (id, session_id, parent_id, kind, name, started_at, attrs)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [op.id, op.sessionId, op.parentId ?? null, op.kind, op.name, op.ts, JSON.stringify(op.attrs ?? {})],
          )
        } else {
          // hook-then-transcript upgrade: a live span.start may be re-written later with a
          // richer parentId/attrs for the same id. Merge rather than drop the second write.
          const sessionId = existing.session_id === '' ? op.sessionId : existing.session_id
          const parentId = existing.parent_id ?? (op.parentId ?? null)
          const startedAt = Math.min(existing.started_at, op.ts)
          const merged = { ...JSON.parse(existing.attrs), ...(op.attrs ?? {}) }
          this.db.run(
            `UPDATE spans SET session_id = ?, parent_id = ?, started_at = ?, attrs = ? WHERE id = ?`,
            [sessionId, parentId, startedAt, JSON.stringify(merged), op.id],
          )
        }
        break
      }
      case 'span.end': {
        const existing = this.db.query('SELECT attrs, session_id FROM spans WHERE id = ?').get(op.id) as { attrs: string; session_id: string } | null
        if (existing) {
          const merged = { ...JSON.parse(existing.attrs), ...(op.attrs ?? {}) }
          this.db.run(`UPDATE spans SET ended_at = ?, status = ?, attrs = ? WHERE id = ?`, [op.ts, op.status, JSON.stringify(merged), op.id])
          this.touchSession(existing.session_id, op.ts)
        } else {
          // end arrived before start: orphan-tolerant placeholder under unknown session
          this.db.run(
            `INSERT OR IGNORE INTO spans (id, session_id, parent_id, kind, name, started_at, ended_at, status, attrs)
             VALUES (?, '', NULL, 'custom', '(unknown)', ?, ?, ?, ?)`,
            [op.id, op.ts, op.ts, op.status, JSON.stringify(op.attrs ?? {})],
          )
        }
        break
      }
      case 'event':
        this.touchSession(op.sessionId, op.ts)
        this.db.run(
          `INSERT OR IGNORE INTO events (id, session_id, span_id, ts, type, attrs) VALUES (?, ?, ?, ?, ?, ?)`,
          [op.id, op.sessionId, op.spanId ?? null, op.ts, op.type, JSON.stringify(op.attrs ?? {})],
        )
        break
    }
  }

  sweep(retentionDays: number, now: number = Date.now()): number {
    const cutoff = now - retentionDays * 86400_000
    const old = this.db.query('SELECT id FROM sessions WHERE last_event_at < ?').all(cutoff) as { id: string }[]
    const tx = this.db.transaction(() => {
      for (const { id } of old) {
        this.db.run('DELETE FROM spans WHERE session_id = ?', [id])
        this.db.run('DELETE FROM events WHERE session_id = ?', [id])
        this.db.run('DELETE FROM sessions WHERE id = ?', [id])
      }
    })
    tx()
    return old.length
  }

  close() { this.db.close() }
}
