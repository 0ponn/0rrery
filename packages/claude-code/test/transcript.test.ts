import { test, expect } from 'bun:test'
import { parseTranscriptLine, newTranscriptState } from '../src/transcript'

const lines = (await Bun.file(new URL('../fixtures/fix1.jsonl', import.meta.url)).text()).split('\n').filter(Boolean)

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

test('compact_boundary with missing uuid falls back to a session/ts id, not evt:compact:undefined', () => {
  const state = newTranscriptState()
  const line = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 1, durationMs: 2 }, timestamp: '2026-07-04T12:00:00.000Z', cwd: '/p/x', sessionId: 'nouuid1' })
  const ops = parseTranscriptLine(line, state)
  const c = ops.find(o => o.op === 'event' && (o as any).type === 'session.compact') as any
  expect(c.id).not.toBe('evt:compact:undefined')
  expect(c.id).toBe(`evt:compact:nouuid1:${Date.parse('2026-07-04T12:00:00.000Z')}`)
})

test('linkage regex only fires on Agent tool results', () => {
  const state = newTranscriptState()
  const mk = (name: string, tid: string) => [
    JSON.stringify({ type: 'assistant', message: { id: `m_${tid}`, model: 'x', role: 'assistant', content: [{ type: 'tool_use', id: tid, name, input: {} }], usage: {} }, uuid: `u_${tid}`, timestamp: '2026-07-04T12:00:00.000Z', cwd: '/p/x', sessionId: 'g1' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: tid, type: 'tool_result', content: 'blah agentId: a1b2c3d4e5 blah' }] }, uuid: `r_${tid}`, timestamp: '2026-07-04T12:00:01.000Z', cwd: '/p/x', sessionId: 'g1' }),
  ]
  const ops = [...mk('Read', 'tu_read'), ...mk('Agent', 'tu_agent')].flatMap(l => parseTranscriptLine(l, state))
  const links = ops.filter(o => o.op === 'span.start' && (o as any).kind === 'agent')
  expect(links).toHaveLength(1)
  expect((links[0] as any).parentId).toBe('tool:tu_agent')
})

const denyLine = (tur: unknown) => JSON.stringify({
  type: 'user', toolUseResult: tur,
  message: { role: 'user', content: [{ tool_use_id: 'toolu_dn1', type: 'tool_result', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] },
  uuid: 'ud1', timestamp: '2026-07-05T12:00:00.000Z', cwd: '/p/x', sessionId: 'dn1', gitBranch: 'main',
})

test('user rejection marker emits denial event and closes the span', () => {
  const ops = parseTranscriptLine(denyLine('User rejected tool use'), newTranscriptState())
  const evt = ops.find(o => o.op === 'event' && (o as any).type === 'permission.resolved') as any
  expect(evt).toMatchObject({ id: 'evt:perm:res:toolu_dn1', spanId: 'tool:toolu_dn1', attrs: { outcome: 'denied', source: 'user' } })
  const end = ops.find(o => o.op === 'span.end') as any
  expect(end).toMatchObject({ id: 'tool:toolu_dn1', status: 'error', attrs: { denied: true } })
})

test('ordinary error toolUseResult strings emit a generic end, no denial ops', () => {
  for (const tur of ['Error: Exit code 1', 'Error: File has not been read yet. Read it first before writing to it.', { stdout: 'x' }, undefined]) {
    const ops = parseTranscriptLine(denyLine(tur), newTranscriptState())
    expect(ops.some(o => o.op === 'event' && (o as any).type === 'permission.resolved')).toBe(false)
    const end = ops.find(o => o.op === 'span.end') as any
    expect(end).toMatchObject({ id: 'tool:toolu_dn1', status: 'error' })
    expect((end.attrs ?? {}).denied).toBeUndefined()
  }
})

test('denial blocks without tool_use_id emit nothing', () => {
  const l = JSON.stringify({ type: 'user', toolUseResult: 'User rejected tool use', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'rejected' }] }, uuid: 'ud2', timestamp: '2026-07-05T12:00:01.000Z', cwd: '/p/x', sessionId: 'dn1' })
  const ops = parseTranscriptLine(l, newTranscriptState())
  expect(ops.filter(o => o.op !== 'session.start')).toHaveLength(0)
})

test('linkage handles multiple tool_results per line and object content', () => {
  const state = newTranscriptState()
  const setup = JSON.stringify({ type: 'assistant', message: { id: 'm_multi', model: 'x', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_a1', name: 'Agent', input: {} }, { type: 'tool_use', id: 'tu_a2', name: 'Task', input: {} }], usage: {} }, uuid: 'u_multi', timestamp: '2026-07-04T12:00:00.000Z', cwd: '/p/x', sessionId: 'g2' })
  const results = JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { tool_use_id: 'tu_a1', type: 'tool_result', content: [{ type: 'text', text: 'agentId: aaaa111122' }] },
    { tool_use_id: 'tu_a2', type: 'tool_result', content: 'agentId: bbbb33  no wait agentId: acccc44455' },
  ] }, uuid: 'r_multi', timestamp: '2026-07-04T12:00:01.000Z', cwd: '/p/x', sessionId: 'g2' })
  const ops = [setup, results].flatMap(l => parseTranscriptLine(l, state))
  const links = ops.filter(o => o.op === 'span.start' && (o as any).kind === 'agent').map((o: any) => [o.id, o.parentId])
  expect(links).toEqual([['agent:aaaa111122', 'tool:tu_a1'], ['agent:acccc44455', 'tool:tu_a2']])
})

test('transcript tool_use classifies mcp tools as kind mcp', () => {
  const state = newTranscriptState()
  const l = JSON.stringify({ type: 'assistant', message: { id: 'm_mcp', model: 'x', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mcp', name: 'mcp__engram__mem_save', input: {} }, { type: 'tool_use', id: 'tu_plain', name: 'Read', input: {} }], usage: {} }, uuid: 'u_mcp', timestamp: '2026-07-05T12:00:00.000Z', cwd: '/p/x', sessionId: 'k1' })
  const ops = parseTranscriptLine(l, state)
  const mcp = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:tu_mcp') as any
  const plain = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:tu_plain') as any
  expect(mcp.kind).toBe('mcp')
  expect(plain.kind).toBe('tool')
})

const resLine = (blocks: any[]) => JSON.stringify({
  type: 'user', message: { role: 'user', content: blocks },
  uuid: 'ur1', timestamp: '2026-07-05T13:00:00.000Z', cwd: '/p/x', sessionId: 'te1', gitBranch: 'main',
})

test('tool_result closes its tool span with status ok', () => {
  const ops = parseTranscriptLine(resLine([{ tool_use_id: 'toolu_ok1', type: 'tool_result', content: 'done' }]), newTranscriptState())
  const end = ops.find(o => o.op === 'span.end') as any
  expect(end).toMatchObject({ id: 'tool:toolu_ok1', status: 'ok' })
})

test('is_error tool_result closes its span with status error and no denial ops', () => {
  const ops = parseTranscriptLine(resLine([{ tool_use_id: 'toolu_er1', type: 'tool_result', is_error: true, content: 'Error: Exit code 1' }]), newTranscriptState())
  const end = ops.find(o => o.op === 'span.end') as any
  expect(end).toMatchObject({ id: 'tool:toolu_er1', status: 'error' })
  expect((end.attrs ?? {}).denied).toBeUndefined()
  expect(ops.some(o => o.op === 'event' && (o as any).type === 'permission.resolved')).toBe(false)
})

test('one line with two tool_results closes both spans', () => {
  const ops = parseTranscriptLine(resLine([
    { tool_use_id: 'toolu_m1', type: 'tool_result', content: 'a' },
    { tool_use_id: 'toolu_m2', type: 'tool_result', is_error: true, content: 'b' },
  ]), newTranscriptState())
  const ends = ops.filter(o => o.op === 'span.end') as any[]
  expect(ends.map(e => [e.id, e.status])).toEqual([['tool:toolu_m1', 'ok'], ['tool:toolu_m2', 'error']])
})

test('denied blocks get exactly one span.end (the denial one)', () => {
  const ops = parseTranscriptLine(denyLine('User rejected tool use'), newTranscriptState())
  const ends = ops.filter(o => o.op === 'span.end') as any[]
  expect(ends).toHaveLength(1)
  expect(ends[0].attrs).toMatchObject({ denied: true })
})
