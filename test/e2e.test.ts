import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'
import { importTranscript } from '@0rrery/claude-code'

test('fixture transcript → import → query shows full trace', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))

  const fixture = new URL('../packages/claude-code/fixtures/session.jsonl', import.meta.url).pathname
  const r = await importTranscript(fixture, srv.url)
  expect(r.emitted).toBe(true)
  expect(r.ops).toBeGreaterThan(0)

  const sessions = await (await fetch(`${srv.url}/api/sessions`)).json()
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ id: 'fix1', project: 'myproj', source: 'claude-code' })

  const detail = await (await fetch(`${srv.url}/api/sessions/fix1`)).json()
  const kinds = detail.spans.map((s: any) => s.kind).sort()
  expect(kinds).toEqual(['llm', 'tool'])
  expect(detail.events.map((e: any) => e.type).sort()).toEqual(['message.assistant', 'message.user'])
  srv.stop()
})
