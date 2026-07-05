# Topology View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third Session-detail tab showing what talked to what and how much — actor-class nodes (main / agent types / models / tool names) with call edges weighted by count, duration, and tokens.

**Architecture:** Two pure functions in `packages/dashboard/src/topology.ts` (`buildTopology` aggregates spans into nodes/edges; `layoutTopology` assigns deterministic layered coordinates) plus one SVG component `TopologyTab` wired as the third tab. No new deps, no API changes; data comes from the already-fetched `detail.spans`.

**Tech Stack:** Existing: React 18, TypeScript, plain SVG, `bun test`, vite build.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-topology-view-design.md`. Read it first.
- Nodes are actor CLASSES: `main`, `agent:<type>`, `llm:<model>`, `tool:<name>`. Edge rules exactly as the spec's four bullets.
- Layout deterministic: identical input → identical output. Columns main=0, agent=1, llm=2, tool=3. No force simulation. No new dependencies.
- Text never wears series color (dataviz rule): node labels/counts in text tokens; kind color appears only as the node's accent bar and legend chips.
- Edge stroke width = `Math.min(6, Math.max(1, Math.sqrt(calls)))`, neutral ink.
- The SVG lives inside an `overflow-x: auto` container; the page body never scrolls horizontally.
- Malformed span `attrs` are skipped via guarded JSON.parse (same convention as `tokenRollup`).
- `bun test` FROM THE REPO ROOT (currently 94 pass) + `bunx tsc --noEmit` + dashboard `bun run build` green before every commit; paste the actual root tail, never a subset count.
- Commit per task, imperative messages.

---

### Task 1: topology derivation + layout (pure)

**Files:**
- Create: `packages/dashboard/src/topology.ts`
- Test: `packages/dashboard/test/topology.test.ts`

**Interfaces:**
- Consumes: `SpanRow` from `../src/types`.
- Produces (Task 2 relies on these exactly):
```ts
export type TopoKind = 'main' | 'agent' | 'llm' | 'tool'
export type TopoNode = { id: string; kind: TopoKind; label: string; count: number }
export type TopoEdge = { from: string; to: string; calls: number; totalMs: number; tokensIn: number; tokensOut: number }
export function buildTopology(spans: SpanRow[]): { nodes: TopoNode[]; edges: TopoEdge[] }
export type LaidOutNode = TopoNode & { x: number; y: number }
export const COL_X = 220
export const ROW_Y = 56
export function layoutTopology(nodes: TopoNode[], edges: TopoEdge[]): LaidOutNode[]
```

- [ ] **Step 1: Write the failing tests**

`packages/dashboard/test/topology.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { buildTopology, layoutTopology } from '../src/topology'
import type { SpanRow } from '../src/types'

const span = (id: string, parent: string | null, kind: SpanRow['kind'], name: string, opts: Partial<SpanRow> = {}): SpanRow => ({
  id, session_id: 's', parent_id: parent, kind, name,
  started_at: 100, ended_at: 200, status: 'ok', attrs: '{}', ...opts,
})

// A session shaped like real data:
//   main llm (msg1) spawns two general-purpose agents (a1, a2) and one Explore (a3, unlinked)
//   a1's llm (msgA) calls Bash twice; hook-only tool (Read) at main; malformed attrs on one span
const FIXTURE: SpanRow[] = [
  span('llm:m1', null, 'llm', 'fable', { attrs: JSON.stringify({ input_tokens: 100, output_tokens: 10 }) }),
  span('tool:t1', 'llm:m1', 'tool', 'Agent'),
  span('tool:t2', 'llm:m1', 'tool', 'Agent'),
  span('agent:a1', 'tool:t1', 'agent', 'general-purpose'),
  span('agent:a2', 'tool:t2', 'agent', 'general-purpose'),
  span('agent:a3', null, 'agent', 'Explore'),                                     // unlinked → main
  span('llm:mA', 'agent:a1', 'llm', 'haiku', { attrs: JSON.stringify({ input_tokens: 50, output_tokens: 5 }) }),
  span('llm:mB', 'agent:a1', 'llm', 'haiku', { attrs: 'not json' }),              // malformed: counted, tokens skipped
  span('tool:tb1', 'llm:mA', 'tool', 'Bash', { started_at: 100, ended_at: 150 }),
  span('tool:tb2', 'llm:mA', 'tool', 'Bash', { started_at: 100, ended_at: null, status: 'running' }),  // running: counted, no ms
  span('tool:th1', null, 'tool', 'Read'),                                          // hook-only → main calls it
]

test('buildTopology aggregates actor classes', () => {
  const { nodes } = buildTopology(FIXTURE)
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
  expect(byId['main']).toMatchObject({ kind: 'main', count: 1 })
  expect(byId['agent:general-purpose']).toMatchObject({ kind: 'agent', label: 'general-purpose', count: 2 })
  expect(byId['agent:Explore']).toMatchObject({ count: 1 })
  expect(byId['llm:fable']).toMatchObject({ kind: 'llm', count: 1 })
  expect(byId['llm:haiku']).toMatchObject({ count: 2 })
  expect(byId['tool:Bash']).toMatchObject({ kind: 'tool', count: 2 })
  expect(byId['tool:Agent']).toMatchObject({ count: 2 })
  expect(byId['tool:Read']).toMatchObject({ count: 1 })
  expect(nodes).toHaveLength(8)
})

test('buildTopology edge rules and weights', () => {
  const { edges } = buildTopology(FIXTURE)
  const byKey = Object.fromEntries(edges.map(e => [`${e.from}→${e.to}`, e]))
  // main → its model, with tokens
  expect(byKey['main→llm:fable']).toMatchObject({ calls: 1, tokensIn: 100, tokensOut: 10, totalMs: 100 })
  // model → tools it emitted
  expect(byKey['llm:fable→tool:Agent']).toMatchObject({ calls: 2 })
  expect(byKey['llm:haiku→tool:Bash']).toMatchObject({ calls: 2, totalMs: 50 })   // running span adds calls, not ms
  // agent llm calls: malformed attrs counted but token-skipped
  expect(byKey['agent:general-purpose→llm:haiku']).toMatchObject({ calls: 2, tokensIn: 50, tokensOut: 5 })
  // agent spawn edges via linkage chain; unlinked agent falls back to main
  expect(byKey['main→agent:general-purpose']).toMatchObject({ calls: 2 })
  expect(byKey['main→agent:Explore']).toMatchObject({ calls: 1 })
  // hook-only tool at main
  expect(byKey['main→tool:Read']).toMatchObject({ calls: 1 })
  expect(edges).toHaveLength(7)
})

test('layoutTopology: columns, determinism, barycenter pulls callees toward callers', () => {
  const { nodes, edges } = buildTopology(FIXTURE)
  const laid = layoutTopology(nodes, edges)
  const byId = Object.fromEntries(laid.map(n => [n.id, n]))
  expect(byId['main'].x).toBe(0)
  expect(byId['agent:Explore'].x).toBe(220)
  expect(byId['llm:haiku'].x).toBe(440)
  expect(byId['tool:Bash'].x).toBe(660)
  // determinism
  expect(layoutTopology(nodes, edges)).toEqual(laid)
  // barycenter: two tools called by the same model sit adjacent
  const bashY = byId['tool:Bash'].y
  const agentToolY = byId['tool:Agent'].y
  expect(Math.abs(bashY - agentToolY)).toBeGreaterThan(0)  // distinct rows
  laid.forEach(n => { expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true) })
})

test('empty spans → just main with no edges', () => {
  const { nodes, edges } = buildTopology([])
  expect(nodes).toEqual([{ id: 'main', kind: 'main', label: 'main', count: 1 }])
  expect(edges).toEqual([])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/dashboard/test/topology.test.ts`
Expected: FAIL — cannot resolve `../src/topology`.

- [ ] **Step 3: Implement**

`packages/dashboard/src/topology.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/dashboard/test/topology.test.ts` then `bun test` from the repo root (expect 98 pass / 0 fail) and `bunx tsc --noEmit`.
Expected: all green; paste the root tail. If an aggregate expectation mismatches, hand-trace the fixture before touching either side and record the reasoning.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard && git commit -m "Derive session topology from spans"
```

---

### Task 2: TopologyTab component + wiring + palette validation

**Files:**
- Create: `packages/dashboard/src/views/TopologyTab.tsx`
- Modify: `packages/dashboard/src/views/SessionDetailView.tsx:39,84-87` (tab state + button + panel), `packages/dashboard/src/theme.css` (append)

**Interfaces:**
- Consumes: `buildTopology`, `layoutTopology`, `COL_X`, `ROW_Y`, types from `../topology`; `fmtDuration`, `fmtTokens` from `../format`; `SpanRow` from `../types`.
- Produces: `export function TopologyTab({ spans }: { spans: SpanRow[] })`.

- [ ] **Step 1: Implement the component**

`packages/dashboard/src/views/TopologyTab.tsx`:
```tsx
import { useMemo, useState } from 'react'
import { buildTopology, layoutTopology, COL_X, ROW_Y, type TopoEdge, type LaidOutNode } from '../topology'
import { fmtDuration, fmtTokens } from '../format'
import type { SpanRow } from '../types'

const NODE_W = 168
const NODE_H = 40
const PAD = 24

function edgePath(a: LaidOutNode, b: LaidOutNode): string {
  const x1 = a.x + NODE_W + PAD, y1 = a.y + NODE_H / 2 + PAD
  const x2 = b.x + PAD, y2 = b.y + NODE_H / 2 + PAD
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}

function edgeTip(e: TopoEdge): string {
  const parts = [`${e.calls} call${e.calls === 1 ? '' : 's'}`, fmtDuration(e.totalMs)]
  if (e.tokensIn || e.tokensOut) parts.push(`${fmtTokens(e.tokensIn)} in / ${fmtTokens(e.tokensOut)} out`)
  return parts.join(' · ')
}

export function TopologyTab({ spans }: { spans: SpanRow[] }) {
  const { nodes, edges, laid } = useMemo(() => {
    const t = buildTopology(spans)
    return { ...t, laid: layoutTopology(t.nodes, t.edges) }
  }, [spans])
  const [hover, setHover] = useState<string | null>(null)

  const byId = useMemo(() => new Map(laid.map(n => [n.id, n])), [laid])
  const width = Math.max(...laid.map(n => n.x)) + NODE_W + PAD * 2
  const height = Math.max(...laid.map(n => n.y)) + NODE_H + PAD * 2
  const hovered = hover ? edges.find(e => `${e.from}→${e.to}` === hover) : null

  if (nodes.length <= 1) return <p className="empty">No topology yet — spans appear here as the session runs.</p>

  return (
    <div className="topo-wrap">
      <div className="topo-legend">
        <span><i className="topo-chip chip-agent" /> agents</span>
        <span><i className="topo-chip chip-llm" /> models</span>
        <span><i className="topo-chip chip-tool" /> tools</span>
        {hovered && <span className="topo-tip">{byId.get(hovered.from)?.label} → {byId.get(hovered.to)?.label}: {edgeTip(hovered)}</span>}
      </div>
      <div className="topo-scroll">
        <svg width={width} height={height} role="img" aria-label="Session topology graph">
          {edges.map(e => {
            const a = byId.get(e.from), b = byId.get(e.to)
            if (!a || !b) return null
            const key = `${e.from}→${e.to}`
            return (
              <path key={key} d={edgePath(a, b)} fill="none"
                className={`topo-edge ${hover === key ? 'hot' : ''}`}
                strokeWidth={Math.min(6, Math.max(1, Math.sqrt(e.calls)))}
                onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)}>
                <title>{edgeTip(e)}</title>
              </path>
            )
          })}
          {laid.map(n => (
            <g key={n.id} transform={`translate(${n.x + PAD}, ${n.y + PAD})`}>
              <rect className="topo-node" width={NODE_W} height={NODE_H} rx={6} />
              <rect className={`topo-accent accent-${n.kind}`} width={4} height={NODE_H} rx={2} />
              <text className="topo-label" x={12} y={NODE_H / 2 + 4}>
                {n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label}
                {n.count > 1 && <tspan className="topo-count"> ×{n.count}</tspan>}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the tab**

In `packages/dashboard/src/views/SessionDetailView.tsx`:
- add `import { TopologyTab } from './TopologyTab'`
- line 39: `const [tab, setTab] = useState<'trace' | 'events' | 'topology'>('trace')`
- after the Events button (line 86): `<button className={tab === 'topology' ? 'active' : ''} onClick={() => setTab('topology')}>Topology</button>`
- after the events panel (line 107): `{tab === 'topology' && <TopologyTab spans={spans} />}`

- [ ] **Step 3: CSS**

Append to `packages/dashboard/src/theme.css`:
```css
.topo-wrap { border: 1px solid var(--line); border-radius: 6px; padding: 8px 0 0; }
.topo-legend { display: flex; gap: 16px; padding: 4px 14px 8px; color: var(--dim); font-size: 12px; align-items: center; }
.topo-chip { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.chip-agent { background: var(--ok); } .chip-llm { background: var(--accent); } .chip-tool { background: var(--run); }
.topo-tip { color: var(--fg); margin-left: auto; }
.topo-scroll { overflow-x: auto; }
.topo-node { fill: var(--panel); stroke: var(--line); }
.topo-accent.accent-agent { fill: var(--ok); } .topo-accent.accent-llm { fill: var(--accent); }
.topo-accent.accent-tool { fill: var(--run); } .topo-accent.accent-main { fill: var(--dim); }
.topo-label { fill: var(--fg); font-size: 12px; }
.topo-count { fill: var(--dim); }
.topo-edge { stroke: var(--dim); opacity: 0.45; cursor: pointer; }
.topo-edge.hot { stroke: var(--fg); opacity: 0.9; }
```

- [ ] **Step 4: Palette validation (dataviz gate)**

Run the dataviz validator on the three kind hues against the dark surface:
```bash
node /home/mlayug/.cache/claude-tmp/claude-1000/bundled-skills/2.1.201/106117b5b91581c1c79b021d987a6fe4/dataviz/scripts/validate_palette.js "#9ece6a,#7aa2f7,#e0af68" --mode dark --surface "#0b0e14" 2>&1 || node /home/mlayug/.cache/claude-tmp/claude-1000/bundled-skills/2.1.201/106117b5b91581c1c79b021d987a6fe4/dataviz/scripts/validate_palette.js "#9ece6a,#7aa2f7,#e0af68" --mode dark 2>&1
```
Paste the full output in your report. If every check passes, proceed. If ANY check FAILs, STOP and report BLOCKED with the validator output — color remediation is the controller's decision, do not pick replacement hexes yourself.

- [ ] **Step 5: Verify**

Run: `bun test` from repo root (expect 98 pass / 0 fail — no new tests this task), `bunx tsc --noEmit`, `cd packages/dashboard && bun run build && cd ../..`
Expected: all green; paste the root tail and build tail.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard && git commit -m "Add topology tab: layered actor graph with weighted call edges"
```

- [ ] **Step 7: Live verification**

The service serves dist per request — no restart needed. Fetch the dev session's detail and sanity-check the derivation against live data:
```bash
curl -s "localhost:7317/api/sessions/f56f7822-2b63-4860-a522-0e03202916a5" -o /tmp/topo-check.json
python3 - <<'EOF'
import json
d = json.load(open('/tmp/topo-check.json'))
kinds = {}
for s in d['spans']: kinds[s['kind']] = kinds.get(s['kind'], 0) + 1
agents = {s['name'] for s in d['spans'] if s['kind'] == 'agent'}
models = {s['name'] for s in d['spans'] if s['kind'] == 'llm'}
tools = {s['name'] for s in d['spans'] if s['kind'] == 'tool'}
print('span kinds:', kinds)
print(f'expected topology nodes: 1 main + {len(agents)} agent types + {len(models)} models + {len(tools)} tool names = {1+len(agents)+len(models)+len(tools)}')
EOF
rm /tmp/topo-check.json
```
Report the expected node count (should be roughly 20-45). Note in the report that visual confirmation in the browser is left to the human (open http://localhost:7317/#/session/f56f7822-2b63-4860-a522-0e03202916a5 → Topology tab).

---

## Out of scope (per spec)

Cross-session topology, node click-through filtering, animation, export, per-instance agent nodes, edge filtering UI.
