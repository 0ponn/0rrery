# Dogfood Findings — 2026-07-05

Browser walkthrough of the live dashboard (sessions list, trace, events, topology, live feed) plus API probes against this session (f56f7822, 4046 spans) and an imported session (caa90c18, 390 spans).

## P0 — tool spans never close without hooks (data correctness)

879 of 2022 tool spans in this session show `running` forever; in the imported session it is 100% of them. Root cause: the transcript parser emits tool `span.start` at each `tool_use` block (`transcript.ts:110`) but tool `span.end` comes ONLY from the PostToolUse hook (`map.ts:26`), which is lossy live and absent entirely for imports. The `tool_result` block is the ground truth for completion (with `is_error` for status) and the parser already scans exactly those blocks for denial and agent linkage.

Fix shape: emit `span.end` for `tool:<tool_use_id>` at every tool_result, status `error` when `is_error`, else `ok`. Idempotent with the denial end and the hook end (same ID, MAX ratchet). This matters doubly for self-host: `0rrery import` is the first-run experience, and today it renders a wall of fake-running orange bars.

## P1 — trace/events views struggle on large active sessions

Opening this session's detail (4044 spans, flat DOM, live WS updates) froze the tab; the Events tab (1056 rows) wedged it for 45s+. Some later stalls were CDP tooling flakiness, but the initial freeze was real. Needs: virtualized rows (or collapse-by-turn), and live-update batching/pausing on the detail view. An active session re-rendering everything per WS batch compounds with size.

## P1 — spans are not clickable

No span detail panel exists; span rows are not interactive elements. There is no way in the UI to see a span's attrs (Bash command, token counts, `denied: true`, MCP server), which is where half the trace value lives.

## P2 — sessions list polish

- Durations unhumanized and misleading: `25717m 35s` (≈18 days) — duration is last_event − first_event even for stale sessions. Humanize (`2h 14m`, `18d`) and consider capping display for stale.
- Started column is time-only (`08:55:32`) — no date; ambiguous for anything older than today.
- api-source junk rows: `—` project, 0ms duration (test batches). Filter or group them.
- No project filter and no search; only the status dropdown. 118 sessions already.

## P2 — live feed end-rows lack context

Span-end rows render as `■ span ok` with no span name or session — you cannot tell what ended. Start rows carry name + session; end rows should too.

## P3 — misc

- Topology renders an `(unknown)` agent node when linkage produced a placeholder that never got a name upgrade.
- No time axis on the trace waterfall.
- Error page for a bad session ID is graceful (good).
- Topology at 4046 spans renders fine (good).
- Live feed showed this session's own browser-automation MCP spans in real time (good — the meta-dogfood works).
