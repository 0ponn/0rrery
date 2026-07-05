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

  for (const id of ['tool:toolu_01', 'tool:toolu_ag1']) {
    const t = detail.spans.find((s: any) => s.id === id)
    expect(t).toMatchObject({ status: 'ok' })
    expect(t.ended_at).not.toBeNull()
  }

  srv.stop()
})

test('insights endpoints answer over imported fixture data', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-ins-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))
  const fixture = new URL('../packages/claude-code/fixtures/fix1.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  await importSession(fixture, srv.url, { finalize: true })

  const get = (p: string) => fetch(`${srv.url}${p}`).then(r => r.json() as any)
  const spend = await get('/api/insights/spend')
  expect(spend.length).toBeGreaterThan(0)
  expect(spend[0]).toHaveProperty('est_cost')

  const health = await get('/api/insights/tool-health')
  expect(health.find((t: any) => t.name === 'Bash')?.denials).toBe(1)  // the fixture denial

  const projects = await get('/api/insights/projects')
  expect(projects.find((p: any) => p.project === 'myproj')?.sessions).toBe(1)

  const sprawl = await get('/api/insights/sprawl')
  expect(sprawl.nodes.some((n: any) => n.id === 'main')).toBe(true)
  expect(sprawl.edges.length).toBeGreaterThan(0)

  expect(await get('/api/insights/surface')).toHaveProperty('domains')
  expect(await get('/api/insights/footprint')).toHaveProperty('dirs')

  // filters + search + validation
  const none = await get('/api/insights/spend?project=nope')
  expect(none).toEqual([])
  const found = await fetch(`${srv.url}/api/sessions?q=list the files`).then(r => r.json() as any)
  expect(found.map((s: any) => s.id)).toContain('fix1')
  const bad = await fetch(`${srv.url}/api/insights/spend?from=banana`)
  expect(bad.status).toBe(400)

  srv.stop()
})

test('session summary endpoint is compact and 404s unknowns', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-sum-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))
  const fixture = new URL('../packages/claude-code/fixtures/fix1.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  await importSession(fixture, srv.url, { finalize: true })

  const r = await fetch(`${srv.url}/api/sessions/fix1/summary`)
  expect(r.status).toBe(200)
  const s = await r.json() as any
  expect(s.project).toBe('myproj')
  expect(s.denials).toBe(1)
  expect(s.models.length).toBeGreaterThan(0)
  expect(s.first_user_message).toBeTruthy()
  expect(JSON.stringify(s).length).toBeLessThan(2000)  // the whole point: compact

  expect((await fetch(`${srv.url}/api/sessions/nope/summary`)).status).toBe(404)
  srv.stop()
})
