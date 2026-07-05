import { test, expect } from 'bun:test'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store'
import { spendSeries, toolHealth, projectRollups, searchSessions, sprawlMap, externalSurface, fsFootprint, sessionSummary, fleetView } from '../src/insights'
import { estCost, resetPricesCache } from '../src/prices'

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

test('ORRERY_PRICES overrides defaults', () => {
  const p = join(tmpdir(), `0rrery-prices-${process.pid}.json`)
  writeFileSync(p, JSON.stringify({ 'mystery-model': { in: 1, out: 2 } }))
  process.env.ORRERY_PRICES = p
  resetPricesCache()
  try { expect(estCost('mystery-model', 1_000_000, 1_000_000)).toBeCloseTo(3) }
  finally { delete process.env.ORRERY_PRICES; resetPricesCache(); rmSync(p) }
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

test('insight queries are reachable via the package entry', async () => {
  const pkg = await import('@0rrery/server')
  for (const fn of ['spendSeries', 'toolHealth', 'projectRollups', 'searchSessions', 'estCost', 'sprawlMap', 'externalSurface', 'fsFootprint'] as const) {
    expect(typeof (pkg as any)[fn]).toBe('function')
  }
})

test('searchSessions matches preview text and filters by project', () => {
  const db = seeded().db
  expect(searchSessions(db, { q: 'flaky login' }, OPTS).map(s => s.id)).toEqual(['sA'])
  expect(searchSessions(db, { q: 'nonexistent' }, OPTS)).toHaveLength(0)
  expect(searchSessions(db, { project: 'beta' }, OPTS).map(s => s.id)).toEqual(['sB'])
  expect(searchSessions(db, { q: 'bet' }, OPTS).map(s => s.id)).toEqual(['sB'])  // project name matches too
})

function sprawlSeeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'alpha', ts: D1 },
    { op: 'span.start', id: 'llm:a', sessionId: 's1', parentId: null, kind: 'llm', name: 'claude-sonnet-5', ts: D1, attrs: { input_tokens: 100, output_tokens: 200 } },
    { op: 'span.end', id: 'llm:a', ts: D1 + 1000, status: 'ok' },
    { op: 'span.start', id: 'tool:r1', sessionId: 's1', parentId: 'llm:a', kind: 'tool', name: 'Read', ts: D1, attrs: { input: { file_path: '/repo/src/app.ts' } } },
    { op: 'span.start', id: 'tool:w1', sessionId: 's1', parentId: 'llm:a', kind: 'tool', name: 'Write', ts: D1, attrs: { input: { file_path: '/repo/src/app.ts' } } },
    { op: 'span.start', id: 'tool:f1', sessionId: 's1', parentId: 'llm:a', kind: 'tool', name: 'WebFetch', ts: D1, attrs: { input: { url: 'https://api.github.com/repos/x' } } },
    { op: 'span.start', id: 'tool:b1', sessionId: 's1', parentId: 'llm:a', kind: 'tool', name: 'Bash', ts: D1, attrs: { input: { command: 'curl -s https://registry.npmjs.org/0rrery | jq .' } } },
    { op: 'span.start', id: 'mcp:m1', sessionId: 's1', parentId: 'llm:a', kind: 'mcp', name: 'mcp__engram__mem_save', ts: D1, attrs: { input: {} } },
    // second session, same shapes — cross-session merge
    { op: 'session.start', sessionId: 's2', source: 'claude-code', project: 'beta', ts: D2 },
    { op: 'span.start', id: 'llm:b', sessionId: 's2', parentId: null, kind: 'llm', name: 'claude-sonnet-5', ts: D2, attrs: { input_tokens: 10, output_tokens: 20 } },
    { op: 'span.end', id: 'llm:b', ts: D2 + 500, status: 'ok' },
    { op: 'span.start', id: 'tool:r2', sessionId: 's2', parentId: 'llm:b', kind: 'tool', name: 'Read', ts: D2, attrs: { input: { file_path: '/repo/src/db.ts' } } },
  ])
  return store
}

test('sprawlMap merges actors across sessions by label', () => {
  const { nodes, edges } = sprawlMap(sprawlSeeded().db, {})
  expect(nodes.find(n => n.id === 'llm:claude-sonnet-5')!.count).toBe(2)
  expect(nodes.find(n => n.id === 'tool:Read')!.count).toBe(2)
  const readEdge = edges.find(e => e.from === 'llm:claude-sonnet-5' && e.to === 'tool:Read')!
  expect(readEdge.calls).toBe(2)
  const mainEdge = edges.find(e => e.from === 'main' && e.to === 'llm:claude-sonnet-5')!
  expect(mainEdge).toMatchObject({ calls: 2, tokensIn: 110, tokensOut: 220 })
})

test('sprawlMap project filter narrows the graph', () => {
  const { nodes } = sprawlMap(sprawlSeeded().db, { project: 'beta' })
  expect(nodes.find(n => n.id === 'tool:Read')!.count).toBe(1)
  expect(nodes.find(n => n.id === 'tool:WebFetch')).toBeUndefined()
})

test('externalSurface extracts url hosts, curl hosts, and mcp servers', () => {
  const s = externalSurface(sprawlSeeded().db, {})
  expect(s.domains.find(d => d.host === 'api.github.com')).toMatchObject({ calls: 1, tools: ['WebFetch'] })
  expect(s.domains.find(d => d.host === 'registry.npmjs.org')).toMatchObject({ calls: 1, tools: ['Bash'] })
  expect(s.mcp).toEqual([{ server: 'engram', tools: [{ name: 'mem_save', calls: 1 }] }])
})

test('fsFootprint aggregates files and parent dirs with read/write split', () => {
  const f = fsFootprint(sprawlSeeded().db, {})
  expect(f.files.find(x => x.path === '/repo/src/app.ts')).toMatchObject({ touches: 2, reads: 1, writes: 1 })
  expect(f.dirs.find(x => x.path === '/repo/src')).toMatchObject({ touches: 3, reads: 2, writes: 1 })
})

test('externalSurface strips userinfo and ports, never leaks credentials', () => {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'sc', source: 'claude-code', project: 'sec', ts: D1 },
    { op: 'span.start', id: 'tool:c1', sessionId: 'sc', parentId: null, kind: 'tool', name: 'Bash', ts: D1, attrs: { input: { command: 'git clone https://ghp_secrettoken@github.com/org/repo.git && curl https://user:pass@api.example.com:8443/v1' } } },
  ])
  const s = externalSurface(store.db, {})
  const hosts = s.domains.map(d => d.host)
  expect(hosts).toContain('github.com')
  expect(hosts).toContain('api.example.com')
  expect(JSON.stringify(s)).not.toContain('secrettoken')
  expect(JSON.stringify(s)).not.toContain('pass')
})

test('externalSurface caps mcp servers to top 100 by total calls', () => {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'sm', source: 'claude-code', project: 'gamma', ts: D1 },
    { op: 'span.start', id: 'mcp:x1', sessionId: 'sm', parentId: null, kind: 'mcp', name: 'mcp__one__tool', ts: D1, attrs: { input: {} } },
    { op: 'span.start', id: 'mcp:y1', sessionId: 'sm', parentId: null, kind: 'mcp', name: 'mcp__two__tool', ts: D1, attrs: { input: {} } },
    { op: 'span.start', id: 'mcp:y2', sessionId: 'sm', parentId: null, kind: 'mcp', name: 'mcp__two__tool', ts: D1, attrs: { input: {} } },
    { op: 'span.start', id: 'mcp:z1', sessionId: 'sm', parentId: null, kind: 'mcp', name: 'mcp__three__tool', ts: D1, attrs: { input: {} } },
    { op: 'span.start', id: 'mcp:z2', sessionId: 'sm', parentId: null, kind: 'mcp', name: 'mcp__three__tool', ts: D1, attrs: { input: {} } },
    { op: 'span.start', id: 'mcp:z3', sessionId: 'sm', parentId: null, kind: 'mcp', name: 'mcp__three__tool', ts: D1, attrs: { input: {} } },
  ])
  const s = externalSurface(store.db, {})
  expect(s.mcp[0].server).toBe('three')
  expect(s.mcp.length).toBeLessThanOrEqual(100)
})

test('sprawlMap survives self-referential parent ids', () => {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'sx', source: 'api', ts: D1 },
    { op: 'span.start', id: 'tool:loop', sessionId: 'sx', parentId: 'tool:loop', kind: 'tool', name: 'Weird', ts: D1, attrs: {} },
  ])
  const { nodes } = sprawlMap(store.db, {})
  expect(nodes.find(n => n.id === 'tool:Weird')!.count).toBe(1)
})

test('sessionSummary aggregates one session compactly', () => {
  const s = sessionSummary(seeded().db, 'sA')!
  expect(s).toMatchObject({
    id: 'sA', project: 'alpha', tokens_in: 1010, tokens_out: 2020,
    denials: 1, subagents: 1, user_messages: 1, assistant_turns: 0,
    first_user_message: 'fix the flaky login test',
  })
  expect(s.models).toEqual([
    { model: 'claude-sonnet-5', calls: 1 }, { model: 'mystery-model', calls: 1 },
  ])
  expect(s.top_tools).toEqual([{ name: 'Bash', kind: 'tool', calls: 2, errors: 2 }])
  expect(s.errors).toBe(2)
  expect(s.est_cost).toBeCloseTo(1000 / 1e6 * 3 + 2000 / 1e6 * 15)  // sonnet only; mystery excluded
  expect(s.duration_ms).toBeGreaterThanOrEqual(0)
})

test('sessionSummary returns null for unknown id', () => {
  expect(sessionSummary(seeded().db, 'nope')).toBeNull()
})

const NOW = D1 + 1_000_000
function fleetSeeded(mut: any[] = []) {
  const store = new Store(':memory:')
  store.applyOps([
    // fA: active, open tool span 30s, unresolved permission 30s
    { op: 'session.start', sessionId: 'fA', source: 'claude-code', project: 'alpha', ts: NOW - 60_000 },
    { op: 'span.start', id: 'tool:fa1', sessionId: 'fA', parentId: null, kind: 'tool', name: 'Bash', ts: NOW - 30_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:fa1', sessionId: 'fA', spanId: 'tool:fa1', type: 'permission.requested', ts: NOW - 30_000, attrs: {} },
    // fB: active, permission resolved, span closed, llm tokens, more recent than fA
    { op: 'session.start', sessionId: 'fB', source: 'claude-code', project: 'beta', ts: NOW - 50_000 },
    { op: 'span.start', id: 'tool:fb1', sessionId: 'fB', parentId: null, kind: 'tool', name: 'Read', ts: NOW - 40_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:fb1', sessionId: 'fB', spanId: 'tool:fb1', type: 'permission.requested', ts: NOW - 40_000, attrs: {} },
    { op: 'event', id: 'evt:perm:res:fb1', sessionId: 'fB', spanId: 'tool:fb1', type: 'permission.resolved', ts: NOW - 39_000, attrs: { outcome: 'allowed' } },
    { op: 'span.end', id: 'tool:fb1', ts: NOW - 38_000, status: 'ok' },
    { op: 'span.start', id: 'llm:fb2', sessionId: 'fB', parentId: null, kind: 'llm', name: 'claude-sonnet-5', ts: NOW - 20_000, attrs: { input_tokens: 100, output_tokens: 200 } },
    { op: 'span.end', id: 'llm:fb2', ts: NOW - 19_000, status: 'ok' },
    // fC: ended — excluded
    { op: 'session.start', sessionId: 'fC', source: 'claude-code', project: 'gamma', ts: NOW - 100_000 },
    { op: 'session.end', sessionId: 'fC', ts: NOW - 90_000 },
    ...mut,
  ])
  return store
}
const FOPTS = { now: NOW, staleAfterMs: 300_000 }

test('fleetView: pending permission included, resolved excluded, sorted first', () => {
  const cards = fleetView(fleetSeeded().db, FOPTS)
  expect(cards.map(c => c.id)).toEqual(['fA', 'fB'])  // fA has pending perms despite fB being fresher; fC ended
  expect(cards[0].pending_permissions).toEqual([{ tool: 'Bash', waiting_ms: 30_000 }])
  expect(cards[1].pending_permissions).toEqual([])
})

test('fleetView: current is newest open tool span, null when none open', () => {
  const cards = fleetView(fleetSeeded().db, FOPTS)
  expect(cards[0].current).toEqual({ kind: 'tool', name: 'Bash', running_ms: 30_000 })
  expect(cards[1].current).toBeNull()
})

test('fleetView: tokens and null-honest cost', () => {
  const fb = fleetView(fleetSeeded().db, FOPTS).find(c => c.id === 'fB')!
  expect(fb).toMatchObject({ tokens_in: 100, tokens_out: 200 })
  expect(fb.est_cost).toBeCloseTo(100 / 1e6 * 3 + 200 / 1e6 * 15)
  expect(fb.idle_ms).toBe(19_000)
})

test('fleetView: stuck on old pending permission and old open tool', () => {
  const oldPerm = fleetSeeded([
    { op: 'session.start', sessionId: 'fD', source: 'claude-code', project: 'delta', ts: NOW - 400_000 },
    { op: 'span.start', id: 'tool:fd1', sessionId: 'fD', parentId: null, kind: 'tool', name: 'Write', ts: NOW - 130_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:fd1', sessionId: 'fD', spanId: 'tool:fd1', type: 'permission.requested', ts: NOW - 130_000, attrs: {} },
  ])
  expect(fleetView(oldPerm.db, FOPTS).find(c => c.id === 'fD')!.stuck).toBe(true)
  const oldTool = fleetSeeded([
    { op: 'session.start', sessionId: 'fE', source: 'claude-code', project: 'eps', ts: NOW - 800_000 },
    { op: 'span.start', id: 'mcp:fe1', sessionId: 'fE', parentId: null, kind: 'mcp', name: 'mcp__x__y', ts: NOW - 700_000, attrs: {} },
  ])
  expect(fleetView(oldTool.db, FOPTS).find(c => c.id === 'fE')!.stuck).toBe(true)
  expect(fleetView(fleetSeeded().db, FOPTS).every(c => !c.stuck)).toBe(true)  // 30s pending isn't stuck
})

test('fleetView: effective stale past the cutoff', () => {
  const cards = fleetView(fleetSeeded().db, { now: NOW, staleAfterMs: 10_000 })
  expect(cards.every(c => c.effective === 'stale')).toBe(true)
  const fresh = fleetView(fleetSeeded().db, { now: NOW, staleAfterMs: 25_000 })
  expect(fresh.find(c => c.id === 'fB')!.effective).toBe('active')
  expect(fresh.find(c => c.id === 'fA')!.effective).toBe('stale')
})

test('fleetView: approved-and-completed request is not pending', () => {
  const s = fleetSeeded([
    { op: 'session.start', sessionId: 'fF', source: 'claude-code', project: 'zeta', ts: NOW - 45_000 },
    { op: 'span.start', id: 'tool:ff1', sessionId: 'fF', parentId: null, kind: 'tool', name: 'Edit', ts: NOW - 44_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:ff1', sessionId: 'fF', spanId: 'tool:ff1', type: 'permission.requested', ts: NOW - 44_000, attrs: {} },
    { op: 'span.end', id: 'tool:ff1', ts: NOW - 43_000, status: 'ok' },  // approved: it ran and finished; no resolved event exists
  ])
  expect(fleetView(s.db, FOPTS).find(c => c.id === 'fF')!.pending_permissions).toEqual([])
})

test('fleetView: zombie sessions outside the horizon are excluded', () => {
  const s = fleetSeeded([
    { op: 'session.start', sessionId: 'fZ', source: 'claude-code', project: 'zombie', ts: NOW - 10_000_000 },
  ])
  expect(fleetView(s.db, FOPTS).find(c => c.id === 'fZ')).toBeUndefined()
})

test('fleetView: stale pending request outside the window is dropped', () => {
  const s = fleetSeeded([
    { op: 'session.start', sessionId: 'fG', source: 'claude-code', project: 'eta', ts: NOW - 3_500_000 },
    { op: 'event', id: 'evt:perm:req:fg1', sessionId: 'fG', spanId: 'tool:fg1', type: 'permission.requested', ts: NOW - 2_000_000, attrs: {} },
    { op: 'event', id: 'evt:x', sessionId: 'fG', type: 'message.user', ts: NOW - 1_000, attrs: {} },  // keeps fG inside the horizon
  ])
  expect(fleetView(s.db, FOPTS).find(c => c.id === 'fG')!.pending_permissions).toEqual([])
})

test('fleetView: dangling open span the session moved past is not current', () => {
  const s = fleetSeeded([
    { op: 'session.start', sessionId: 'fH', source: 'claude-code', project: 'theta', ts: NOW - 8_000_000 },
    { op: 'span.start', id: 'tool:fh1', sessionId: 'fH', parentId: null, kind: 'tool', name: 'Bash', ts: NOW - 7_000_000, attrs: {} },  // dangling, never ended
    { op: 'event', id: 'evt:fh', sessionId: 'fH', type: 'message.user', ts: NOW - 5_000, attrs: {} },  // session moved on
  ])
  const card = fleetView(s.db, FOPTS).find(c => c.id === 'fH')!
  expect(card.current).toBeNull()
  expect(card.stuck).toBe(false)
})
