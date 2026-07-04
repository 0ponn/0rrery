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
