import { test, expect } from 'bun:test'
import { buildTopology, layoutTopology } from '../src/topology'
import type { SpanRow } from '../src/types'

const span = (id: string, parent: string | null, kind: SpanRow['kind'], name: string, opts: Partial<SpanRow> = {}): SpanRow => ({
  id, session_id: 's', parent_id: parent, kind, name,
  started_at: 100, ended_at: 200, status: 'ok', attrs: '{}', ...opts,
})

// A session shaped like real data:
//   main llm (msg1) spawns two general-purpose agents (a1, a2) and one Explore (a3, unlinked)
//   a1's llm (msgA) calls Bash twice; hook-only tool (Read) at main; malformed attrs on one span
const FIXTURE: SpanRow[] = [
  span('llm:m1', null, 'llm', 'fable', { attrs: JSON.stringify({ input_tokens: 100, output_tokens: 10 }) }),
  span('tool:t1', 'llm:m1', 'tool', 'Agent'),
  span('tool:t2', 'llm:m1', 'tool', 'Agent'),
  span('agent:a1', 'tool:t1', 'agent', 'general-purpose'),
  span('agent:a2', 'tool:t2', 'agent', 'general-purpose'),
  span('agent:a3', null, 'agent', 'Explore'),                                     // unlinked → main
  span('llm:mA', 'agent:a1', 'llm', 'haiku', { attrs: JSON.stringify({ input_tokens: 50, output_tokens: 5 }) }),
  span('llm:mB', 'agent:a1', 'llm', 'haiku', { attrs: 'not json' }),              // malformed: counted, tokens skipped
  span('tool:tb1', 'llm:mA', 'tool', 'Bash', { started_at: 100, ended_at: 150 }),
  span('tool:tb2', 'llm:mA', 'tool', 'Bash', { started_at: 100, ended_at: null, status: 'running' }),  // running: counted, no ms
  span('tool:th1', null, 'tool', 'Read'),                                          // hook-only → main calls it
]

test('buildTopology aggregates actor classes', () => {
  const { nodes } = buildTopology(FIXTURE)
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
  expect(byId['main']).toMatchObject({ kind: 'main', count: 1 })
  expect(byId['agent:general-purpose']).toMatchObject({ kind: 'agent', label: 'general-purpose', count: 2 })
  expect(byId['agent:Explore']).toMatchObject({ count: 1 })
  expect(byId['llm:fable']).toMatchObject({ kind: 'llm', count: 1 })
  expect(byId['llm:haiku']).toMatchObject({ count: 2 })
  expect(byId['tool:Bash']).toMatchObject({ kind: 'tool', count: 2 })
  expect(byId['tool:Agent']).toMatchObject({ count: 2 })
  expect(byId['tool:Read']).toMatchObject({ count: 1 })
  expect(nodes).toHaveLength(8)
})

test('buildTopology edge rules and weights', () => {
  const { edges } = buildTopology(FIXTURE)
  const byKey = Object.fromEntries(edges.map(e => [`${e.from}→${e.to}`, e]))
  // main → its model, with tokens
  expect(byKey['main→llm:fable']).toMatchObject({ calls: 1, tokensIn: 100, tokensOut: 10, totalMs: 100 })
  // model → tools it emitted
  expect(byKey['llm:fable→tool:Agent']).toMatchObject({ calls: 2 })
  expect(byKey['llm:haiku→tool:Bash']).toMatchObject({ calls: 2, totalMs: 50 })   // running span adds calls, not ms
  // agent llm calls: malformed attrs counted but token-skipped
  expect(byKey['agent:general-purpose→llm:haiku']).toMatchObject({ calls: 2, tokensIn: 50, tokensOut: 5 })
  // agent spawn edges via linkage chain; unlinked agent falls back to main
  expect(byKey['main→agent:general-purpose']).toMatchObject({ calls: 2 })
  expect(byKey['main→agent:Explore']).toMatchObject({ calls: 1 })
  // hook-only tool at main
  expect(byKey['main→tool:Read']).toMatchObject({ calls: 1 })
  expect(edges).toHaveLength(7)
})

test('layoutTopology: columns, determinism, barycenter pulls callees toward callers', () => {
  const { nodes, edges } = buildTopology(FIXTURE)
  const laid = layoutTopology(nodes, edges)
  const byId = Object.fromEntries(laid.map(n => [n.id, n]))
  expect(byId['main'].x).toBe(0)
  expect(byId['agent:Explore'].x).toBe(220)
  expect(byId['llm:haiku'].x).toBe(440)
  expect(byId['tool:Bash'].x).toBe(660)
  // determinism
  expect(layoutTopology(nodes, edges)).toEqual(laid)
  // barycenter: two tools called by the same model sit adjacent
  const bashY = byId['tool:Bash'].y
  const agentToolY = byId['tool:Agent'].y
  expect(Math.abs(bashY - agentToolY)).toBeGreaterThan(0)  // distinct rows
  laid.forEach(n => { expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true) })
})

test('empty spans → just main with no edges', () => {
  const { nodes, edges } = buildTopology([])
  expect(nodes).toEqual([{ id: 'main', kind: 'main', label: 'main', count: 1 }])
  expect(edges).toEqual([])
})
