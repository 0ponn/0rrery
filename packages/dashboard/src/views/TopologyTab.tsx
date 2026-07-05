import { useMemo, useState } from 'react'
import { buildTopology, layoutTopology, type TopoEdge, type LaidOutNode } from '../topology'
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
