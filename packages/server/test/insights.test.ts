import { test, expect } from 'bun:test'
import { Store } from '../src/store'
import { spendSeries, toolHealth, projectRollups, searchSessions } from '../src/insights'
import { estCost } from '../src/prices'

// Day 1 = 2026-07-01 (ts 1782864000000), Day 2 = 2026-07-02 (+86400000)
const D1 = 1782864000000, D2 = D1 + 86_400_000
function seeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'sA', source: 'claude-code', project: 'alpha', ts: D1 },
    { op: 'span.start', id: 'llm:1', sessionId: 'sA', parentId: null, kind: 'llm', name: 'claude-sonnet-5', ts: D1, attrs: { input_tokens: 1000, output_tokens: 2000 } },
    { op: 'span.end', id: 'llm:1', ts: D1 + 1000, status: 'ok' },
    { op: 'span.start', id: 'llm:2', sessionId: 'sA', parentId: null, kind: 'llm', name: 'mystery-model', ts: D1, attrs: { input_tokens: 10, output_tokens: 20 } },
    { op: 'span.end', id: 'llm:2', ts: D1 + 500, status: 'ok' },
    { op: 'span.start', id: 'tool:t1', sessionId: 'sA', parentId: 'llm:1', kind: 'tool', name: 'Bash', ts: D1, attrs: {} },
    { op: 'span.end', id: 'tool:t1', ts: D1 + 100, status: 'error' },
    { op: 'span.start', id: 'tool:t2', sessionId: 'sA', parentId: 'llm:1', kind: 'tool', name: 'Bash', ts: D1, attrs: {} },
    { op: 'event', id: 'evt:perm:res:t2', sessionId: 'sA', spanId: 'tool:t2', type: 'permission.resolved', ts: D1 + 50, attrs: { outcome: 'denied', source: 'user' } },
    { op: 'span.end', id: 'tool:t2', ts: D1 + 60, status: 'error' },
    { op: 'span.start', id: 'agent:a1', sessionId: 'sA', parentId: 'tool:t2', kind: 'agent', name: 'general-purpose', ts: D1, attrs: {} },
    { op: 'event', id: 'evt:u1', sessionId: 'sA', type: 'message.user', ts: D1, attrs: { preview: 'fix the flaky login test' } },
    { op: 'session.start', sessionId: 'sB', source: 'claude-code', project: 'beta', ts: D2 },
    { op: 'span.start', id: 'llm:3', sessionId: 'sB', parentId: null, kind: 'llm', name: 'claude-sonnet-5', ts: D2, attrs: { input_tokens: 500, output_tokens: 500 } },
    { op: 'span.end', id: 'llm:3', ts: D2 + 1000, status: 'ok' },
  ])
  return store
}
const OPTS = { now: D2 + 10_000_000, staleAfterMs: 1_000_000 }

test('estCost: prefix match, unknown model null', () => {
  expect(estCost('claude-sonnet-5-20260101', 1_000_000, 1_000_000)).toBeCloseTo(3 + 15)
  expect(estCost('mystery-model', 1_000_000, 0)).toBeNull()
})

test('spendSeries groups by day and model, null cost for unknown models', () => {
  const rows = spendSeries(seeded().db, {})
  const sonnetD1 = rows.find(r => r.model === 'claude-sonnet-5' && r.day === '2026-07-01')!
  expect(sonnetD1).toMatchObject({ tokens_in: 1000, tokens_out: 2000, project: 'alpha', calls: 1 })
  expect(sonnetD1.est_cost).toBeCloseTo(1000 / 1e6 * 3 + 2000 / 1e6 * 15)
  expect(rows.find(r => r.model === 'mystery-model')!.est_cost).toBeNull()
  expect(rows.filter(r => r.day === '2026-07-02')).toHaveLength(1)
})

test('spendSeries respects project and time filters', () => {
  const db = seeded().db
  expect(spendSeries(db, { project: 'beta' })).toHaveLength(1)
  expect(spendSeries(db, { from: D2 })).toHaveLength(1)
  expect(spendSeries(db, { to: D1 + 5000 })).toHaveLength(2)
})

test('toolHealth counts calls, errors, denials', () => {
  const rows = toolHealth(seeded().db, {})
  expect(rows.find(r => r.name === 'Bash')).toMatchObject({ kind: 'tool', calls: 2, errors: 2, denials: 1 })
})

test('projectRollups aggregates per project', () => {
  const rows = projectRollups(seeded().db, {})
  const alpha = rows.find(r => r.project === 'alpha')!
  expect(alpha).toMatchObject({ sessions: 1, tokens_in: 1010, tokens_out: 2020, subagents: 1 })
  expect(alpha.wall_ms).toBeGreaterThan(0)
  expect(alpha.est_cost).toBeCloseTo(1000 / 1e6 * 3 + 2000 / 1e6 * 15)  // unknown-model tokens excluded from $
})

test('searchSessions matches preview text and filters by project', () => {
  const db = seeded().db
  expect(searchSessions(db, { q: 'flaky login' }, OPTS).map(s => s.id)).toEqual(['sA'])
  expect(searchSessions(db, { q: 'nonexistent' }, OPTS)).toHaveLength(0)
  expect(searchSessions(db, { project: 'beta' }, OPTS).map(s => s.id)).toEqual(['sB'])
  expect(searchSessions(db, { q: 'bet' }, OPTS).map(s => s.id)).toEqual(['sB'])  // project name matches too
})
