export type TopoKind = 'main' | 'agent' | 'llm' | 'tool' | 'mcp'
export type TopoNode = { id: string; kind: TopoKind; label: string; count: number }
export type TopoEdge = { from: string; to: string; calls: number; totalMs: number; tokensIn: number; tokensOut: number }
