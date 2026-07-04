import { test, expect } from 'bun:test'
import { permissionStatus, eventDetail } from '../src/perms'
import type { EventRow, SpanRow } from '../src/types'

const evt = (id: string, type: string, spanId: string | null, attrs = {}): EventRow =>
  ({ id, session_id: 's', span_id: spanId, ts: 1, type, attrs: JSON.stringify(attrs) })
const span = (id: string, ended: number | null): SpanRow =>
  ({ id, session_id: 's', parent_id: null, kind: 'tool', name: 'Bash', started_at: 1, ended_at: ended, status: ended ? 'ok' : 'running', attrs: '{}' })

test('permissionStatus derives allowed/denied/pending', () => {
  const events = [
    evt('r1', 'permission.requested', 'tool:a'),
    evt('r2', 'permission.requested', 'tool:b'),
    evt('r3', 'permission.requested', 'tool:c'),
    evt('d2', 'permission.resolved', 'tool:b', { outcome: 'denied' }),
  ]
  const spans = [span('tool:a', 99), span('tool:c', null)]
  const m = permissionStatus(events, spans)
  expect(m.get('tool:a')).toBe('allowed')   // requested, span ran to completion
  expect(m.get('tool:b')).toBe('denied')    // explicit denial event
  expect(m.get('tool:c')).toBe('pending')   // requested, never ended, no denial
  expect(m.size).toBe(3)
})

test('eventDetail renders each attr shape', () => {
  expect(eventDetail(JSON.stringify({ preview: 'hi' }))).toBe('hi')
  expect(eventDetail(JSON.stringify({ message: 'note' }))).toBe('note')
  expect(eventDetail(JSON.stringify({ reason: 'rule', tool: 'Bash' }))).toBe('Bash: rule')
  expect(eventDetail(JSON.stringify({ outcome: 'denied', tool: 'Bash' }))).toBe('Bash: denied')
  expect(eventDetail(JSON.stringify({ trigger: 'auto', preTokens: 150000 }))).toBe('auto compact at 150000 tokens')
  expect(eventDetail('garbage')).toBe('')
})
