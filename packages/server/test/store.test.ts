import { test, expect } from 'bun:test'
import { Store } from '../src/store'
import type { IngestOp, SessionRow, SpanRow, EventRow } from '@0rrery/schema'

const ops: IngestOp[] = [
  { op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'p', cwd: '/x', gitBranch: 'main', ts: 100 },
  { op: 'span.start', id: 'sp1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 110, attrs: { cmd: 'ls' } },
  { op: 'span.end', id: 'sp1', ts: 150, status: 'ok', attrs: { exit: 0 } },
  { op: 'event', id: 'e1', sessionId: 's1', spanId: 'sp1', type: 'permission.requested', ts: 120, attrs: {} },
  { op: 'session.end', sessionId: 's1', ts: 200 },
]

function freshApplied() {
  const store = new Store(':memory:')
  store.applyOps(ops)
  return store
}

test('applies ops into three tables', () => {
  const store = freshApplied()
  const s = store.db.query('SELECT * FROM sessions').all() as SessionRow[]
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ id: 's1', source: 'claude-code', project: 'p', git_branch: 'main', status: 'ended', started_at: 100, last_event_at: 200 })
  const sp = store.db.query('SELECT * FROM spans').all() as SpanRow[]
  expect(sp[0]).toMatchObject({ id: 'sp1', session_id: 's1', kind: 'tool', status: 'ok', started_at: 110, ended_at: 150 })
  expect(JSON.parse(sp[0].attrs)).toEqual({ cmd: 'ls', exit: 0 })  // end attrs merged over start attrs
  const ev = store.db.query('SELECT * FROM events').all() as EventRow[]
  expect(ev[0]).toMatchObject({ id: 'e1', span_id: 'sp1', type: 'permission.requested' })
  store.close()
})

test('re-applying the same ops changes nothing (idempotent)', () => {
  const store = freshApplied()
  store.applyOps(ops)
  expect((store.db.query('SELECT COUNT(*) c FROM spans').get() as any).c).toBe(1)
  expect((store.db.query('SELECT COUNT(*) c FROM events').get() as any).c).toBe(1)
  expect((store.db.query('SELECT COUNT(*) c FROM sessions').get() as any).c).toBe(1)
  store.close()
})

test('span/event for unknown session auto-creates minimal session', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'span.start', id: 'x1', sessionId: 'ghost', kind: 'tool', name: 'Read', ts: 5 }])
  const s = store.db.query("SELECT * FROM sessions WHERE id='ghost'").get() as SessionRow
  expect(s).toMatchObject({ source: 'api', status: 'active', started_at: 5 })
  store.close()
})

test('span.end before span.start creates orphan-tolerant row', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'span.end', id: 'late', ts: 9, status: 'error' }])
  const sp = store.db.query("SELECT * FROM spans WHERE id='late'").get() as SpanRow
  expect(sp).toMatchObject({ status: 'error', ended_at: 9 })
  store.close()
})

test('sweep deletes sessions idle past retention, cascading children', () => {
  const store = freshApplied()
  const deleted = store.sweep(30, 200 + 31 * 86400_000)
  expect(deleted).toBe(1)
  expect((store.db.query('SELECT COUNT(*) c FROM spans').get() as any).c).toBe(0)
  expect((store.db.query('SELECT COUNT(*) c FROM events').get() as any).c).toBe(0)
  store.close()
})
