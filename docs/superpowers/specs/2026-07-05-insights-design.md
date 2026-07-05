# 0rrery Insights Design (durable-value arc, sub-project 1 of 3)

Date: 2026-07-05
Status: approved pending user spec review
Parent: `2026-07-04-0rrery-rebuild-design.md`. Arc siblings (later specs): agent introspection skill (consumes these endpoints), fleet view.

## Summary

A read-only cross-session insights layer: aggregation endpoints over the existing SQLite answering spend, tool health, project rollups, sprawl (global topology, external surface, filesystem footprint), and session search — plus an Insights dashboard tab. No schema changes, no ingest changes; derive at read time, the pattern every prior unit used.

## Decisions (user-approved 2026-07-05)

- **V1 scope:** spend over time, tool health, project rollups, session search, and the sprawl map covering all three sub-scopes (global topology, external surface, filesystem footprint).
- **Architecture:** query-time SQL with `json_extract` over existing tables. Escape hatch documented: materialize fact tables if a DB approaches ~1M spans; not before.
- **Cost is estimated:** static price map, everything labeled estimated; unknown models report tokens with null cost.
- **Skill-ready API:** compact, filter-complete responses — sub-project 2 consumes these endpoints verbatim.

## Evidence (probed 2026-07-05)

Live DB: 81,534 spans / 28,958 events / 72.4MB. Transcript-sourced tool spans carry `attrs.input` (transcript.ts:111): 15,346 with `input.file_path`, 849 with `input.url`, 18,297 with `input.command` across 41,757 tool/mcp spans. LLM spans carry model name + token attrs (existing rollup). All raw material for every v1 question is already ingested.

## Components

### 1. Query layer — `packages/server/src/insights.ts`

Pure functions `(db, filters) → plain objects`; every function accepts optional `{ project, from, to }` (epoch ms; from/to filter on span/event `ts`/`started_at`; project via the sessions table join). Exports:

- `spendSeries(db, f)` → `[{ day: 'YYYY-MM-DD', model, tokens_in, tokens_out, est_cost | null }]` from llm spans grouped by UTC day × model (× project when unfiltered views need it: include `project` in each row).
- `toolHealth(db, f)` → `[{ name, kind: 'tool'|'mcp', calls, errors, denials }]` — errors from `status='error'`, denials from `permission.resolved` events with `outcome:'denied'` joined by spanId, sorted by calls desc.
- `projectRollups(db, f)` → `[{ project, sessions, wall_ms, tokens_in, tokens_out, est_cost | null, subagents }]` — wall_ms = Σ session (last−first); subagents = agent-kind span count.
- `sprawlMap(db, f)` → same node/edge shape the per-session topology view consumes (`packages/dashboard` topology contract), aggregated across sessions: agent-name → model → tool/mcp edges with call weights. Reuse/extract the existing per-session aggregation SQL rather than duplicating it — if the current topology query is dashboard-side, move the shared shape server-side and have both consume it.
- `externalSurface(db, f)` → `{ domains: [{ host, calls, tools: [...] }], mcp: [{ server, tools: [{ name, calls }] }] }` — hosts from `input.url` (WebFetch/WebSearch) plus best-effort `https?://host` regex over `input.command` (Bash); MCP grouping by the existing `mcp__server__tool` name convention.
- `fsFootprint(db, f)` → `{ dirs: [{ path, touches, reads, writes }], files: [same shape] }` — from `input.file_path` on Read/Write/Edit/NotebookEdit spans; each list top-100 by touches (dirs = the file's parent directory). Paths reported as-is (local tool, no privacy transform).
- `searchSessions(db, f & { q, status })` → the existing sessions-list row shape filtered by `LIKE %q%` over the session's first `message.user` preview and project name, plus project/status/date filters.

### 2. Prices — `packages/server/src/prices.ts`

Static `{ modelPrefix: { in: $/Mtok, out: $/Mtok } }` for the Claude family (longest-prefix match so dated model IDs hit). Unknown model → null cost, never a guess. `ORRERY_PRICES=<path to JSON>` merges user overrides over defaults at load. All cost fields are named `est_cost` — the UI labels them "est."

### 3. API — `packages/server/src/server.ts`

`GET /api/insights/spend | tool-health | projects | sprawl | surface | footprint`, all accepting `project`, `from`, `to` query params (validated: non-numeric from/to → 400). `GET /api/sessions` gains `q`, `project`, `from`, `to` (status filter exists). Responses are the query-layer objects verbatim.

### 4. Dashboard — Insights tab

New top-level tab alongside Sessions/Live, with a project + date-range filter row applying to all panels:

- Spend: stacked bar chart, day × model (dataviz procedure at implementation: palette validated, one axis, direct labels).
- Tool health: table (name, kind badge, calls, error %, denials), error % emphasized when > 5%.
- Projects: rollup table.
- Sprawl: the existing topology renderer fed by `/api/insights/sprawl`.
- Surface: domains + MCP servers lists with counts.
- Footprint: top directories per selected project.

Sessions page gains the search box + project filter wired to the extended `/api/sessions`.

### 5. Skill-readiness constraint

Every endpoint answers its question in ONE response (no pagination needed for summaries; footprint/surface capped at top-100 rows). This is the contract sub-project 2 builds on; breaking it later means reworking the skill.

## Error handling

- Invalid `from`/`to` → 400 with message; empty ranges/filters → empty arrays, HTTP 200.
- Null-cost rows render tokens without $; the spend panel footnotes "estimated; unknown models excluded from $".
- Malformed `attrs` JSON rows are skipped by `json_extract` returning null — no throwing paths.

## Testing

- Unit: each insights function against a fixture-built DB (existing e2e harness pattern) covering filters, denial/error counting, prefix price matching, unknown-model null cost, URL-host extraction (incl. a curl-in-Bash case), and footprint dir aggregation.
- E2E: each endpoint status + shape; 400 on bad params; sessions search.
- Live perf gate at rollout: every endpoint < 500ms against this box's real 72MB DB (curl timing, observed numbers reported). If any endpoint misses, add the narrow index it needs (allowed: CREATE INDEX, still no table changes) and re-measure.

## Out of scope

Fact-table materialization (escape hatch only), the agent skill (sub-project 2), fleet view (sub-project 3), Bash-command deep parsing beyond URL extraction, dollar-accurate billing (estimates only), auth/multi-user.
