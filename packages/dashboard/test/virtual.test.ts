import { test, expect } from 'bun:test'
import { visibleRange, ROW_H } from '../src/virtual'
import { buildSpanTree, flattenTree } from '../src/tree'
import type { SpanRow } from '../src/types'

test('visibleRange at the top renders from row 0 with overscan below', () => {
  const r = visibleRange(0, 600, 24, 4000)
  expect(r.start).toBe(0)
  expect(r.end).toBe(Math.ceil(600 / 24) + 20)
  expect(r.padTop).toBe(0)
})

test('visibleRange mid-scroll windows around the viewport', () => {
  const r = visibleRange(48_000, 600, 24, 4000)
  expect(r.start).toBe(2000 - 20)
  expect(r.end).toBe(Math.ceil((48_000 + 600) / 24) + 20)
  expect(r.padTop).toBe(r.start * 24)
})

test('visibleRange clamps on short lists and at the bottom', () => {
  const short = visibleRange(0, 600, 24, 10)
  expect(short).toMatchObject({ start: 0, end: 10, padTop: 0, padBottom: 0 })
  const bottom = visibleRange(4000 * 24 - 600, 600, 24, 4000)
  expect(bottom.end).toBe(4000)
  expect(bottom.padBottom).toBe(0)
})

test('pad invariant: spacers plus rendered rows always sum to full height', () => {
  for (const st of [0, 999, 47_997, 95_400]) {
    const r = visibleRange(st, 613, 24, 4000)
    expect(r.padTop + (r.end - r.start) * 24 + r.padBottom).toBe(4000 * 24)
  }
})

test('visibleRange stays well-formed when scrollTop outlives a shrunk list', () => {
  const r = visibleRange(100_000, 600, 24, 5)
  expect(r.start).toBeLessThanOrEqual(r.end)
  expect(r.start).toBeLessThanOrEqual(5)
  expect(r.end).toBeLessThanOrEqual(5)
  expect(r.padTop + (r.end - r.start) * 24 + r.padBottom).toBe(5 * 24)
  expect(r.padTop).toBeLessThanOrEqual(5 * 24)
})

test('visibleRange tolerates hostile inputs without malformed output', () => {
  for (const [st, vh, total] of [[-100_000, 0, 4000], [0, 0, 0], [1e9, 600, 100]] as const) {
    const r = visibleRange(st, vh, 24, total)
    expect(r.start).toBeGreaterThanOrEqual(0)
    expect(r.start).toBeLessThanOrEqual(r.end)
    expect(r.end).toBeLessThanOrEqual(total)
    expect(r.padTop).toBeGreaterThanOrEqual(0)
    expect(r.padBottom).toBeGreaterThanOrEqual(0)
  }
})

test('flattenTree preserves DFS order and depth', () => {
  const mk = (id: string, parent: string | null): SpanRow => ({
    id, session_id: 's', parent_id: parent, kind: 'tool', name: id,
    started_at: 1, ended_at: 2, status: 'ok', attrs: '{}',
  } as SpanRow)
  const tree = buildSpanTree([mk('a', null), mk('b', 'a'), mk('c', 'b'), mk('d', null)])
  const flat = flattenTree(tree)
  expect(flat.map(n => n.span.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(flat.map(n => n.depth)).toEqual([0, 1, 2, 0])
})
