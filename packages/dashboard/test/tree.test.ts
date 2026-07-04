import { test, expect } from 'bun:test'
import { buildSpanTree, tokenRollup } from '../src/tree'
import type { SpanRow } from '../src/types'

const row = (id: string, parent: string | null, kind = 'tool', attrs = '{}'): SpanRow => ({
  id, session_id: 's', parent_id: parent, kind: kind as SpanRow['kind'], name: id,
  started_at: Number(id.replace(/\D/g, '')) || 0, ended_at: null, status: 'ok', attrs,
})

test('builds tree, orphan parents become roots', () => {
  const tree = buildSpanTree([row('a1', null), row('b2', 'a1'), row('c3', 'a1'), row('d4', 'missing')])
  expect(tree.map(n => n.span.id)).toEqual(['a1', 'd4'])
  expect(tree[0].children.map(n => n.span.id)).toEqual(['b2', 'c3'])
  expect(tree[0].children[0].depth).toBe(1)
})

test('tokenRollup sums llm spans only', () => {
  const spans = [
    row('l1', null, 'llm', JSON.stringify({ input_tokens: 100, output_tokens: 10 })),
    row('l2', null, 'llm', JSON.stringify({ input_tokens: 50, output_tokens: 5 })),
    row('t3', null, 'tool', JSON.stringify({ input_tokens: 999 })),
  ]
  expect(tokenRollup(spans)).toEqual({ input: 150, output: 15 })
})
