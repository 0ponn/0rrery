import { useMemo, useState } from 'react'
import { buildTopology, layoutTopology, type TopoEdge, type LaidOutNode } from '../topology'
import { fmtDuration, fmtTokens } from '../format'
import type { SpanRow } from '../types'

const NODE_W = 168
const NODE_H = 40
const PAD = 24
const LOOP_MARGIN = 34
const BULGE = 48

function edgePath(a: LaidOutNode, b: LaidOutNode): string {
  if (a.id === b.id) {
    const x = a.x + PAD + NODE_W / 2, y = a.y + PAD
    return `M ${x - 24} ${y} C ${x - 24} ${y - 34}, ${x + 24} ${y - 34}, ${x + 24} ${y}`
  }
  if (a.x === b.x) {
    const x1 = a.x + NODE_W + PAD, y1 = a.y + NODE_H / 2 + PAD
    const x2 = b.x + NODE_W + PAD, y2 = b.y + NODE_H / 2 + PAD
    const bulge = x1 + BULGE
    return `M ${x1} ${y1} C ${bulge} ${y1}, ${bulge} ${y2}, ${x2} ${y2}`
  }
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

  if (nodes.length <= 1) return <p className="empty">No topology yet — spans appear here as the session runs.</p>

  const baseWidth = Math.max(...laid.map(n => n.x)) + NODE_W + PAD * 2
  // same-column edges bulge BULGE px right of the node's right edge — only wider than
  // baseWidth if that column happens to be the rightmost one (i.e. no llm/tool columns).
  const bulgeWidth = Math.max(0, ...edges.map(e => {
    const a = byId.get(e.from), b = byId.get(e.to)
    return a && b && a.id !== b.id && a.x === b.x ? a.x + NODE_W + PAD + BULGE + PAD : 0
  }))
  const width = Math.max(baseWidth, bulgeWidth)
  const height = Math.max(...laid.map(n => n.y)) + NODE_H + PAD * 2
  const hovered = hover ? edges.find(e => `${e.from}→${e.to}` === hover) : null

  return (
    <div className="topo-wrap">
      <div className="topo-legend">
        <span><i className="topo-chip chip-agent" /> agents</span>
        <span><i className="topo-chip chip-llm" /> models</span>
        <span><i className="topo-chip chip-tool" /> tools</span>
        <span><i className="topo-chip chip-mcp" /> mcp</span>
        {hovered && <span className="topo-tip">{byId.get(hovered.from)?.label} → {byId.get(hovered.to)?.label}: {edgeTip(hovered)}</span>}
      </div>
      <div className="topo-scroll">
        <svg width={width} height={height + LOOP_MARGIN} viewBox={`0 -${LOOP_MARGIN} ${width} ${height + LOOP_MARGIN}`}
          role="img" aria-label="Session topology graph">
          {edges.map(e => {
            const a = byId.get(e.from), b = byId.get(e.to)
            if (!a || !b) return null
            const key = `${e.from}→${e.to}`
            const d = edgePath(a, b)
            return (
              <g key={key}>
                <path d={d} fill="none" pointerEvents="none"
                  className={`topo-edge ${hover === key ? 'hot' : ''}`}
                  strokeWidth={Math.min(6, Math.max(1, Math.sqrt(e.calls)))} />
                <path d={d} fill="none" stroke="transparent" strokeWidth={12} cursor="pointer"
                  onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)}>
                  <title>{edgeTip(e)}</title>
                </path>
              </g>
            )
          })}
          {laid.map(n => (
            <g key={n.id} transform={`translate(${n.x + PAD}, ${n.y + PAD})`}>
              <title>{n.label}</title>
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
