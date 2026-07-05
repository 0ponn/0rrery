// Shared MCP tool-name convention. MUST stay dependency-free: the dashboard
// deep-imports this file to keep zod out of the browser bundle.
const MCP_RE = /^mcp__(.+?)__(.+)$/

export function mcpParts(name: string): { server: string; tool: string } | null {
  const m = MCP_RE.exec(name)
  return m ? { server: m[1], tool: m[2] } : null
}

export function isMcpTool(name: string): boolean {
  return MCP_RE.test(name)
}

export function displayKind(kind: string, name: string): string {
  return kind === 'tool' && isMcpTool(name) ? 'mcp' : kind
}
