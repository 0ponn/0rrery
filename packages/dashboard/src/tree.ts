import type { SpanRow } from './types'

export type SpanNode = { span: SpanRow; children: SpanNode[]; depth: number }

export function buildSpanTree(spans: SpanRow[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>()
  for (const span of spans) nodes.set(span.id, { span, children: [], depth: 0 })
  const roots: SpanNode[] = []
  for (const node of nodes.values()) {
    const parent = node.span.parent_id ? nodes.get(node.span.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const setDepth = (list: SpanNode[], depth: number) => {
    for (const n of list) { n.depth = depth; setDepth(n.children, depth + 1) }
  }
  setDepth(roots, 0)
  const byStart = (a: SpanNode, b: SpanNode) => a.span.started_at - b.span.started_at
  const sortAll = (list: SpanNode[]) => { list.sort(byStart); list.forEach(n => sortAll(n.children)) }
  sortAll(roots)
  return roots
}

export function tokenRollup(spans: SpanRow[]): { input: number; output: number } {
  let input = 0, output = 0
  for (const s of spans) {
    if (s.kind !== 'llm') continue
    try {
      const a = JSON.parse(s.attrs)
      input += a.input_tokens ?? 0
      output += a.output_tokens ?? 0
    } catch {}
  }
  return { input, output }
}
