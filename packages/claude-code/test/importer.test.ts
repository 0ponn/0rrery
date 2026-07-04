import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importTranscript } from '../src/importer'
import { newTranscriptState } from '../src/transcript'

function mockIngest() {
  const batches: any[][] = []
  const srv = Bun.serve({ port: 0, async fetch(req) { batches.push(await req.json()); return new Response('{"accepted":1,"rejected":[]}') } })
  return { batches, url: `http://localhost:${srv.port}`, stop: () => srv.stop(true) }
}

const line1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: '2026-07-04T12:00:00.000Z', cwd: '/p/x', sessionId: 'imp1', gitBranch: 'main' })
const line2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' }, uuid: 'u2', timestamp: '2026-07-04T12:00:05.000Z', cwd: '/p/x', sessionId: 'imp1', gitBranch: 'main' })

test('imports full file, then only the increment on second call', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')

  const state = newTranscriptState()
  const r1 = await importTranscript(file, url, 0, state)
  expect(r1.emitted).toBe(true)
  expect(r1.ops).toBe(2)  // session.start + message.user
  expect(batches).toHaveLength(1)

  appendFileSync(file, line2 + '\n')
  const r2 = await importTranscript(file, url, r1.bytesRead, state)
  expect(r2.ops).toBe(1)  // only the new message.user
  expect(batches).toHaveLength(2)
  expect(batches[1]).toHaveLength(1)
  stop()
})

test('partial trailing line is not consumed', async () => {
  const { url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n' + line2.slice(0, 20))  // second line incomplete, no newline
  const r = await importTranscript(file, url, 0, newTranscriptState())
  expect(r.ops).toBe(2)
  expect(r.bytesRead).toBe(Buffer.byteLength(line1 + '\n'))
  stop()
})

test('emit failure does not advance offset or corrupt state', async () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')
  const state = newTranscriptState()
  const fail = await importTranscript(file, 'http://localhost:1', 0, state)
  expect(fail.emitted).toBe(false)
  expect(fail.bytesRead).toBe(0)
  // retry against a live server must re-emit everything incl. session.start
  const { batches, url, stop } = mockIngest()
  const ok = await importTranscript(file, url, fail.bytesRead, state)
  expect(ok.emitted).toBe(true)
  expect(ok.ops).toBe(2)
  expect(batches[0].some((o: any) => o.op === 'session.start')).toBe(true)
  stop()
})

test('finalize appends a session.end with the max ts seen', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n' + line2 + '\n')
  const r = await importTranscript(file, url, 0, newTranscriptState(), true)
  expect(r.emitted).toBe(true)
  const last = batches[0][batches[0].length - 1]
  expect(last.op).toBe('session.end')
  expect(last.sessionId).toBe('imp1')
  expect(last.ts).toBe(Date.parse('2026-07-04T12:00:05.000Z'))
  stop()
})

test('finalize with zero parsed ops does not append session.end', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')
  const state = newTranscriptState()
  const r1 = await importTranscript(file, url, 0, state)
  const r2 = await importTranscript(file, url, r1.bytesRead, state, true)
  expect(r2.ops).toBe(0)
  expect(batches).toHaveLength(1)  // finalize made no extra call since no ops were parsed
  stop()
})

test('non-finalize path (default) does not append session.end', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')
  await importTranscript(file, url, 0, newTranscriptState())
  expect(batches[0].some((o: any) => o.op === 'session.end')).toBe(false)
  stop()
})

test('empty increment emits nothing and succeeds', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')
  const r1 = await importTranscript(file, url, 0, newTranscriptState())
  const r2 = await importTranscript(file, url, r1.bytesRead, newTranscriptState())
  expect(r2.ops).toBe(0)
  expect(r2.emitted).toBe(true)
  expect(batches).toHaveLength(1)
  stop()
})

const agentLine = JSON.stringify({ isSidechain: true, agentId: 'a1b2c3d4e5', attributionAgent: 'general-purpose', type: 'assistant', message: { model: 'm', id: 'msg_x', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'ax1', timestamp: '2026-07-04T12:00:09.000Z', cwd: '/p/x', sessionId: 'imp2' })

test('agent file import appends a ratcheting agent span.end', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 'agent-a1b2c3d4e5.jsonl')
  writeFileSync(file, agentLine + '\n')
  await importTranscript(file, url, 0, newTranscriptState())
  const ops = batches[0]
  const end = ops.filter((o: any) => o.op === 'span.end' && o.id === 'agent:a1b2c3d4e5')
  expect(end).toHaveLength(1)
  expect(end[0].ts).toBe(Date.parse('2026-07-04T12:00:09.000Z'))
  expect(ops.some((o: any) => o.op === 'session.end')).toBe(false)  // agent files never finalize sessions
  stop()
})

test('failed emit restores ALL state fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 'agent-a1b2c3d4e5.jsonl')
  writeFileSync(file, agentLine + '\n')
  const state = newTranscriptState()
  const r = await importTranscript(file, 'http://localhost:1', 0, state)
  expect(r.emitted).toBe(false)
  expect(state).toEqual(newTranscriptState())
})

test('importSession short-circuits on failed main emit, leaving subagent files untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  writeFileSync(join(dir, 's10.jsonl'), line1.replace(/imp1/g, 's10') + '\n')
  const subDir = join(dir, 's10', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(subDir, 'agent-a1b2c3d4e5.jsonl'), agentLine.replace(/imp2/g, 's10') + '\n')
  const { importSession } = await import('../src/importer')
  const r = await importSession(join(dir, 's10.jsonl'), 'http://localhost:1')
  expect(r.files).toBe(1)
  expect(r.emitted).toBe(false)
})

test('importSession imports main file plus subagents dir, finalize on main only', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  writeFileSync(join(dir, 's9.jsonl'), line1.replace(/imp1/g, 's9') + '\n')
  const subDir = join(dir, 's9', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(subDir, 'agent-a1b2c3d4e5.jsonl'), agentLine.replace(/imp2/g, 's9') + '\n')
  const { importSession } = await import('../src/importer')
  const r = await importSession(join(dir, 's9.jsonl'), url, { finalize: true })
  expect(r.files).toBe(2)
  expect(r.emitted).toBe(true)
  const all = batches.flat()
  expect(all.filter((o: any) => o.op === 'session.end')).toHaveLength(1)
  expect(all.some((o: any) => o.op === 'span.start' && o.id === 'agent:a1b2c3d4e5')).toBe(true)
  stop()
})
