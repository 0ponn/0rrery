import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
