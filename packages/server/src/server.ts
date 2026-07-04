import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseOps, type IngestOp, type Rejected } from '@0rrery/schema'
import { Store } from './store'
import { listSessions, getSessionDetail, getStats, type SessionFilter } from './queries'
import { LiveBus } from './livebus'
import type { Config } from './config'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const numParam = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

const effectiveStatus = (s: { status: string; last_event_at: number }, now: number, staleAfterMs: number) =>
  s.status === 'ended' ? 'ended' : s.last_event_at >= now - staleAfterMs ? 'active' : 'stale'

export function startServer(config: Config) {
  mkdirSync(config.dataDir, { recursive: true })
  const store = new Store(config.dbPath)
  const bus = new LiveBus()
  store.sweep(config.retentionDays)

  const deadLetter = (rejected: Rejected[]) => {
    if (rejected.length === 0) return
    const lines = rejected.map(r => JSON.stringify({ ts: Date.now(), error: r.error, raw: r.raw })).join('\n') + '\n'
    try { appendFileSync(join(config.dataDir, 'dead-letter.jsonl'), lines) } catch (e) { console.error('0rrery: dead-letter write failed', e) }
  }

  type WsData = { unsub: () => void; session: string }
  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname
      const qopts = { now: Date.now(), staleAfterMs: config.staleAfterMs }

      if (path === '/api/live') {
        const session = url.searchParams.get('session') ?? '*'
        if (srv.upgrade(req, { data: { session, unsub: () => {} } })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      }

      try {
        if (path === '/api/ingest' && req.method === 'POST') {
          if (config.authToken && req.headers.get('authorization') !== `Bearer ${config.authToken}`) {
            return json({ error: 'unauthorized' }, 401)
          }
          let body: unknown
          try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
          const { ok, rejected } = parseOps(body)
          deadLetter(rejected)
          if (ok.length > 0) { store.applyOps(ok); bus.publish(ok) }
          return json({ accepted: ok.length, rejected })
        }

        if (path === '/api/sessions' && req.method === 'GET') {
          const f: SessionFilter = {
            project: url.searchParams.get('project') ?? undefined,
            status: (url.searchParams.get('status') as SessionFilter['status']) ?? undefined,
            limit: numParam(url.searchParams.get('limit')),
            offset: numParam(url.searchParams.get('offset')),
          }
          return json(listSessions(store.db, f, qopts).map(s => ({ ...s, effectiveStatus: effectiveStatus(s, qopts.now, config.staleAfterMs) })))
        }

        const m = path.match(/^\/api\/sessions\/([^/]+)$/)
        if (m && req.method === 'GET') {
          const detail = getSessionDetail(store.db, decodeURIComponent(m[1]))
          return detail
            ? json({ ...detail, session: { ...detail.session, effectiveStatus: effectiveStatus(detail.session, qopts.now, config.staleAfterMs) } })
            : json({ error: 'not found' }, 404)
        }

        if (path === '/api/stats' && req.method === 'GET') return json(getStats(store.db, qopts))

        if (path.startsWith('/api/')) return json({ error: 'not found' }, 404)

        if (config.dashboardDist) {
          const filePath = join(config.dashboardDist, path === '/' ? 'index.html' : path)
          const file = Bun.file(filePath)
          if (await file.exists()) return new Response(file)
          return new Response(Bun.file(join(config.dashboardDist, 'index.html')))
        }
        return json({ error: 'dashboard not built; API only' }, 503)
      } catch (e) {
        console.error('0rrery: request failed', e)
        return json({ error: 'internal error' }, 500)
      }
    },
    websocket: {
      open(ws) {
        const data = ws.data as WsData
        data.unsub = bus.subscribe(data.session, (ops: IngestOp[]) => {
          try { ws.send(JSON.stringify(ops)) } catch {}
        })
      },
      close(ws) { (ws.data as WsData).unsub() },
      message() {},
    },
  })

  return {
    url: `http://${config.host}:${server.port}`,
    store, bus,
    stop() { server.stop(true); store.close() },
  }
}
