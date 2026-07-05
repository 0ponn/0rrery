import { useMemo } from 'react'
import { buildTopology } from '../topology'
import { TopoGraph } from './TopoGraph'
import type { SpanRow } from '../types'

export function TopologyTab({ spans }: { spans: SpanRow[] }) {
  const { nodes, edges } = useMemo(() => buildTopology(spans), [spans])
  return <TopoGraph nodes={nodes} edges={edges} />
}
