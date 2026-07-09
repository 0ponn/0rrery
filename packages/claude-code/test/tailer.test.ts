import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTailer } from '../src/tailer'

test('tailer discovers session files and subagent files', async () => {
  const batches: any[][] = []
  const srv = Bun.serve({ port: 0, async fetch(req) { batches.push(await req.json()); return new Response('{"accepted":1,"rejected":[]}') } })
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tail-'))
  const proj = join(projects, '-home-x-proj')
  const subDir = join(proj, 'sess1', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(proj, 'sess1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: '2026-07-04T12:00:00.000Z', cwd: '/x/proj', sessionId: 'sess1' }) + '\n')
  writeFileSync(join(subDir, 'agent-a1b2c3d4e5.jsonl'), JSON.stringify({ isSidechain: true, agentId: 'a1b2c3d4e5', attributionAgent: 'Explore', type: 'user', message: { role: 'user', content: 'go' }, uuid: 'au1', timestamp: '2026-07-04T12:00:01.000Z', cwd: '/x/proj', sessionId: 'sess1' }) + '\n')

  const tailer = startTailer(projects, `http://localhost:${srv.port}`, 100)
  await Bun.sleep(400)
  tailer.stop()
  srv.stop(true)

  const all = batches.flat()
  expect(all.some((o: any) => o.op === 'session.start' && o.sessionId === 'sess1')).toBe(true)
  expect(all.some((o: any) => o.op === 'span.start' && o.id === 'agent:a1b2c3d4e5')).toBe(true)
})

function mockIngestCounting() {
  const batches: any[][] = []
  const srv = Bun.serve({ port: 0, async fetch(req) { batches.push(await req.json()); return new Response('{"accepted":1,"rejected":[]}') } })
  return { batches, url: `http://localhost:${srv.port}`, stop: () => srv.stop(true) }
}

const line = (n: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: `msg ${n}` }, uuid: `u${n}`, timestamp: '2026-07-04T12:00:00.000Z', cwd: '/x/proj', sessionId: 'persist1' }) + '\n'

test('offsets persist across tailer restarts: no re-ingest, increments only, truncation resets', async () => {
  const m1 = mockIngestCounting()
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tailp-'))
  const proj = join(projects, '-home-x-proj')
  mkdirSync(proj, { recursive: true })
  const file = join(proj, 'persist1.jsonl')
  writeFileSync(file, line(1))
  const offsetsPath = join(projects, 'tailer-offsets.json')

  // first run ingests, snapshot written
  const t1 = startTailer(projects, m1.url, 100, offsetsPath)
  await Bun.sleep(400)
  t1.stop(); m1.stop()
  expect(m1.batches.flat().some((o: any) => o.type === 'message.user')).toBe(true)

  // second run, unchanged file: ZERO posts
  const m2 = mockIngestCounting()
  const t2 = startTailer(projects, m2.url, 100, offsetsPath)
  await Bun.sleep(400)
  t2.stop(); m2.stop()
  expect(m2.batches).toHaveLength(0)

  // third run after appending one line: only the increment arrives
  appendFileSync(file, line(2))
  const m3 = mockIngestCounting()
  const t3 = startTailer(projects, m3.url, 100, offsetsPath)
  await Bun.sleep(400)
  t3.stop(); m3.stop()
  const previews3 = m3.batches.flat().filter((o: any) => o.type === 'message.user').map((o: any) => o.attrs.preview)
  expect(previews3).toEqual(['msg 2'])

  // fourth run after truncate+rewrite: full re-ingest of new content
  writeFileSync(file, line(9))
  const m4 = mockIngestCounting()
  const t4 = startTailer(projects, m4.url, 100, offsetsPath)
  await Bun.sleep(400)
  t4.stop(); m4.stop()
  const previews4 = m4.batches.flat().filter((o: any) => o.type === 'message.user').map((o: any) => o.attrs.preview)
  expect(previews4).toEqual(['msg 9'])
})

test('omitted offsetsPath stays in-memory: restart re-ingests (existing behavior)', async () => {
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tailm-'))
  const proj = join(projects, '-home-x-proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'mem1.jsonl'), line(1).replace(/persist1/g, 'mem1'))
  const m1 = mockIngestCounting()
  const t1 = startTailer(projects, m1.url, 100)
  await Bun.sleep(300)
  t1.stop(); m1.stop()
  const m2 = mockIngestCounting()
  const t2 = startTailer(projects, m2.url, 100)
  await Bun.sleep(300)
  t2.stop(); m2.stop()
  expect(m2.batches.length).toBeGreaterThan(0)  // no snapshot → re-ingest, as today
})

test('truncation reset is persisted even when re-ingest cannot advance', async () => {
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tailt-'))
  const proj = join(projects, '-home-x-proj')
  mkdirSync(proj, { recursive: true })
  const file = join(proj, 'trunc1.jsonl')
  writeFileSync(file, line(1).replace(/persist1/g, 'trunc1'))
  const offsetsPath = join(projects, 'tailer-offsets.json')
  const m1 = mockIngestCounting()
  const t1 = startTailer(projects, m1.url, 100, offsetsPath)
  await Bun.sleep(300)
  t1.stop(); m1.stop()
  // truncate to a partial line (no newline) so re-ingest cannot advance, with the server DOWN
  writeFileSync(file, '{"partial')
  const t2 = startTailer(projects, 'http://localhost:1', 100, offsetsPath)
  await Bun.sleep(300)
  t2.stop()
  const { loadOffsets, reviveState } = await import('../src/offsets')
  expect(loadOffsets(offsetsPath, reviveState).get(file)!.offset).toBe(0)  // reset was flushed despite no ingest
})
