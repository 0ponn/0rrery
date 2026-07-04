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

test('hook then transcript span.start merge: parent and attrs upgrade', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'span.start', id: 'tool:t1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 10, attrs: { a: 1 } }])
  store.applyOps([{ op: 'span.start', id: 'tool:t1', sessionId: 's1', parentId: 'llm:m1', kind: 'tool', name: 'Bash', ts: 12, attrs: { b: 2 } }])
  const sp = store.db.query("SELECT * FROM spans WHERE id='tool:t1'").get() as any
  expect(sp.parent_id).toBe('llm:m1')
  expect(sp.started_at).toBe(10)
  expect(JSON.parse(sp.attrs)).toEqual({ a: 1, b: 2 })
  store.close()
})

test('orphan span.end never creates an empty-id session', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'span.end', id: 'late1', ts: 5, status: 'ok' }])
  store.applyOps([{ op: 'span.end', id: 'late1', ts: 6, status: 'ok' }])
  expect((store.db.query("SELECT COUNT(*) c FROM sessions WHERE id=''").get() as any).c).toBe(0)
  // and a later span.start upgrades the placeholder
  store.applyOps([{ op: 'span.start', id: 'late1', sessionId: 'real', kind: 'tool', name: 'Bash', ts: 4 }])
  const sp = store.db.query("SELECT * FROM spans WHERE id='late1'").get() as any
  expect(sp.session_id).toBe('real')
  store.close()
})

test('session.start after session.end resurrects status to active', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'session.start', sessionId: 'r1', source: 'claude-code', ts: 1 }])
  store.applyOps([{ op: 'session.end', sessionId: 'r1', ts: 2 }])
  let s = store.db.query("SELECT * FROM sessions WHERE id='r1'").get() as any
  expect(s.status).toBe('ended')
  store.applyOps([{ op: 'session.start', sessionId: 'r1', source: 'claude-code', ts: 3 }])
  s = store.db.query("SELECT * FROM sessions WHERE id='r1'").get() as any
  expect(s.status).toBe('active')
  store.close()
})

test('stale session.start replay does not resurrect an ended session', () => {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 's1', source: 'claude-code', ts: 100 },
    { op: 'session.end', sessionId: 's1', ts: 500 },
  ])
  store.applyOps([{ op: 'session.start', sessionId: 's1', source: 'claude-code', ts: 100 }])
  expect((store.db.query("SELECT status FROM sessions WHERE id='s1'").get() as any).status).toBe('ended')
  // a genuine resume (newer ts) does resurrect
  store.applyOps([{ op: 'session.start', sessionId: 's1', source: 'claude-code', ts: 600 }])
  expect((store.db.query("SELECT status FROM sessions WHERE id='s1'").get() as any).status).toBe('active')
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

test('placeholder name/kind upgrade on merge; real names never regress', () => {
  const store = new Store(':memory:')
  // linkage-style placeholder arrives first
  store.applyOps([{ op: 'span.start', id: 'agent:a1', sessionId: 's1', parentId: 'tool:t1', kind: 'agent', name: '(unknown)', ts: 10 }])
  store.applyOps([{ op: 'span.start', id: 'agent:a1', sessionId: 's1', parentId: null, kind: 'agent', name: 'general-purpose', ts: 12 }])
  let sp = store.db.query("SELECT * FROM spans WHERE id='agent:a1'").get() as any
  expect(sp.name).toBe('general-purpose')
  expect(sp.parent_id).toBe('tool:t1')
  // reverse order: real name first is kept
  store.applyOps([{ op: 'span.start', id: 'agent:a2', sessionId: 's1', kind: 'agent', name: 'Explore', ts: 20 }])
  store.applyOps([{ op: 'span.start', id: 'agent:a2', sessionId: 's1', kind: 'agent', name: '(unknown)', ts: 21 }])
  sp = store.db.query("SELECT * FROM spans WHERE id='agent:a2'").get() as any
  expect(sp.name).toBe('Explore')
  // orphan span.end placeholder heals kind AND name from the real start
  store.applyOps([{ op: 'span.end', id: 'late2', ts: 30, status: 'ok' }])
  store.applyOps([{ op: 'span.start', id: 'late2', sessionId: 's1', kind: 'tool', name: 'Bash', ts: 29 }])
  sp = store.db.query("SELECT * FROM spans WHERE id='late2'").get() as any
  expect(sp.kind).toBe('tool')
  expect(sp.name).toBe('Bash')
  store.close()
})
