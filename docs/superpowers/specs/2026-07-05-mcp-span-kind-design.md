# 0rrery MCP Span Kind Design

Date: 2026-07-05
Status: approved pending user spec review
Parent specs: `2026-07-04-0rrery-rebuild-design.md` (schema enum has `mcp` unused since v1), `2026-07-04-trace-depth-design.md` (deferred it for "no evidence source"). Evidence source: the `mcp__<server>__<tool>` tool-name convention, confirmed in live data.

## Summary

MCP tool calls become `kind: 'mcp'` at emit time in both collectors; the dashboard applies a display fallback so historical `kind: 'tool'` spans with mcp names render identically — no migration, no kind-rewriting merge rules. Topology aggregates MCP by server, which also fixes the tracked label-truncation-collision debt.

## Decisions

| Decision | Choice |
|---|---|
| Classification | Emit-time in both collectors + read-time display fallback for history; stored kinds never mutated |
| Classifier home | `packages/schema/src/names.ts` — re-exported from the schema index for collectors; deep-imported (`@0rrery/schema/src/names`) by the dashboard so zod stays out of the bundle |
| Topology aggregation | MCP nodes keyed by SERVER (`mcp:<server>`), not per tool; tools column, mcp accent |
| Color | `--mcp: #bb9af7`; four categorical kinds = CVD floor — validator must PASS CVD separation (hard stop on FAIL); direct labels already satisfy the secondary-encoding requirement |

## Classifier (`packages/schema/src/names.ts`)

```ts
export function mcpParts(name: string): { server: string; tool: string } | null
// /^mcp__(.+?)__(.+)$/ — lazy server match: splits at the first '__' after the prefix. Correct because
// server names use single underscores internally (claude_ai_Linear, plugin_cloudflare_cloudflare-api);
// '__' appears only as the delimiter. Tool names containing '__' land in the greedy tail. Pin both in tests.
export function isMcpTool(name: string): boolean
```
Degenerate names (`mcp____x`, `mcp__a`) must return null / false, never throw.

## Collectors

- `packages/claude-code/src/map.ts` (PreToolUse): `kind: isMcpTool(tool_name) ? 'mcp' : 'tool'`.
- `packages/claude-code/src/transcript.ts` (tool_use blocks): same expression on `block.name`.
- Span IDs unchanged (`tool:<tool_use_id>`); hook and transcript classify from the same name so merge sides always agree. Historical spans keep stored `kind: 'tool'`; offset persistence prevents re-parse churn.

## Dashboard

- `displayKind(kind, name)` (in `names.ts`): returns `'mcp'` when `kind === 'tool' && isMcpTool(name)`, else `kind` — the history fallback.
- Waterfall chip uses `displayKind`; new `kind-mcp` CSS with `--mcp: #bb9af7` added to `:root`.
- Topology (`buildTopology`): a tool-or-mcp span whose name has `mcpParts` becomes node `mcp:<server>` (kind `mcp`, label `<server>`, count aggregated across all that server's tools); edges `llm:<model> → mcp:<server>` (or owner → server for hook-only). Non-mcp tools unchanged. `layoutTopology` places `mcp` in the tools column (column 3). Legend gains an mcp chip; node accent `accent-mcp`.
- `permissionStatus`, `tokenRollup`, waterfall tree building: unaffected (keyed by span id / kind `llm`).

## Palette gate

Run the dataviz validator on all four hues (`#9ece6a,#7aa2f7,#e0af68,#bb9af7`) against the dark surface. CVD adjacent-pair separation and contrast MUST pass (hard stop back to controller on FAIL). A lightness-band FAIL is expected and accepted under the same recorded rationale as the topology unit (accent bars, triple-encoded identity).

## Testing

- `names.ts` TDD: normal mcp names, plugin-prefixed servers, non-mcp names, degenerate `mcp____x` / `mcp__a`, `displayKind` fallback matrix (tool+mcp-name → mcp; mcp+any → mcp; tool+plain → tool; llm/agent passthrough).
- Collector tests: PreToolUse with `mcp__claude_ai_Linear__save_issue` → `kind: 'mcp'`; transcript tool_use same; plain `Bash` still `tool` (both sides).
- Topology: fixture with two tools of the same MCP server → one `mcp:<server>` node, count 2, edge from the calling model; non-mcp tool unaffected; e2e assertions updated only if the existing fixture contains mcp names (it does not — verify).
- Validator output recorded in the report.

## Out of scope

`hook` span kind (no emission source identified), per-server MCP dashboards, MCP-specific attrs (latency percentiles, error taxonomies), migrating stored kinds.
