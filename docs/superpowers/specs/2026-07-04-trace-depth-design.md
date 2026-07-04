# 0rrery Trace Depth Design (0PO-432)

Date: 2026-07-04
Status: approved pending user spec review
Linear: 0PO-432. Parent spec: `2026-07-04-0rrery-rebuild-design.md`.

## Summary

Closes the v1 spec drift found by the final whole-branch review: subagent activity becomes `agent` span subtrees in the trace, permission prompts become typed paired events, and compaction becomes visible. Also fixes a v1 coverage hole: the tailer never read subagent transcript files.

## Evidence (verified 2026-07-04, Claude Code 2.1.201)

- Subagent transcripts live at `<projectsDir>/<project>/<sessionId>/subagents/agent-<agentId>.jsonl`. Lines carry `sessionId` (the parent session), `agentId`, `isSidechain: true`, `attributionAgent` (agent type), plus the standard user/assistant shapes.
- The parent transcript's Agent `tool_use` result text contains `agentId: <id>` for linkage.
- Compaction: `{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger","preTokens","durationMs",...}}` and follow-up user lines with `isCompactSummary: true`.
- Hooks (per current docs, code.claude.com/docs/en/hooks): `PermissionRequest` and `PermissionDenied` both deliver `tool_use_id`, `tool_name`, `tool_input`, `permission_mode`; `PermissionRequest` adds `permission_reason`. `Notification` carries `notification_type` (`permission_prompt` | `idle_prompt` | ...). `PermissionDenied` fires only for auto-mode denials; a user-clicked deny fires no hook.

## Decisions

| Decision | Choice |
|---|---|
| Agent span parentage | Linked under the spawning `tool:<toolu_id>` span via agentId extraction from Agent tool_result text; session root fallback when no match |
| Permission pairing | Stateless emit + read-time resolution: emit `permission.requested` and explicit denials only; allowed/pending derived from span state at read time |
| User-clicked denials | Read as `pending` in v1 (no hook fires); documented, not faked |
| `mcp` / `hook` span kinds | Still out of scope — no evidence source identified; drift remains explicit |

## Collection

**Tailer/importer recursion.** The tailer scan adds `<project>/<sessionId>/subagents/*.jsonl`; each agent file gets its own byte offset and `TranscriptState` with the existing retry/idempotency semantics. `0rrery import <session.jsonl>` also imports the sibling `<sessionId>/subagents/` dir when present.

**Agent spans (parser).** Parsing an agent file (detected by `agentId` present on lines):
- First line: `span.start` id `agent:<agentId>`, kind `agent`, name = `attributionAgent` (fallback `(agent)`), sessionId from the line. No `session.start` is emitted from agent files (the parent session owns that).
- llm spans from that file get `parentId: agent:<agentId>`; tool spans keep their existing llm parent, so the chain reads agent → llm → tool. Events carry `spanId` as today plus `attrs.agentId`.
- Each pass ends with `span.end` id `agent:<agentId>` at the max ts seen, status `ok` — re-emission ratchets `ended_at` forward via the existing span.end update path.

**Linkage.** When the parent-session parser sees an Agent `tool_result` whose text matches `/agentId: (a[0-9a-f]{6,})/`, it emits `span.start` `{id: agent:<match>, parentId: tool:<tool_use_id>, kind: agent, name: '(agent)', ts}` — the store's merge upsert COALESCEs parent_id regardless of which file was ingested first, and name/attrs from the richer agent-file emission win by later merge.

**Compaction.** `compact_boundary` → event `session.compact`, id `evt:compact:<uuid>`, attrs `{trigger, preTokens, durationMs}`. `isCompactSummary` user lines are suppressed from `message.user` and emit `session.compact_summary` (id `evt:msg:<uuid>`, preview attr) instead.

**Permission events (hook emitter).**
- `PermissionRequest` → event `permission.requested`, id `evt:perm:req:<tool_use_id>`, spanId `tool:<tool_use_id>`, attrs `{tool: tool_name, reason: permission_reason, mode: permission_mode}`.
- `PermissionDenied` → event `permission.resolved`, id `evt:perm:res:<tool_use_id>`, spanId `tool:<tool_use_id>`, attrs `{outcome: 'denied', source: 'auto'}`.
- `Notification` mapping adds `attrs.notification_type`.
- `installHooks` gains `PermissionRequest` and `PermissionDenied` in `HOOK_EVENTS` (no matcher); re-running `0rrery install` on an existing install adds only the new events (existing idempotent merge).

## Read side

- `permissionStatus(events, spans)` pure helper in the dashboard: for each `permission.requested` → `denied` if a matching `permission.resolved` exists; `allowed` if the span at `spanId` has `ended_at` set (it ran); else `pending`. Rendered as a badge on the span row and typed rows in the events tab.
- `session.compact` events render trigger + preTokens in the events tab.
- No new views; agent subtrees appear via existing tree builder + `.kind-agent` styling.

## Testing

- New golden fixtures: `fixtures/agent.jsonl` (subagent file shape) and additions to the parent fixture: Agent tool_use + tool_result containing `agentId: afixture01`, one `compact_boundary` line, one `isCompactSummary` line.
- Parser TDD: agent span emission + parenting, linkage regex emission, compact event, summary suppression, no session.start from agent files.
- Hook mapping TDD: PermissionRequest/PermissionDenied payloads (documented schemas) → exact ops; Notification carries notification_type.
- Tailer: subagents dir discovered with independent offsets.
- `permissionStatus`: all three outcomes (allowed, denied, pending) plus the no-request case.
- E2E: import parent + subagent fixtures → detail API shows agent subtree (agent span parented under the tool span) and permission events.

## Rollout

No schema migration; wire format unchanged. Post-merge: `0rrery install` (adds two hook events), `systemctl --user restart 0rrery`; restart backfill retro-fits subtrees onto historical sessions.

## Out of scope

Tailer offset persistence, active-status staleness rule, user-clicked-deny detection, `mcp`/`hook` span kinds, permission analytics.
