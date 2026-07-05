import { buildTopology } from '../topology'
import { TopoGraph } from './TopoGraph'
import type { SpanRow } from '../types'

export function TopologyTab({ spans }: { spans: SpanRow[] }) {
  const { nodes, edges } = buildTopology(spans)
  return <TopoGraph nodes={nodes} edges={edges} />
}
