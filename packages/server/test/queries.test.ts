import { test, expect } from 'bun:test'
import { Store } from '../src/store'
import { listSessions, getSessionDetail, getStats } from '../src/queries'

const OPTS = { now: 10_000_000, staleAfterMs: 1_000_000 }

function seeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'a', source: 'claude-code', project: 'p1', ts: 9_500_000 },
    { op: 'span.start', id: 'sp1', sessionId: 'a', kind: 'agent', name: 'main', ts: 9_500_000 },
    { op: 'span.start', id: 'sp2', sessionId: 'a', parentId: 'sp1', kind: 'tool', name: 'Bash', ts: 9_500_100 },
    { op: 'event', id: 'e1', sessionId: 'a', type: 'message.user', ts: 9_500_050 },
    { op: 'session.end', sessionId: 'a', ts: 9_600_000 },
    { op: 'session.start', sessionId: 'b', source: 'api', project: 'p2', ts: 9_700_000 },
  ])
  return store
}

test('listSessions orders by recency and filters', () => {
  const store = seeded()
  const all = listSessions(store.db, undefined, OPTS)
  expect(all.map(s => s.id)).toEqual(['b', 'a'])
  expect(listSessions(store.db, { status: 'active' }, OPTS).map(s => s.id)).toEqual(['b'])
  expect(listSessions(store.db, { project: 'p1' }, OPTS).map(s => s.id)).toEqual(['a'])
  expect(listSessions(store.db, { limit: 1, offset: 1 }, OPTS).map(s => s.id)).toEqual(['a'])
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
  expect(getStats(store.db, OPTS)).toEqual({ sessions: 2, activeSessions: 1, staleSessions: 0, spans: 2, events: 1 })
  store.close()
})

function staleSeeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'fresh', source: 'api', ts: 9_500_000 },              // active, recent
    { op: 'session.start', sessionId: 'old', source: 'api', ts: 1_000 },                     // active, stale
    { op: 'session.start', sessionId: 'done', source: 'api', ts: 9_600_000 },
    { op: 'session.end', sessionId: 'done', ts: 9_700_000 },                                  // ended, recent
  ])
  return store
}

test('status filters use effective semantics', () => {
  const store = staleSeeded()
  expect(listSessions(store.db, { status: 'active' }, OPTS).map(s => s.id)).toEqual(['fresh'])
  expect(listSessions(store.db, { status: 'stale' }, OPTS).map(s => s.id)).toEqual(['old'])
  expect(listSessions(store.db, { status: 'ended' }, OPTS).map(s => s.id)).toEqual(['done'])
  expect(listSessions(store.db, undefined, OPTS)).toHaveLength(3)  // no filter: everything
  store.close()
})

test('cutoff boundary: exactly at cutoff is active', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'session.start', sessionId: 'edge', source: 'api', ts: 9_000_000 }])  // == now - staleAfterMs
  expect(listSessions(store.db, { status: 'active' }, OPTS).map(s => s.id)).toEqual(['edge'])
  expect(listSessions(store.db, { status: 'stale' }, OPTS)).toHaveLength(0)
  store.close()
})

test('getStats splits active and stale', () => {
  const store = staleSeeded()
  expect(getStats(store.db, OPTS)).toEqual({ sessions: 3, activeSessions: 1, staleSessions: 1, spans: 0, events: 0 })
  store.close()
})
