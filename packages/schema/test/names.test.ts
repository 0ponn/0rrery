import { test, expect } from 'bun:test'
import { mcpParts, isMcpTool, displayKind } from '../src/names'

test('mcpParts splits server and tool at the first delimiter', () => {
  expect(mcpParts('mcp__claude_ai_Linear__save_issue')).toEqual({ server: 'claude_ai_Linear', tool: 'save_issue' })
  expect(mcpParts('mcp__plugin_cloudflare_cloudflare-api__docs')).toEqual({ server: 'plugin_cloudflare_cloudflare-api', tool: 'docs' })
  expect(mcpParts('mcp__engram__mem_save')).toEqual({ server: 'engram', tool: 'mem_save' })
})

test('degenerate and non-mcp names return null/false', () => {
  expect(mcpParts('Bash')).toBeNull()
  expect(mcpParts('mcp__a')).toBeNull()
  expect(mcpParts('mcp____x')).toBeNull()
  expect(mcpParts('')).toBeNull()
  expect(isMcpTool('Bash')).toBe(false)
  expect(isMcpTool('mcp__engram__mem_save')).toBe(true)
})

test('displayKind fallback matrix', () => {
  expect(displayKind('tool', 'mcp__engram__mem_save')).toBe('mcp')   // historical span
  expect(displayKind('mcp', 'mcp__engram__mem_save')).toBe('mcp')    // new span passthrough
  expect(displayKind('tool', 'Bash')).toBe('tool')
  expect(displayKind('llm', 'mcp__weird__name')).toBe('llm')          // only tool falls back
  expect(displayKind('agent', 'general-purpose')).toBe('agent')
})
