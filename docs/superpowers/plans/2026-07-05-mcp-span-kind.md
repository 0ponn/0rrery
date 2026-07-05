# MCP Span Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP tool calls carry `kind: 'mcp'` from both collectors, render with their own color, and aggregate by server in the topology — with a display fallback so historical spans look identical without migration.

**Architecture:** One shared classifier module in `@0rrery/schema` (`src/names.ts`) consumed three ways: re-exported from the schema index for the collectors, deep-imported by the dashboard (keeps zod out of the bundle). Collectors switch the kind expression; the dashboard applies `displayKind` in the waterfall and `mcpParts` server-aggregation in the topology.

**Tech Stack:** Existing: Bun 1.3.x, TypeScript, React/SVG, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-mcp-span-kind-design.md`. Read it first.
- Classifier regex exactly `/^mcp__(.+?)__(.+)$/` — lazy server match splits at the first `__` after the prefix (server names use single underscores internally). Degenerate names (`mcp____x`, `mcp__a`) → null/false, never throw.
- Span IDs unchanged (`tool:<tool_use_id>`); only the `kind` value changes for mcp-named tools. Stored kinds are never mutated; history is covered by `displayKind` at render time.
- Dashboard imports the classifier ONLY via the deep path `@0rrery/schema/src/names` (never the schema index — that would pull zod into the bundle). If vite cannot resolve the deep path, add `"exports": { ".": "./src/index.ts", "./src/names": "./src/names.ts" }` to `packages/schema/package.json` — do not fall back to importing the index.
- New color token `--mcp: #bb9af7`. Palette gate: validator on `#9ece6a,#7aa2f7,#e0af68,#bb9af7` vs dark surface — CVD separation and contrast MUST pass (hard stop, report BLOCKED on FAIL); a lightness-band FAIL alone is pre-accepted per the spec (state it in the report, proceed).
- `bun test` FROM THE REPO ROOT (currently 99 pass) + `bunx tsc --noEmit` + dashboard `bun run build` green before every commit; paste actual root tails.
- Commit per task, imperative messages.

---

### Task 1: classifier + collectors

**Files:**
- Create: `packages/schema/src/names.ts`
- Modify: `packages/schema/src/index.ts` (append re-export), `packages/claude-code/src/map.ts:21` (PreToolUse kind), `packages/claude-code/src/transcript.ts:96-99` (tool_use kind)
- Test: `packages/schema/test/names.test.ts`, `packages/claude-code/test/map.test.ts` (append), `packages/claude-code/test/transcript.test.ts` (append)

**Interfaces:**
- Produces (Task 2 relies on these exactly):
```ts
// packages/schema/src/names.ts — MUST NOT import zod or anything else
export function mcpParts(name: string): { server: string; tool: string } | null
export function isMcpTool(name: string): boolean
export function displayKind(kind: string, name: string): string  // 'tool' + mcp name → 'mcp'; else kind unchanged
```

- [ ] **Step 1: Write the failing tests**

`packages/schema/test/names.test.ts`:
```ts
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
```

Append to `packages/claude-code/test/map.test.ts`:
```ts
test('PreToolUse classifies mcp tools as kind mcp', () => {
  const ops = mapHookEvent({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'mcp__claude_ai_Linear__save_issue', tool_use_id: 'tm1', tool_input: {} }, 5)
  expect(ops[0]).toMatchObject({ op: 'span.start', id: 'tool:tm1', kind: 'mcp', name: 'mcp__claude_ai_Linear__save_issue' })
  const plain = mapHookEvent({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tb1', tool_input: {} }, 5)
  expect((plain[0] as any).kind).toBe('tool')
})
```

Append to `packages/claude-code/test/transcript.test.ts`:
```ts
test('transcript tool_use classifies mcp tools as kind mcp', () => {
  const state = newTranscriptState()
  const l = JSON.stringify({ type: 'assistant', message: { id: 'm_mcp', model: 'x', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_mcp', name: 'mcp__engram__mem_save', input: {} }, { type: 'tool_use', id: 'tu_plain', name: 'Read', input: {} }], usage: {} }, uuid: 'u_mcp', timestamp: '2026-07-05T12:00:00.000Z', cwd: '/p/x', sessionId: 'k1' })
  const ops = parseTranscriptLine(l, state)
  const mcp = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:tu_mcp') as any
  const plain = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:tu_plain') as any
  expect(mcp.kind).toBe('mcp')
  expect(plain.kind).toBe('tool')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/schema/test/names.test.ts packages/claude-code/test/map.test.ts packages/claude-code/test/transcript.test.ts`
Expected: FAIL — names module missing; collector kinds still 'tool'.

- [ ] **Step 3: Implement**

`packages/schema/src/names.ts`:
```ts
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
```

Append to `packages/schema/src/index.ts`:
```ts
export { mcpParts, isMcpTool, displayKind } from './names'
```

`packages/claude-code/src/map.ts` — add `isMcpTool` to the existing `@0rrery/schema` import line, and change the PreToolUse case's span.start (line ~21):
```ts
    case 'PreToolUse':
      return [{ op: 'span.start', id: toolSpanId(input, now), sessionId: sid, parentId: null, kind: isMcpTool(input.tool_name ?? '') ? 'mcp' : 'tool', name: input.tool_name ?? '(tool)', ts: now, attrs: { input: input.tool_input ?? null } }]
```

`packages/claude-code/src/transcript.ts` — add `isMcpTool` to the existing `@0rrery/schema` import line, and in the tool_use block (line ~96-99) change `kind: 'tool'` to:
```ts
          kind: isMcpTool(block.name ?? '') ? 'mcp' : 'tool',
```
(everything else in the push unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test` from the repo root (expect 104 pass / 0 fail — 99 + 5 new) and `bunx tsc --noEmit`.
NOTE: the e2e and topology tests use fixtures with no mcp names, so they must pass unchanged — if any existing test breaks, that's a real regression to diagnose, not an expectation to update.
Expected: all green; paste the root tail.

- [ ] **Step 5: Commit**

```bash
git add packages/schema packages/claude-code && git commit -m "Classify MCP tool calls as kind mcp at emit time"
```

---

### Task 2: dashboard — display fallback, server-aggregated topology, palette gate

**Files:**
- Modify: `packages/dashboard/src/topology.ts` (TopoKind, tool branch, COL), `packages/dashboard/src/views/SessionDetailView.tsx:22` (chip), `packages/dashboard/src/views/TopologyTab.tsx` (legend), `packages/dashboard/src/theme.css` (tokens + classes)
- Test: `packages/dashboard/test/topology.test.ts` (append)

**Interfaces:**
- Consumes: `mcpParts`, `displayKind` via `@0rrery/schema/src/names` (deep import — see Global Constraints for the exports-map escape hatch).
- Produces: `TopoKind` gains `'mcp'`; mcp nodes `{ id: 'mcp:<server>', kind: 'mcp', label: '<server>' }` in the tools column.

- [ ] **Step 1: Write the failing test**

Append to `packages/dashboard/test/topology.test.ts`:
```ts
test('mcp tools aggregate by server in the tools column', () => {
  const spans = [
    span('llm:mm', null, 'llm', 'fable'),
    span('tool:m1', 'llm:mm', 'mcp', 'mcp__claude_ai_Linear__save_issue'),
    span('tool:m2', 'llm:mm', 'mcp', 'mcp__claude_ai_Linear__get_issue'),
    span('tool:m3', 'llm:mm', 'tool', 'mcp__engram__mem_save'),   // historical kind, mcp name → still classified
    span('tool:m4', 'llm:mm', 'tool', 'Bash'),
  ]
  const { nodes, edges } = buildTopology(spans)
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]))
  expect(byId['mcp:claude_ai_Linear']).toMatchObject({ kind: 'mcp', label: 'claude_ai_Linear', count: 2 })
  expect(byId['mcp:engram']).toMatchObject({ kind: 'mcp', count: 1 })
  expect(byId['tool:Bash']).toMatchObject({ kind: 'tool' })
  expect(byId['tool:mcp__claude_ai_Linear__save_issue']).toBeUndefined()
  const byKey = Object.fromEntries(edges.map(e => [`${e.from}→${e.to}`, e]))
  expect(byKey['llm:fable→mcp:claude_ai_Linear']).toMatchObject({ calls: 2 })
  // mcp shares the tools column
  const laid = layoutTopology(nodes, edges)
  const laidById = Object.fromEntries(laid.map(n => [n.id, n]))
  expect(laidById['mcp:claude_ai_Linear'].x).toBe(laidById['tool:Bash'].x)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard/test/topology.test.ts`
Expected: FAIL — mcp names land as per-tool `tool:` nodes.

- [ ] **Step 3: Implement**

`packages/dashboard/src/topology.ts`:
- add `import { mcpParts } from '@0rrery/schema/src/names'`
- `export type TopoKind = 'main' | 'agent' | 'llm' | 'tool' | 'mcp'`
- replace the tool branch (lines ~61-66):
```ts
    } else if (s.kind === 'tool' || s.kind === 'mcp') {
      const mcp = mcpParts(s.name)
      const id = mcp ? `mcp:${mcp.server}` : `tool:${s.name}`
      node(id, mcp ? 'mcp' : 'tool', mcp ? mcp.server : s.name)
      const parent = s.parent_id ? byId.get(s.parent_id) : undefined
      if (parent?.kind === 'llm') edge(`llm:${parent.name}`, id, s)
      else edge(ownerOf(s), id, s)
    } else if (s.kind === 'agent') {
```
- `const COL: Record<TopoKind, number> = { main: 0, agent: 1, llm: 2, tool: 3, mcp: 3 }`

`packages/dashboard/src/views/SessionDetailView.tsx` — add `import { displayKind } from '@0rrery/schema/src/names'`; in `WaterfallRow` (line ~22) replace the chip:
```tsx
          <span className={`kind kind-${displayKind(s.kind, s.name)}`}>{displayKind(s.kind, s.name)}</span> {s.name}
```

`packages/dashboard/src/views/TopologyTab.tsx` — add an mcp legend entry after tools:
```tsx
        <span><i className="topo-chip chip-mcp" /> mcp</span>
```

`packages/dashboard/src/theme.css`:
- in `:root`, after `--run: #e0af68;` add ` --mcp: #bb9af7;`
- after `.kind-tool { color: var(--run); }` add `.kind-mcp { color: var(--mcp); }`
- with the other topo chips add `.chip-mcp { background: var(--mcp); }`
- with the other accents add `.topo-accent.accent-mcp { fill: var(--mcp); }`

- [ ] **Step 4: Palette gate**

```bash
node /home/mlayug/.cache/claude-tmp/claude-1000/bundled-skills/2.1.201/106117b5b91581c1c79b021d987a6fe4/dataviz/scripts/validate_palette.js "#9ece6a,#7aa2f7,#e0af68,#bb9af7" --mode dark --surface "#0b0e14" 2>&1 || node /home/mlayug/.cache/claude-tmp/claude-1000/bundled-skills/2.1.201/106117b5b91581c1c79b021d987a6fe4/dataviz/scripts/validate_palette.js "#9ece6a,#7aa2f7,#e0af68,#bb9af7" --mode dark 2>&1
```
Paste full output. Lightness-band FAIL alone: pre-accepted, note and proceed. CVD-separation or contrast FAIL: STOP, report BLOCKED with the output.

- [ ] **Step 5: Verify**

Run: `bun test` from repo root (expect 105 pass / 0 fail), `bunx tsc --noEmit`, `cd packages/dashboard && bun run build && cd ../..`
Expected: all green; paste tails. If vite fails on the deep import, apply the exports-map escape hatch from Global Constraints (schema package.json) and note it.

- [ ] **Step 6: Commit**

```bash
git add packages/schema packages/dashboard && git commit -m "Render MCP spans distinctly; aggregate topology by server"
```

- [ ] **Step 7: Live verification**

```bash
curl -s "localhost:7317/api/sessions/f56f7822-2b63-4860-a522-0e03202916a5" -o /tmp/mcp-check.json
python3 - <<'EOF'
import json, re
d = json.load(open('/tmp/mcp-check.json'))
mcp = [s['name'] for s in d['spans'] if re.match(r'^mcp__(.+?)__(.+)$', s['name'])]
servers = {re.match(r'^mcp__(.+?)__', n).group(1) for n in mcp}
print(f'{len(mcp)} historical mcp-named spans (stored kind tool) across servers: {sorted(servers)}')
print('expected topology: one mcp node per server above, replacing the per-tool mcp__ nodes')
EOF
rm /tmp/mcp-check.json
```
Report the server list. The dashboard serves the new dist per request — human visual check at the Topology tab confirms purple server nodes.

---

## Out of scope (per spec)

`hook` span kind, per-server MCP dashboards, MCP-specific attrs, migrating stored kinds.
