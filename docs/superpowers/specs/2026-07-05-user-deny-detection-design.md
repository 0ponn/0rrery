# 0rrery User-Deny Detection Design

Date: 2026-07-05
Status: approved pending user spec review
Parent spec: `2026-07-04-trace-depth-design.md` (documented user-clicked denials as "pending in v1 — no hook fires"; this closes that gap from the transcript side).

## Summary

User-clicked permission denials become `permission.resolved` events with `outcome: 'denied', source: 'user'`, derived from the transcript's structured rejection marker. The denied tool span is closed as `error` instead of showing "running" forever. The dashboard needs zero changes — `permissionStatus` already resolves these.

## Evidence (probed 2026-07-05)

- Denied tool calls produce a user line whose **line-level** `toolUseResult` field equals exactly `"User rejected tool use"` (string), alongside a `tool_result` block with `is_error: true` and the canonical prose. 8 occurrences across the 40 most recent sessions; the marker is disjoint from all error-string values (`Error: Exit code 1`, ENOENT variants, etc.).
- `toolUseResult` is string-valued only for rejections/errors; ordinary tool outputs carry objects. Detection is exact string equality — no text pattern matching.
- Interrupted requests (escape) do not produce this marker and are correctly excluded: denied means denied.
- Hook-side detection remains impossible per current docs: `PermissionDenied` fires only for auto-mode denials; a user-clicked deny fires no hook.

## Change

**`packages/claude-code/src/transcript.ts`** — extend the `Line` type with `toolUseResult?: unknown`. On user lines with array content where `line.toolUseResult === 'User rejected tool use'`, for each `tool_result` block carrying a `tool_use_id`, emit:

1. `{ op: 'event', id: 'evt:perm:res:<tool_use_id>', sessionId, spanId: 'tool:<tool_use_id>', type: 'permission.resolved', ts, attrs: { outcome: 'denied', source: 'user' } }` — same ID scheme as the auto-deny hook event; idempotent ingest dedupes if both exist.
2. `{ op: 'span.end', id: 'tool:<tool_use_id>', ts, status: 'error', attrs: { denied: true } }` — closes the span PreToolUse opened (no PostToolUse ever fires for a denied tool). The store's orphan-placeholder path covers hook-less sessions where no span.start preceded it.

The existing agent-linkage scan over the same block list is unaffected (denial results never contain `agentId:` text; even if one did, the Agent-tool_use gate excludes it).

## Read side

Zero changes. `permissionStatus` checks denied before ended, so the badge flips `pending → denied`; the waterfall renders the span error-red with `denied: true` in its attrs instead of eternally running.

## Testing

- Parser TDD: denial line → exactly the two ops per tool_result (plus nothing else); ordinary string `toolUseResult` values (`Error: Exit code 1`) → no denial ops; denial line whose blocks lack `tool_use_id` → nothing; object-valued `toolUseResult` → nothing.
- Fixture: append a denial line to `fixtures/fix1.jsonl` (tool_use + rejection result pair) and update the affected fixture-count assertions deliberately (e2e event list gains one `permission.resolved`; spans gain one tool span ending error).
- Live rollout check: after restart, at least one historical session shows a `denied` badge (8 known denials exist in recent history — offset persistence means only newly-tailed or imported files re-parse; verify via `0rrery import` of one known-denial transcript or accept that history back-fills only on snapshot reset, and state which in the report).

## Rollout note

Offset persistence means already-tailed files are NOT re-parsed, so historical denials appear only for sessions imported fresh (`0rrery import`) or files that grow past their offsets. This is the standard insert-only posture (same as compact-summary retro-typing); note it, don't fight it.

## Out of scope

Interrupted-request tracking (no marker exists), hook-side detection (impossible per docs), deny-reason capture, forced re-parse of history.
