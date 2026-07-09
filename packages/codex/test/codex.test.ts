import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseCodexLine, newCodexState, reviveCodexState } from '../src/codex'
import { codexParser } from '../src/codex'
import type { IngestOp } from '@0rrery/schema'

function parseFixture(): IngestOp[] {
  const state = newCodexState()
  const ops: IngestOp[] = []
  const raw = readFileSync(new URL('../fixtures/codex1.jsonl', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) if (line.trim()) ops.push(...parseCodexLine(line, state))
  return ops
}

test('session_meta starts a codex-source session; pre-meta lines dropped', () => {
  const ops = parseFixture()
  const start = ops.find(o => o.op === 'session.start') as any
  expect(start).toMatchObject({ sessionId: 'cx1', source: 'codex', project: 'proj-x' })
  expect(start.meta).toMatchObject({ model_provider: 'openai', cli_version: '0.142.0' })
  // the pre-meta user message must not have produced an event
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'message.user')).toHaveLength(1)
})

test('turns become llm spans: t1 closed by next turn_context, t2 by task_complete', () => {
  const ops = parseFixture()
  const starts = ops.filter(o => o.op === 'span.start' && (o as any).kind === 'llm') as any[]
  expect(starts.map(s => s.id)).toContain('llm:t1')
  expect(starts.map(s => s.id)).toContain('llm:t2')
  expect(starts.find(s => s.id === 'llm:t1')!.name).toBe('gpt-5.4')
  const ends = ops.filter(o => o.op === 'span.end' && (o as any).id.startsWith('llm:')) as any[]
  expect(ends.map(e => e.id).sort()).toEqual(['llm:t1', 'llm:t2'])
})

test('function calls become tool spans joined by call_id, status from exit code', () => {
  const ops = parseFixture()
  const aaa = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:call_aaa') as any
  expect(aaa).toMatchObject({ kind: 'tool', name: 'exec_command' })
  expect(aaa.attrs.input).toMatchObject({ cmd: 'ls' })
  expect((ops.find(o => o.op === 'span.end' && (o as any).id === 'tool:call_aaa') as any).status).toBe('ok')
  expect((ops.find(o => o.op === 'span.end' && (o as any).id === 'tool:call_bbb') as any).status).toBe('error')
})

test('web_search_call becomes a completed tool span', () => {
  const ops = parseFixture()
  const ws = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:ws_123') as any
  expect(ws).toMatchObject({ kind: 'tool', name: 'web_search' })
  expect(ws.attrs.input).toMatchObject({ query: 'bun docs' })
  expect(ops.some(o => o.op === 'span.end' && (o as any).id === 'tool:ws_123')).toBe(true)
})

test('token counts accumulate per turn onto the llm span, info-null skipped', () => {
  const ops = parseFixture()
  const merges = ops.filter(o => o.op === 'span.start' && (o as any).id === 'llm:t1') as any[]
  const last = merges[merges.length - 1]
  expect(last.attrs).toMatchObject({ input_tokens: 1000, output_tokens: 50 })
  const t2merge = ops.filter(o => o.op === 'span.start' && (o as any).id === 'llm:t2') as any[]
  expect(t2merge[t2merge.length - 1].attrs).toMatchObject({ input_tokens: 2000, output_tokens: 100 })
})

test('messages: one event per user/assistant message, event_msg duplicates and developer role skipped', () => {
  const ops = parseFixture()
  const msgs = ops.filter(o => o.op === 'event' && ((o as any).type === 'message.user' || (o as any).type === 'message.assistant')) as any[]
  expect(msgs).toHaveLength(2)
  expect(msgs[0].attrs.preview).toBe('list the files in this repo')
  expect(msgs[1].attrs.preview).toBe('Two entries: README.md and src.')
})

test('turn boundary events: turn.context per turn, turn.stop on task_complete', () => {
  const ops = parseFixture()
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'turn.context')).toHaveLength(2)
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'turn.stop')).toHaveLength(1)
})

test('garbage, unknown types, and skip-listed lines yield nothing', () => {
  const state = newCodexState()
  expect(parseCodexLine('not json', state)).toEqual([])
  expect(parseCodexLine('{"type":"weird_future_type","payload":{}}', state)).toEqual([])
})

test('older rollouts with id but no session_id still start a session', () => {
  const state = newCodexState()
  const ops = parseCodexLine(JSON.stringify({
    timestamp: '2026-03-29T12:00:00.000Z', type: 'session_meta',
    payload: { id: 'old1', cwd: '/home/dev/legacy', originator: 'codex_cli_rs', cli_version: '0.117.0', source: 'cli', model_provider: 'openai' },
  }), state)
  expect((ops[0] as any)).toMatchObject({ op: 'session.start', sessionId: 'old1', source: 'codex', project: 'legacy' })
  expect(state.sessionId).toBe('old1')
})

test('reviveCodexState round-trips and defaults malformed fields', () => {
  const s = newCodexState()
  s.sessionId = 'cx1'; s.openTurnId = 't1'; s.turnIn = 5
  expect(reviveCodexState(JSON.parse(JSON.stringify(s)))).toEqual(s)
  expect(reviveCodexState({ sessionId: 42 })).toEqual(newCodexState())
})

test('codexParser.finalize closes an open turn at maxTs, nothing when none open', () => {
  const s = newCodexState()
  s.sessionId = 'cx1'; s.openTurnId = 't9'
  expect(codexParser.finalize!(s, 12345)).toEqual([{ op: 'span.end', id: 'llm:t9', ts: 12345, status: 'ok' }])
  expect(codexParser.finalize!(newCodexState(), 12345)).toEqual([])
})

test('main-file event ids are byte-identical to the pre-salt scheme', () => {
  const state = newCodexState()
  parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'cxm', id: 'cxm', cwd: '/home/dev/p' } }), state)
  const ops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }), state)
  expect((ops[0] as any).id).toBe(`evt:msg:cxm:${Date.parse('2026-07-09T10:00:01.000Z')}:user`)
})

test('subagent-thread event ids are salted with the thread id', () => {
  const state = newCodexState()
  parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'cxm', id: 'thread-42', cwd: '/home/dev/p' } }), state)
  const ops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }), state)
  expect((ops[0] as any).id).toBe(`evt:msg:cxm:thread-42:${Date.parse('2026-07-09T10:00:01.000Z')}:assistant`)
  const stops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }), state)
  expect((stops[0] as any).id).toBe(`evt:stop:cxm:thread-42:${Date.parse('2026-07-09T10:00:02.000Z')}`)
})

test('codex session.start carries cwd', () => {
  const state = newCodexState()
  const ops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'cxc', id: 'cxc', cwd: '/home/dev/somewhere' } }), state)
  expect((ops[0] as any).cwd).toBe('/home/dev/somewhere')
})
