import { test, expect } from 'bun:test'
import { parseOps, IngestOpSchema } from '../src/index'

const good = [
  { op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'p', cwd: '/x', gitBranch: 'main', ts: 1 },
  { op: 'span.start', id: 'sp1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 2, attrs: { cmd: 'ls' } },
  { op: 'span.end', id: 'sp1', ts: 3, status: 'ok' },
  { op: 'event', id: 'e1', sessionId: 's1', type: 'permission.requested', ts: 4, attrs: {} },
  { op: 'session.end', sessionId: 's1', ts: 5 },
]

test('accepts all op kinds and round-trips', () => {
  const { ok, rejected } = parseOps(good)
  expect(rejected).toEqual([])
  expect(ok).toHaveLength(5)
  for (const [i, op] of ok.entries()) expect(IngestOpSchema.parse(good[i])).toEqual(op)
})

test('rejects bad items individually, keeps good ones', () => {
  const { ok, rejected } = parseOps([good[1], { op: 'span.start', id: 'x' }, 42])
  expect(ok).toHaveLength(1)
  expect(rejected).toHaveLength(2)
  expect(rejected[0].index).toBe(1)
  expect(rejected[1].index).toBe(2)
  expect(typeof rejected[0].error).toBe('string')
})

test('rejects non-array input as single rejection', () => {
  const { ok, rejected } = parseOps({ nope: true })
  expect(ok).toEqual([])
  expect(rejected).toHaveLength(1)
})
