import type { Database } from 'bun:sqlite'
import type { SessionRow } from '@0rrery/schema'
import { estCost } from './prices'

export type InsightFilter = { project?: string; from?: number; to?: number }

// WHERE fragment for span queries joined to sessions as `se`, span aliased `sp`.
function spanWhere(f: InsightFilter, extra: string): { where: string; params: (string | number)[] } {
  const conds = [extra]
  const params: (string | number)[] = []
  if (f.project) { conds.push('se.project = ?'); params.push(f.project) }
  if (f.from !== undefined) { conds.push('sp.started_at >= ?'); params.push(f.from) }
  if (f.to !== undefined) { conds.push('sp.started_at <= ?'); params.push(f.to) }
  return { where: conds.join(' AND '), params }
}

export function spendSeries(db: Database, f: InsightFilter) {
  const { where, params } = spanWhere(f, "sp.kind = 'llm'")
  const rows = db.query(`
    SELECT date(sp.started_at / 1000, 'unixepoch') day, sp.name model, se.project project,
      SUM(COALESCE(json_extract(sp.attrs, '$.input_tokens'), 0)) tokens_in,
      SUM(COALESCE(json_extract(sp.attrs, '$.output_tokens'), 0)) tokens_out,
      COUNT(*) calls
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where}
    GROUP BY day, model, project ORDER BY day, model`).all(...params) as any[]
  return rows.map(r => ({ ...r, est_cost: estCost(r.model, r.tokens_in, r.tokens_out) }))
}

export function toolHealth(db: Database, f: InsightFilter) {
  const { where, params } = spanWhere(f, "sp.kind IN ('tool', 'mcp')")
  return db.query(`
    SELECT sp.name name, sp.kind kind, COUNT(*) calls,
      SUM(sp.status = 'error') errors,
      SUM(EXISTS(SELECT 1 FROM events ev WHERE ev.span_id = sp.id
        AND ev.type = 'permission.resolved' AND json_extract(ev.attrs, '$.outcome') = 'denied')) denials
    FROM spans sp JOIN sessions se ON se.id = sp.session_id
    WHERE ${where}
    GROUP BY sp.name, sp.kind ORDER BY calls DESC`).all(...params) as any[]
}

export function projectRollups(db: Database, f: InsightFilter) {
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
  })
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
