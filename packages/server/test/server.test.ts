import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server'
import { loadConfig } from '../src/config'

function boot(extra: Parameters<typeof loadConfig>[0] = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-'))
  return startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir, ...extra }))
}

const ops = [
  { op: 'session.start', sessionId: 's1', source: 'api', project: 'p', ts: 1 },
  { op: 'span.start', id: 'sp1', sessionId: 's1', kind: 'tool', name: 'Bash', ts: 2 },
]

test('ingest → query round trip, bad items dead-lettered', async () => {
  const srv = boot()
  const res = await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify([...ops, { op: 'nope' }]) })
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.accepted).toBe(2)
  expect(body.rejected).toHaveLength(1)

  const list = await (await fetch(`${srv.url}/api/sessions`)).json()
  expect(list).toHaveLength(1)
  const detail = await (await fetch(`${srv.url}/api/sessions/s1`)).json()
  expect(detail.spans).toHaveLength(1)
  expect((await fetch(`${srv.url}/api/sessions/nope`)).status).toBe(404)
  const stats = await (await fetch(`${srv.url}/api/stats`)).json()
  expect(stats.sessions).toBe(1)
  srv.stop()
})

test('auth token gates ingest when configured', async () => {
  const srv = boot({ authToken: 'sekrit' })
  expect((await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: '[]' })).status).toBe(401)
  const ok = await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: '[]', headers: { Authorization: 'Bearer sekrit' } })
  expect(ok.status).toBe(200)
  srv.stop()
})

test('unknown /api/ path 404s as JSON', async () => {
  const srv = boot()
  const res = await fetch(`${srv.url}/api/nope`)
  expect(res.status).toBe(404)
  expect((await res.json()).error).toBeDefined()
  srv.stop()
})

test('malformed limit/offset degrade gracefully', async () => {
  const srv = boot()
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify(ops) })
  const res = await fetch(`${srv.url}/api/sessions?limit=abc&offset=-2`)
  expect(res.status).toBe(200)
  expect(await res.json()).toHaveLength(1)
  const frac = await fetch(`${srv.url}/api/sessions?limit=1.5`)
  expect(frac.status).toBe(200)
  expect(await frac.json()).toHaveLength(1)
  srv.stop()
})

test('empty from/to params are treated as absent, not epoch-0', async () => {
  const srv = boot()
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify([
    { op: 'session.start', sessionId: 's1', source: 'api', ts: 1000 },
    { op: 'session.start', sessionId: 's2', source: 'api', ts: 2000 },
  ]) })
  // from='' must not be treated as a defined filter (from=0) — that would route to
  // searchSessions, which ignores offset, and silently break `?from=&offset=`.
  const res = await fetch(`${srv.url}/api/sessions?from=&offset=1&limit=1`)
  expect(res.status).toBe(200)
  const rows = await res.json()
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe('s1')
  srv.stop()
})

test('session intervals: span timestamps segmented at the 30-min gap', async () => {
  const srv = boot()
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify([
    { op: 'session.start', sessionId: 'iv', source: 'api', project: 'p', ts: 1000 },
    { op: 'span.start', id: 'a', sessionId: 'iv', kind: 'tool', name: 'Bash', ts: 1000 },
    { op: 'span.start', id: 'b', sessionId: 'iv', kind: 'tool', name: 'Bash', ts: 301000 },   // +5min: same interval
    { op: 'span.start', id: 'c', sessionId: 'iv', kind: 'tool', name: 'Bash', ts: 5401000 },  // +90min: new interval
  ]) })
  const iv = await (await fetch(`${srv.url}/api/sessions/iv/intervals`)).json()
  expect(iv).toEqual([
    { start: 1000, end: 301000, spanCount: 2 },
    { start: 5401000, end: 5401000, spanCount: 1 },
  ])
  // a wider gap merges everything into one interval
  const one = await (await fetch(`${srv.url}/api/sessions/iv/intervals?gap=120`)).json()
  expect(one).toHaveLength(1)
  expect(one[0].spanCount).toBe(3)
  // unknown session 404s; a malformed gap 400s
  expect((await fetch(`${srv.url}/api/sessions/nope/intervals`)).status).toBe(404)
  expect((await fetch(`${srv.url}/api/sessions/iv/intervals?gap=-1`)).status).toBe(400)
  srv.stop()
})

test('websocket live delivers ingested ops', async () => {
  const srv = boot()
  const wsUrl = srv.url.replace('http', 'ws') + '/api/live?session=*'
  const ws = new WebSocket(wsUrl)
  const got: any[] = []
  const gotBatch = new Promise<void>(done => {
    ws.onmessage = e => { got.push(...JSON.parse(e.data as string)); done() }
  })
  await new Promise<void>(r => { ws.onopen = () => r() })
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify(ops) })
  await gotBatch
  expect(got).toHaveLength(2)
  expect(got[0].sessionId).toBe('s1')
  ws.close()
  srv.stop()
})

test('sessions carry effectiveStatus; stale filter works end-to-end', async () => {
  const srv = boot()
  const now = Date.now()
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify([
    { op: 'session.start', sessionId: 'live1', source: 'api', ts: now },
    { op: 'session.start', sessionId: 'old1', source: 'api', ts: now - 90 * 86400_000 + 86400_000 },  // old but inside retention
  ]) })
  const all = await (await fetch(`${srv.url}/api/sessions`)).json()
  const byId = Object.fromEntries(all.map((s: any) => [s.id, s.effectiveStatus]))
  expect(byId.live1).toBe('active')
  expect(byId.old1).toBe('stale')
  const stale = await (await fetch(`${srv.url}/api/sessions?status=stale`)).json()
  expect(stale.map((s: any) => s.id)).toEqual(['old1'])
  const detail = await (await fetch(`${srv.url}/api/sessions/old1`)).json()
  expect(detail.session.effectiveStatus).toBe('stale')
  const stats = await (await fetch(`${srv.url}/api/stats`)).json()
  expect(stats.activeSessions).toBe(1)
  expect(stats.staleSessions).toBe(1)
  srv.stop()
})
