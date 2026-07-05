# 0rrery Topology View Design

Date: 2026-07-05
Status: approved pending user spec review
Parent spec: `2026-07-04-0rrery-rebuild-design.md` (closes its deferred "topology graph view" item; supersedes the v2 force-graph concept).

## Summary

A third Session-detail tab — `Trace | Events | Topology` — showing what talked to what and how much: actor-class nodes (main, agent types, models, tool names) connected by call edges weighted by count/duration/tokens. Derived entirely from already-fetched span data; deterministic layered layout; zero new dependencies; zero new API surface.

## Decisions

| Decision | Choice |
|---|---|
| Graph model | Actor CLASSES, not instances: `main`, one node per agent type, per model name, per tool name (instance truth stays in the waterfall) |
| Layout | Deterministic layered left→right DAG (columns: main \| agents \| models \| tools), single barycenter pass for crossing reduction. No force simulation (v2's drift bugs were force-sim bugs), no new deps |
| Color | Existing kind hues (agents `--ok`, models `--accent`, tools `--run`); dataviz palette validator run against the dark surface at build time, snap to passing steps on failure |
| Data flow | Pure derivation from `detail.spans` via `useMemo`; live updates ride the existing WS reload |

## Derivation (`packages/dashboard/src/topology.ts`)

```ts
export type TopoKind = 'main' | 'agent' | 'llm' | 'tool'
export type TopoNode = { id: string; kind: TopoKind; label: string; count: number }
export type TopoEdge = { from: string; to: string; calls: number; totalMs: number; tokensIn: number; tokensOut: number }
export function buildTopology(spans: SpanRow[]): { nodes: TopoNode[]; edges: TopoEdge[] }
```

Node identity: `main`, `agent:<type>` (label `<type>`, count = instances), `llm:<model>`, `tool:<name>`.

Edge rules (aggregated over all matching spans):
- llm span → edge `caller → llm:<model>`; caller = owning agent class via `attrs.agentId` → that agent instance's type, else `main`.
- tool span with llm parent → edge `llm:<model> → tool:<name>` (the model emitted the tool_use).
- tool span without llm parent (hook-only) → edge `caller → tool:<name>`.
- agent span → edge `caller → agent:<type>`; caller resolved by walking the linkage parent chain (`agent → tool:<id> → llm:<mid> → owner`); unlinked agents fall back to `main`.

Weights: `calls` = span count; `totalMs` = Σ(ended_at − started_at) over ended spans; `tokensIn/tokensOut` summed from llm span attrs. Malformed attrs skipped via guarded parse (tokenRollup convention). Instance→type resolution builds one map (agent span id → type) in a first pass.

## Layout (`layoutTopology`, same file)

```ts
export type LaidOutNode = TopoNode & { x: number; y: number }
export function layoutTopology(nodes: TopoNode[], edges: TopoEdge[]): LaidOutNode[]
```
Column by kind (`main`=0, `agent`=1, `llm`=2, `tool`=3); initial y = first-seen order within the column; one barycenter pass (node y → mean y of its callers, stable sort, ties by prior order); fixed row/column pixel spacing. Deterministic for identical input.

## Rendering (`TopologyTab` in `packages/dashboard/src/views/SessionDetailView.tsx` or a sibling view file)

- SVG inside a horizontally scrollable container (page body never scrolls sideways).
- Nodes: rounded rects, kind-colored left accent bar, label + `×count` in text tokens (text never wears series color).
- Edges: cubic béziers, neutral ink, stroke width `sqrt(calls)` clamped 1–6px; hover highlights the edge and shows a tooltip with calls / total duration / tokens (llm edges).
- Legend row for the three kinds; `main` is self-evident as the root.
- Tab wiring: `Trace | Events | Topology` in Session detail; topology derives via `useMemo(() => buildTopology(detail.spans), [detail])`.

## Testing

- `buildTopology` TDD: aggregation counts, caller resolution for all four edge rules including the unlinked-agent fallback and hook-only tools, weight sums, malformed-attrs skip.
- `layoutTopology` TDD: column assignment, deterministic ordering, barycenter movement on a crafted crossing case.
- Component: `vite build` + live verification against this dev session's graph (expect ~dozens of nodes, `general-purpose` with a high instance count).
- Palette: run the dataviz validator on the three kind hexes against the dark surface; record output; snap if failing.

**Palette validation outcome (2026-07-05, accepted deviation):** the validator PASSes CVD adjacent-pair separation and surface contrast but FAILs the categorical lightness band for all three theme hues (`#9ece6a`, `#7aa2f7`, `#e0af68`). Accepted as-is: the band check targets data-mark fills, whereas these hues appear only as 4px accent bars and legend chips whose kind identity is triple-encoded (column position primary, label text, hue), and they match the entity colors used across the rest of the dashboard — snapping to band-passing topology-only hues would break entity-color consistency between tabs.

## Out of scope

Cross-session/global topology, node click-through filtering, animation/transitions, image export, per-instance agent nodes, edge filtering UI.
