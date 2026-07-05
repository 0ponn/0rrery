import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'

test('fixture transcript → import → query shows full trace', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))

  const fixture = new URL('../packages/claude-code/fixtures/fix1.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  const r = await importSession(fixture, srv.url)
  expect(r.emitted).toBe(true)
  expect(r.files).toBe(2)  // session + one subagent file

  const sessions = await (await fetch(`${srv.url}/api/sessions`)).json()
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ id: 'fix1', project: 'myproj', source: 'claude-code' })

  const detail = await (await fetch(`${srv.url}/api/sessions/fix1`)).json()
  const kinds = detail.spans.map((s: any) => s.kind).sort()
  expect(kinds).toEqual(['agent', 'llm', 'llm', 'llm', 'llm', 'tool', 'tool', 'tool'])

  const agent = detail.spans.find((s: any) => s.id === 'agent:a1b2c3d4e5')
  expect(agent).toMatchObject({ parent_id: 'tool:toolu_ag1', kind: 'agent', name: 'general-purpose' })
  expect(agent.ended_at).not.toBeNull()

  const subLlm = detail.spans.find((s: any) => s.id === 'llm:msg_a1')
  expect(subLlm.parent_id).toBe('agent:a1b2c3d4e5')

  const types = detail.events.map((e: any) => e.type).sort()
  expect(types).toEqual(['message.assistant', 'message.assistant', 'message.user', 'message.user', 'permission.resolved', 'session.compact', 'session.compact_summary'])

  const denied = detail.spans.find((s: any) => s.id === 'tool:toolu_dn1')
  expect(denied).toMatchObject({ status: 'error', ended_at: Date.parse('2026-07-04T12:00:09.000Z') })

  srv.stop()
})
