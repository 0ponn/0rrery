import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
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
