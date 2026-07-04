import { test, expect } from 'bun:test'
import { Store } from '../src/store'
import { listSessions, getSessionDetail, getStats } from '../src/queries'

function seeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'a', source: 'claude-code', project: 'p1', ts: 100 },
    { op: 'span.start', id: 'sp1', sessionId: 'a', kind: 'agent', name: 'main', ts: 100 },
    { op: 'span.start', id: 'sp2', sessionId: 'a', parentId: 'sp1', kind: 'tool', name: 'Bash', ts: 110 },
    { op: 'event', id: 'e1', sessionId: 'a', type: 'message.user', ts: 105 },
    { op: 'session.end', sessionId: 'a', ts: 300 },
    { op: 'session.start', sessionId: 'b', source: 'api', project: 'p2', ts: 400 },
  ])
  return store
}

test('listSessions orders by recency and filters', () => {
  const store = seeded()
  const all = listSessions(store.db)
  expect(all.map(s => s.id)).toEqual(['b', 'a'])
  expect(listSessions(store.db, { status: 'active' }).map(s => s.id)).toEqual(['b'])
  expect(listSessions(store.db, { project: 'p1' }).map(s => s.id)).toEqual(['a'])
  expect(listSessions(store.db, { limit: 1, offset: 1 }).map(s => s.id)).toEqual(['a'])
  store.close()
})

test('getSessionDetail returns ordered spans and events, null for missing', () => {
  const store = seeded()
  const d = getSessionDetail(store.db, 'a')!
  expect(d.session.id).toBe('a')
  expect(d.spans.map(s => s.id)).toEqual(['sp1', 'sp2'])
  expect(d.events.map(e => e.id)).toEqual(['e1'])
  expect(getSessionDetail(store.db, 'nope')).toBeNull()
  store.close()
})

test('getStats counts', () => {
  const store = seeded()
  expect(getStats(store.db)).toEqual({ sessions: 2, activeSessions: 1, spans: 2, events: 1 })
  store.close()
})
