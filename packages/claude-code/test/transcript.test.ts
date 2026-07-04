import { test, expect } from 'bun:test'
import { parseTranscriptLine, newTranscriptState } from '../src/transcript'

const lines = (await Bun.file(new URL('../fixtures/session.jsonl', import.meta.url)).text()).split('\n').filter(Boolean)

test('fixture parses into expected ops', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))

  const start = ops.find(o => o.op === 'session.start') as any
  expect(start).toMatchObject({ sessionId: 'fix1', source: 'claude-code', project: 'myproj', cwd: '/home/dev/myproj', gitBranch: 'main' })
  expect(start.ts).toBe(Date.parse('2026-07-04T12:00:00.000Z'))
  expect(ops.filter(o => o.op === 'session.start')).toHaveLength(1)  // only once per file

  const userEvt = ops.find(o => o.op === 'event' && (o as any).type === 'message.user') as any
  expect(userEvt.attrs.preview).toBe('list the files')

  const llm = ops.find(o => o.op === 'span.start' && (o as any).kind === 'llm') as any
  expect(llm).toMatchObject({ id: 'llm:msg_01', name: 'claude-fable-5' })
  expect(llm.attrs).toMatchObject({ input_tokens: 100, output_tokens: 20 })
  const llmEnd = ops.find(o => o.op === 'span.end' && (o as any).id === 'llm:msg_01')
  expect(llmEnd).toBeDefined()

  const tool = ops.find(o => o.op === 'span.start' && (o as any).kind === 'tool') as any
  expect(tool).toMatchObject({ id: 'tool:toolu_01', name: 'Bash' })

  const asstEvt = ops.find(o => o.op === 'event' && (o as any).type === 'message.assistant') as any
  expect(asstEvt.attrs.preview).toBe('Listing files now.')

  // tool_result user line and ai-title and garbage produce nothing extra
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'message.user')).toHaveLength(1)
})

test('garbage line yields []', () => {
  expect(parseTranscriptLine('not json', newTranscriptState())).toEqual([])
})

test('malformed timestamp falls back to a valid ts', () => {
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u9', timestamp: 'not-a-date', cwd: '/p/x', sessionId: 'ts1' })
  const ops = parseTranscriptLine(line, newTranscriptState())
  expect(ops.length).toBeGreaterThan(0)
  for (const op of ops) expect(Number.isInteger((op as any).ts)).toBe(true)
})

const agentLines = (await Bun.file(new URL('../fixtures/fix1/subagents/agent-a1b2c3d4e5.jsonl', import.meta.url)).text()).split('\n').filter(Boolean)

test('agent file: agent span, parenting, no session.start, attributed events', () => {
  const state = newTranscriptState()
  const ops = agentLines.flatMap(l => parseTranscriptLine(l, state))
  expect(ops.filter(o => o.op === 'session.start')).toHaveLength(0)
  const llm = ops.find(o => o.op === 'span.start' && (o as any).kind === 'llm') as any
  expect(llm).toMatchObject({ id: 'llm:msg_a1', parentId: 'agent:a1b2c3d4e5' })
  const userEvt = ops.find(o => o.op === 'event' && (o as any).type === 'message.user') as any
  expect(userEvt.attrs.agentId).toBe('a1b2c3d4e5')
  expect(state.agentId).toBe('a1b2c3d4e5')
  // first line lacks attributionAgent → placeholder emitted, then upgraded by second line
  const starts = ops.filter(o => o.op === 'span.start' && (o as any).id === 'agent:a1b2c3d4e5') as any[]
  expect(starts).toHaveLength(2)
  expect(starts[0]).toMatchObject({ id: 'agent:a1b2c3d4e5', sessionId: 'fix1', name: '(unknown)', parentId: null })
  expect(starts[0].ts).toBe(Date.parse('2026-07-04T12:00:03.000Z'))
  expect(starts[1]).toMatchObject({ name: 'general-purpose', ts: Date.parse('2026-07-04T12:00:03.000Z') })
})

test('Agent tool_result links the agent span under the spawning tool span', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))
  const link = ops.find(o => o.op === 'span.start' && (o as any).id === 'agent:a1b2c3d4e5') as any
  expect(link).toMatchObject({ parentId: 'tool:toolu_ag1', kind: 'agent', name: '(unknown)', sessionId: 'fix1' })
})

test('compact_boundary → session.compact with metadata', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))
  const c = ops.find(o => o.op === 'event' && (o as any).type === 'session.compact') as any
  expect(c).toMatchObject({ id: 'evt:compact:u6', attrs: { trigger: 'auto', preTokens: 150000, durationMs: 21000 } })
})

test('isCompactSummary suppresses message.user and emits session.compact_summary', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'message.user')).toHaveLength(1)  // still just 'list the files'
  const s = ops.find(o => o.op === 'event' && (o as any).type === 'session.compact_summary') as any
  expect(s.attrs.preview).toContain('continued from a previous conversation')
})
