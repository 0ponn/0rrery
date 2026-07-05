import type { Database } from 'bun:sqlite'
import type { SessionRow, TopoNode, TopoEdge, TopoKind } from '@0rrery/schema'
import { estCost } from './prices'

export type InsightFilter = { project?: string; from?: number; to?: number }

function parseAttrs(attrs: string | null): Record<string, unknown> {
  try { return JSON.parse(attrs || '{}') } catch { return {} }
}

export type SpendRow = { day: string; model: string; project: string | null; tokens_in: number; tokens_out: number; calls: number; est_cost: number | null }
export type ToolHealthRow = { name: string; kind: 'tool' | 'mcp'; calls: number; errors: number; denials: number }
export type ProjectRollup = { project: string | null; sessions: number; wall_ms: number; tokens_in: number; tokens_out: number; est_cost: number | null; subagents: number }

// WHERE fragment for span queries joined to sessions as `se`, span aliased `sp`.
function spanWhere(f: InsightFilter, extra: string): { where: string; params: (string | number)[] } {
  const conds = [extra]
  const params: (string | number)[] = []
  if (f.project) { conds.push('se.project = ?'); params.push(f.project) }
  if (f.from !== undefined) { conds.push('sp.started_at >= ?'); params.push(f.from) }
  if (f.to !== undefined) { conds.push('sp.started_at <= ?'); params.push(f.to) }
  return { where: conds.join(' AND '), params }
}

export function spendSeries(db: Database, f: InsightFilter): SpendRow[] {
  const { where, params } = spanWhere(f, "sp.kind = 'llm'")
  const rows = db.query(`
    SELECT date(sp.started_at / 1000, 'unixepoch') day, sp.name model, se.project project,
      SUM(COALESCE(json_extract(sp.attrs, '$.input_tokens'), 0)) tokens_in,
      SUM(COALESCE(json_extract(sp.attrs, '$.output_tokens'), 0)) tokens_out,
      COUNT(*) calls
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where}
    GROUP BY day, model, project ORDER BY day, model`).all(...params) as any[]
  return rows.map(r => ({ ...r, est_cost: estCost(r.model, r.tokens_in, r.tokens_out) })) as SpendRow[]
}

export function toolHealth(db: Database, f: InsightFilter): ToolHealthRow[] {
  const { where, params } = spanWhere(f, "sp.kind IN ('tool', 'mcp')")
  return db.query(`
    SELECT sp.name name, sp.kind kind, COUNT(*) calls,
      SUM(sp.status = 'error') errors,
      SUM(EXISTS(SELECT 1 FROM events ev WHERE ev.span_id = sp.id
        AND ev.type = 'permission.resolved' AND json_extract(ev.attrs, '$.outcome') = 'denied')) denials
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where}
    GROUP BY sp.name, sp.kind ORDER BY calls DESC`).all(...params) as ToolHealthRow[]
}

export function projectRollups(db: Database, f: InsightFilter): ProjectRollup[] {
  // sessions-side aggregates
  const sConds = ['1 = 1']
  const sParams: (string | number)[] = []
  if (f.project) { sConds.push('project = ?'); sParams.push(f.project) }
  if (f.from !== undefined) { sConds.push('last_event_at >= ?'); sParams.push(f.from) }
  if (f.to !== undefined) { sConds.push('started_at <= ?'); sParams.push(f.to) }
  const sess = db.query(`
    SELECT project, COUNT(*) sessions, SUM(last_event_at - started_at) wall_ms
    FROM sessions WHERE ${sConds.join(' AND ')} GROUP BY project`).all(...sParams) as any[]
  // span-side aggregates (per model for cost correctness, folded per project after)
  const { where, params } = spanWhere(f, "sp.kind IN ('llm', 'agent')")
  const spans = db.query(`
    SELECT se.project project, sp.kind kind, sp.name model,
      SUM(COALESCE(json_extract(sp.attrs, '$.input_tokens'), 0)) tin,
      SUM(COALESCE(json_extract(sp.attrs, '$.output_tokens'), 0)) tout,
      COUNT(*) n
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where} GROUP BY project, kind, model`).all(...params) as any[]
  return sess.map(s => {
    const mine = spans.filter(r => r.project === s.project)
    const llm = mine.filter(r => r.kind === 'llm')
    const costs = llm.map(r => estCost(r.model, r.tin, r.tout))
    const known = costs.filter((c): c is number => c !== null)
    return {
      project: s.project, sessions: s.sessions, wall_ms: s.wall_ms ?? 0,
      tokens_in: llm.reduce((a, r) => a + r.tin, 0), tokens_out: llm.reduce((a, r) => a + r.tout, 0),
      est_cost: known.length ? known.reduce((a, c) => a + c, 0) : null,
      subagents: mine.filter(r => r.kind === 'agent').reduce((a, r) => a + r.n, 0),
    }
  }) as ProjectRollup[]
}

export function searchSessions(
  db: Database,
  f: InsightFilter & { q?: string; status?: string; limit?: number },
  opts: { now: number; staleAfterMs: number },
): SessionRow[] {
  const conds = ['1 = 1']
  const params: (string | number)[] = []
  if (f.q) {
    conds.push(`(project LIKE '%' || ? || '%' OR EXISTS(
      SELECT 1 FROM events ev WHERE ev.session_id = sessions.id
        AND ev.type = 'message.user' AND json_extract(ev.attrs, '$.preview') LIKE '%' || ? || '%'))`)
    params.push(f.q, f.q)
  }
  if (f.project) { conds.push('project = ?'); params.push(f.project) }
  if (f.from !== undefined) { conds.push('last_event_at >= ?'); params.push(f.from) }
  if (f.to !== undefined) { conds.push('started_at <= ?'); params.push(f.to) }
  const cutoff = opts.now - opts.staleAfterMs
  if (f.status === 'active') { conds.push("status = 'active' AND last_event_at >= ?"); params.push(cutoff) }
  else if (f.status === 'stale') { conds.push("status = 'active' AND last_event_at < ?"); params.push(cutoff) }
  else if (f.status === 'ended') { conds.push("status = 'ended'") }
  else if (f.status) { conds.push('0 = 1') }
  params.push(f.limit ?? 50)
  return db.query(`SELECT * FROM sessions WHERE ${conds.join(' AND ')}
    ORDER BY last_event_at DESC LIMIT ?`).all(...params) as SessionRow[]
}

export function sprawlMap(db: Database, f: InsightFilter): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const { where, params } = spanWhere(f, "sp.kind IN ('agent', 'llm', 'tool', 'mcp')")
  const rows = db.query(`
    SELECT sp.id id, sp.parent_id parent_id, sp.kind kind, sp.name name,
      sp.started_at s, sp.ended_at e, sp.attrs attrs
    FROM spans sp JOIN sessions se ON se.id = sp.session_id WHERE ${where}`).all(...params) as any[]
  const byId = new Map(rows.map(r => [r.id, r]))
  const nodeId = (r: any) => `${r.kind}:${r.name}`
  const parentNode = (r: any, seen = new Set<string>()): string => {
    if (seen.has(r.id)) return 'main'
    seen.add(r.id)
    const p = r.parent_id ? byId.get(r.parent_id) : null
    if (!p) return 'main'
    if (p.kind === 'agent' || p.kind === 'llm') return nodeId(p)
    // tool parent (Agent tool spawning an agent span): attribute to the tool's own parent chain
    return parentNode(p, seen)
  }
  const nodes = new Map<string, TopoNode>([['main', { id: 'main', kind: 'main', label: 'main', count: 0 }]])
  const edges = new Map<string, TopoEdge>()
  for (const r of rows) {
    const id = nodeId(r)
    const n = nodes.get(id) ?? { id, kind: r.kind as TopoKind, label: r.name, count: 0 }
    n.count++
    nodes.set(id, n)
    const from = parentNode(r)
    const key = `${from}→${id}`
    const ed = edges.get(key) ?? { from, to: id, calls: 0, totalMs: 0, tokensIn: 0, tokensOut: 0 }
    ed.calls++
    if (r.e) ed.totalMs += r.e - r.s
    if (r.kind === 'llm') {
      const a = parseAttrs(r.attrs)
      ed.tokensIn += (a.input_tokens as number) ?? 0
      ed.tokensOut += (a.output_tokens as number) ?? 0
    }
    edges.set(key, ed)
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

const URL_RE = /https?:\/\/([^\/\s'"<>)]+)/g

export function externalSurface(db: Database, f: InsightFilter) {
  const { where, params } = spanWhere(f, "sp.kind IN ('tool', 'mcp')")
  const rows = db.query(`
    SELECT sp.name name, sp.kind kind,
      json_extract(sp.attrs, '$.input.url') url, json_extract(sp.attrs, '$.input.command') cmd
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where} AND (sp.kind = 'mcp' OR json_extract(sp.attrs, '$.input.url') IS NOT NULL
      OR json_extract(sp.attrs, '$.input.command') IS NOT NULL)`).all(...params) as any[]
  const domains = new Map<string, { host: string; calls: number; tools: Set<string> }>()
  const addHost = (raw: string, tool: string) => {
    const at = raw.lastIndexOf('@')
    const host = (at >= 0 ? raw.slice(at + 1) : raw).split(':')[0].toLowerCase()
    if (!host.includes('.') || host === 'localhost' || host.startsWith('127.')) return
    const d = domains.get(host) ?? { host, calls: 0, tools: new Set<string>() }
    d.calls++; d.tools.add(tool); domains.set(host, d)
  }
  const mcp = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (r.kind === 'mcp') {
      const m = r.name.match(/^mcp__(.+?)__(.+)$/)
      if (m) {
        const tools = mcp.get(m[1]) ?? new Map()
        tools.set(m[2], (tools.get(m[2]) ?? 0) + 1)
        mcp.set(m[1], tools)
      }
      continue
    }
    if (r.url) { try { addHost(new URL(r.url).host, r.name) } catch {} }
    if (r.cmd) for (const m of String(r.cmd).matchAll(URL_RE)) addHost(m[1], r.name)
  }
  return {
    domains: [...domains.values()].sort((a, b) => b.calls - a.calls).slice(0, 100)
      .map(d => ({ host: d.host, calls: d.calls, tools: [...d.tools].sort() })),
    mcp: [...mcp.entries()]
      .map(([server, tools]) => ({ server, tools: [...tools.entries()].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls) }))
      .sort((a, b) => b.tools.reduce((s, t) => s + t.calls, 0) - a.tools.reduce((s, t) => s + t.calls, 0))
      .slice(0, 100),
  }
}

export function fsFootprint(db: Database, f: InsightFilter) {
  const { where, params } = spanWhere(f, "sp.kind = 'tool' AND sp.name IN ('Read', 'Write', 'Edit', 'NotebookEdit')")
  const rows = db.query(`
    SELECT sp.name name, json_extract(sp.attrs, '$.input.file_path') fp
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where} AND json_extract(sp.attrs, '$.input.file_path') IS NOT NULL`).all(...params) as any[]
  type Agg = { path: string; touches: number; reads: number; writes: number }
  const files = new Map<string, Agg>(), dirs = new Map<string, Agg>()
  const bump = (m: Map<string, Agg>, path: string, isRead: boolean) => {
    const a = m.get(path) ?? { path, touches: 0, reads: 0, writes: 0 }
    a.touches++; isRead ? a.reads++ : a.writes++; m.set(path, a)
  }
  for (const r of rows) {
    const isRead = r.name === 'Read'
    bump(files, r.fp, isRead)
    bump(dirs, r.fp.split('/').slice(0, -1).join('/') || '/', isRead)
  }
  const top = (m: Map<string, Agg>) => [...m.values()].sort((a, b) => b.touches - a.touches).slice(0, 100)
  return { dirs: top(dirs), files: top(files) }
}
