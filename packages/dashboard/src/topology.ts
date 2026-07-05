import type { SpanRow } from './types'

export type TopoKind = 'main' | 'agent' | 'llm' | 'tool'
export type TopoNode = { id: string; kind: TopoKind; label: string; count: number }
export type TopoEdge = { from: string; to: string; calls: number; totalMs: number; tokensIn: number; tokensOut: number }
export type LaidOutNode = TopoNode & { x: number; y: number }

export const COL_X = 220
export const ROW_Y = 56

function parseAttrs(attrs: string): Record<string, unknown> {
  try { return JSON.parse(attrs) } catch { return {} }
}

export function buildTopology(spans: SpanRow[]): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const byId = new Map(spans.map(s => [s.id, s]))
  const agentType = new Map<string, string>()  // agent span id → type label
  for (const s of spans) if (s.kind === 'agent') agentType.set(s.id, s.name)

  // actor class of the ancestor that "owns" a span: nearest agent ancestor's type, else main
  const ownerOf = (s: SpanRow): string => {
    let cur: SpanRow | undefined = s
    while (cur?.parent_id) {
      const p = byId.get(cur.parent_id)
      if (!p) break
      if (p.kind === 'agent') return `agent:${agentType.get(p.id) ?? p.name}`
      cur = p
    }
    return 'main'
  }

  const nodes = new Map<string, TopoNode>()
  const edges = new Map<string, TopoEdge>()
  const node = (id: string, kind: TopoKind, label: string) => {
    const n = nodes.get(id) ?? { id, kind, label, count: 0 }
    n.count++
    nodes.set(id, n)
    return n
  }
  const edge = (from: string, to: string, s: SpanRow, tokens = false) => {
    const key = `${from}→${to}`
    const e = edges.get(key) ?? { from, to, calls: 0, totalMs: 0, tokensIn: 0, tokensOut: 0 }
    e.calls++
    if (s.ended_at != null) e.totalMs += s.ended_at - s.started_at
    if (tokens) {
      const a = parseAttrs(s.attrs)
      e.tokensIn += typeof a.input_tokens === 'number' ? a.input_tokens : 0
      e.tokensOut += typeof a.output_tokens === 'number' ? a.output_tokens : 0
    }
    edges.set(key, e)
  }

  nodes.set('main', { id: 'main', kind: 'main', label: 'main', count: 1 })

  for (const s of spans) {
    if (s.kind === 'llm') {
      const id = `llm:${s.name}`
      node(id, 'llm', s.name)
      edge(ownerOf(s), id, s, true)
    } else if (s.kind === 'tool') {
      const id = `tool:${s.name}`
      node(id, 'tool', s.name)
      const parent = s.parent_id ? byId.get(s.parent_id) : undefined
      if (parent?.kind === 'llm') edge(`llm:${parent.name}`, id, s)
      else edge(ownerOf(s), id, s)
    } else if (s.kind === 'agent') {
      const id = `agent:${s.name}`
      node(id, 'agent', s.name)
      edge(ownerOf(s), id, s)
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] }
}

const COL: Record<TopoKind, number> = { main: 0, agent: 1, llm: 2, tool: 3 }

export function layoutTopology(nodes: TopoNode[], edges: TopoEdge[]): LaidOutNode[] {
  // initial order: first appearance within each column
  const cols = new Map<number, TopoNode[]>()
  for (const n of nodes) {
    const c = COL[n.kind]
    if (!cols.has(c)) cols.set(c, [])
    cols.get(c)!.push(n)
  }
  const y0 = new Map<string, number>()
  for (const list of cols.values()) list.forEach((n, i) => y0.set(n.id, i))

  // one barycenter pass, columns left→right: mean caller y, stable sort
  const callersOf = new Map<string, string[]>()
  for (const e of edges) {
    if (!callersOf.has(e.to)) callersOf.set(e.to, [])
    callersOf.get(e.to)!.push(e.from)
  }
  for (const c of [...cols.keys()].sort((a, b) => a - b)) {
    if (c === 0) continue
    const list = cols.get(c)!
    const bary = (n: TopoNode) => {
      const callers = callersOf.get(n.id) ?? []
      const ys = callers.map(id => y0.get(id)).filter((y): y is number => y !== undefined)
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : y0.get(n.id)!
    }
    const keyed = list.map(n => ({ n, b: bary(n), orig: y0.get(n.id)! }))
    keyed.sort((a, b) => a.b - b.b || a.orig - b.orig)
    keyed.forEach(({ n }, i) => y0.set(n.id, i))
  }

  return nodes.map(n => ({ ...n, x: COL[n.kind] * COL_X, y: y0.get(n.id)! * ROW_Y }))
}
