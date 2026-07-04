# 0rrery Rebuild Design

Date: 2026-07-04
Status: approved pending user spec review

## Summary

Ground-up rewrite of Orrery (now 0rrery) from a D3 force-graph demo into a trace-first observability platform for AI agent workflows. Local-first single process with clean seams for later self-hosting. v2 code is deleted, not migrated; git history keeps it.

## Decisions

| Decision | Choice |
|---|---|
| Scope | Ground-up product rewrite |
| Deployment | Local-first, self-hostable later; no tenancy in v1 |
| Core job | Trace/debug agent runs; live view and analytics derive from trace data |
| Event model | Custom lean schema; OTel export deferred |
| Sources v1 | Claude Code (deep) + generic HTTP ingest; process scanning dropped |
| Stack | Bun + TypeScript, `bun:sqlite`, React + Vite dashboard |
| Composition | Modular monolith: one Bun process, monorepo workspaces |

## Architecture

```
0rrery (one Bun process)
├── POST /api/ingest       ← hooks, tailer, SDKs, anything
├── WS   /api/live         → dashboard live updates (per-session or firehose)
├── GET  /api/sessions     ← filter/paginate
├── GET  /api/sessions/:id ← full span tree + events
├── GET  /api/stats
└── /                      → built React dashboard (static)

packages/
├── schema/        event types + zod validation (shared by server + emitters)
├── server/        ingest, store, query, live bus
├── dashboard/     React/Vite trace UI
└── claude-code/   hook emitter + transcript tailer + install/import CLI
```

## Data model

SQLite, WAL mode. Three tables; topology, metrics, and live feed are queries over them. No separate graph model.

**sessions** — one per agent session.
`id` (stable Claude Code session ID or client-supplied), `source` (`claude-code` | `api`), `project`, `cwd`, `git_branch`, `started_at`, `last_event_at`, `status` (`active` | `ended`), `meta` JSON.

**spans** — units of work with duration, forming a tree via `parent_id`. This is the trace.
`id`, `session_id`, `parent_id`, `kind` (`agent` | `tool` | `llm` | `mcp` | `hook` | `custom`), `name` (e.g. `Bash`, `subagent:Explore`), `started_at`, `ended_at` (null while running), `status` (`running` | `ok` | `error`), `attrs` JSON (tokens, cost, tool input digest, exit codes).

**events** — point-in-time facts, optionally attached to a span.
`id`, `session_id`, `span_id?`, `ts`, `type` (`permission.requested`, `permission.resolved`, `message.user`, `message.assistant`, `session.compact`, `agent.handoff`, ...), `attrs` JSON.

Token/cost lives in `attrs` on `llm` spans; promote to columns only when a query needs an index.

## Wire format

`POST /api/ingest` takes a JSON array of operations:

```json
[
  {"op": "span.start", "id": "...", "sessionId": "...", "parentId": null, "kind": "tool", "name": "Bash", "ts": 0, "attrs": {}},
  {"op": "span.end",   "id": "...", "ts": 0, "status": "ok", "attrs": {}},
  {"op": "event",      "id": "...", "sessionId": "...", "type": "permission.requested", "ts": 0, "attrs": {}}
]
```

Client-generated IDs make ingest idempotent: retries and duplicate hook fires are safe (upsert on ID). Types and zod validators live in `@0rrery/schema` and are shared by server and emitters.

## Claude Code integration (`@0rrery/claude-code`)

Two collectors at different depths, both emitting the shared wire format:

1. **Hook emitter** — one Bun script registered for `SessionStart`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`. Pre/Post pairs become `tool` span start/end; permission prompts become events. Fail-open: fire-and-forget POST with a ~200ms budget; never blocks or breaks Claude Code if 0rrery is down.
2. **Transcript tailer** — watches `~/.claude/projects/*/*.jsonl` for what hooks cannot see: assistant/user messages, subagent spawns, per-call token usage, compaction. Backfills depth into the same sessions (same session IDs). Also enables importing past sessions recorded without hooks.

CLI: `0rrery install` wires hooks into `~/.claude/settings.json`; `0rrery import <transcript>` backfills history.

**Generic ingest** — anything can POST the wire format. No auth locally; bearer-token check behind a config flag is the self-host seam.

## Server

- `Bun.serve`, one process. Ingest batches write in a single SQLite transaction, then publish to an in-process live bus fanning out over `WS /api/live`.
- Config in `0rrery.config.ts`: port, db path, retention days. Retention sweep on startup.
- Invalid ingest items are rejected item-by-item (valid items still land); rejects go to a dead-letter JSONL so instrumentation bugs are visible.

## Dashboard

React + Vite + TypeScript, three views:

- **Sessions** — filterable table (project, status, date); landing page.
- **Session detail** — the core screen: trace waterfall (span tree with durations, expandable attrs), synchronized event feed, token/cost rollups. Live sessions stream over WS; ended sessions render from the query API.
- **Live** — currently running sessions with a real-time feed.

The v2 topology force-graph returns later as a tab in Session detail, derived from spans. Not in v1. Visual design follows the frontend-design/dataviz skills at build time; no component-library decision in this spec.

## Testing

- `bun test` throughout.
- `@0rrery/schema`: round-trip validation tests.
- Server: ingest→query integration tests against a temp SQLite file.
- Transcript tailer: golden-fixture tests using a real recorded session JSONL in `fixtures/`.
- Emitters never throw into their host process.

## Repo transition

Clean slate on `main`: first commit deletes all v2 code and scaffolds the Bun monorepo. Package scope `@0rrery/*`. Any usable v2 session JSONL becomes a test fixture. All `orrery` naming becomes `0rrery`.

## Out of scope for v1

OTel export, hosted/multi-tenant deployment, auth beyond the token flag, topology graph view, non-Claude-Code agent integrations (Gemini CLI/Codex/Cursor), process scanning, analytics dashboards beyond per-session rollups.
