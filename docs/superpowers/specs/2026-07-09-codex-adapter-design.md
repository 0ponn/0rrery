# 0rrery Codex Adapter Design (multi-tool ingestion 1/N)

Date: 2026-07-09
Status: approved pending user spec review
Parent: `2026-07-04-0rrery-rebuild-design.md` (tool-agnostic wire format; sessions carry `source`), `2026-07-05-transcript-tool-end-design.md` (transcript-only ingestion is truthful — the posture Codex inherits).

## Summary

0rrery ingests OpenAI Codex CLI sessions: a sibling adapter package (`packages/codex`) parses `~/.codex/sessions/**/*.jsonl` rollout files into the same `IngestOp` wire format, the tailer/importer/init grow a second root, and the entire read side (trace, topology, fleet, insights, skill) works unchanged with `source: 'codex'`. First proof of the multi-tool thesis; Gemini follows as its own unit once the pattern holds twice.

## Decisions (user-approved 2026-07-09)

- **Codex only** in this unit; not Gemini (different parsing shape: rewrite-on-save JSON), not a speculative adapter SDK.
- **Transcript-tail-only**: no Codex-side hooks. Latency = tail interval; truthfulness already guaranteed by result-driven span ends.
- **Null-honest pricing stands**: gpt-5-family models report tokens with `est_cost: null` unless the user adds prices via `ORRERY_PRICES`.

## Evidence (probed 2026-07-09, 24 real sessions / 375MB on this box)

Typed JSONL, one object per line: `{timestamp, type, payload}`. Observed distribution across 12 files: `response_item/function_call` + `function_call_output` (116 each), `response_item/message` (105), `event_msg/token_count` + `response_item/reasoning` (71 each), `event_msg/agent_message` (64), `turn_context` (17), `session_meta` (12), `web_search_call` (14), task_started/complete (17 each). `session_meta.payload` carries `session_id`, `cwd`, `model_provider`, `cli_version`, `source`. `function_call_output` joins by `call_id`.

## Components

### 1. `packages/codex` — `parseCodexLine(raw: string, state: CodexState): IngestOp[]`

Pure, line-at-a-time, mirroring `parseTranscriptLine`'s contract (garbage line → `[]`, malformed timestamp → fallback ts). Session id from state (seeded by `session_meta`; lines before it are dropped). Mapping:

| Codex line | IngestOps |
|---|---|
| `session_meta` | `session.start` — `sessionId: payload.session_id`, `source: 'codex'`, `project` = cwd basename, meta `{model_provider, cli_version, originator}` |
| `turn_context` | event `turn.context`; `span.start llm:<turn_id>` (kind llm, name = model from turn payload if present else `model_provider`); closes the PREVIOUS turn's llm span (`span.end`, ok) if still open (tracked in state) |
| `event_msg/task_complete` | `span.end` on the open llm turn span (ok); event `turn.stop` |
| `response_item/function_call` | `span.start tool:<call_id>` — kind via the existing `isMcpTool` classification on `name`, attrs `{input: parsed arguments}` (arguments is a JSON string; parse best-effort, raw string on failure). Missing `call_id` → skip |
| `response_item/web_search_call` | same as function_call with name `web_search` (id from its call/item id field — verify exact key against fixture) |
| `response_item/function_call_output` | `span.end tool:<call_id>` — status `error` iff the output text matches `/exited with code [1-9]/` or the payload carries an explicit error marker (verify against fixture), else `ok` |
| `response_item/message` role `user` / `assistant` | `message.user` / `message.assistant` events with 200-char previews (developer/system roles skipped). The `event_msg/user_message`/`agent_message` duplicates are NOT emitted (one source of truth) |
| `event_msg/token_count` with non-null `info` | token attrs merged onto the OPEN llm turn span via `span.start` upsert semantics (`input_tokens`/`output_tokens` from the info object's usage fields — exact key names verified against fixture during implementation; cumulative counters must be diffed against state, not summed raw, if the fixture shows monotonic totals) |
| `reasoning`, `developer` messages, `exec_command_*`/`task_started` event_msgs, rate-limit-only token_counts, everything else | skipped, deliberately |

EOF finalization mirrors the importer's existing behavior: any spans still open at import-finalize close `ok` at max-ts (live tailing leaves them open — truthful "running").

### 2. Wiring

- **Tailer**: `startTailer` gains a parser parameter (`(raw, state) => IngestOp[]` + a state factory); `serve` runs TWO tailers — the existing Claude one and a Codex one over `ORRERY_CODEX_DIR ?? ~/.codex/sessions` (recursive glob `**/*.jsonl`, no subagent-dir special case). Offsets share the existing snapshot file (keyed by absolute path — already collision-free). **Amended post-review: shipped as a SEPARATE `codex-offsets.json` — sharing one file was wrong, since `loadOffsets` applies a single revive function to every entry and mixed adapter states would corrupt. Per-adapter offset files are the pattern.**
- **Import**: `0rrery import <file>` sniffs line 1 — `"type":"session_meta"` → codex parser, else Claude. `import --all` and `init` sweep both roots (each skipped silently if the dir is absent).
- **Config**: `ORRERY_CODEX_DIR` env + config field, defaulting to `~/.codex/sessions`.

### 3. Read side

Zero required changes: sessions table already carries `source`; spans/events are tool-agnostic; fleet/insights/skill/topology consume kinds, not tools. Two touches only: the sessions list's Source column now shows `codex` (already rendered), and the skill's intro line mentions Codex sessions are covered. Codex sessions have no hook events, so fleet pending-permissions is simply empty for them (correct).

## Error handling

- Rollout files predating `session_meta` conventions or with unknown types: skipped lines, never a throw.
- `function_call_output` with no matching open span: store's orphan-placeholder path (existing).
- Sessions without `task_complete` (crashed): llm turn span stays open live; closes at import-finalize.

## Testing

- Fixture `packages/codex/fixtures/codex1.jsonl`: built from a REAL rollout file, sanitized (paths genericized, text truncated), covering every mapped type + one unknown type + one pre-meta line.
- Parser TDD against the mapping table (incl. call_id join, error-status detection, token merge, duplicate-message suppression, turn-span close on next turn_context).
- E2E: import the fixture → session with `source: 'codex'`, correct span kinds/counts, summary endpoint answers.
- Live rollout: deploy, `0rrery import --all` (now sweeping ~/.codex too — 24 real sessions), then eyeball the c0mbwell Codex session's trace + topology in the browser and its `/summary`; sessions list shows codex sources. Observed evidence only.

## Out of scope

Gemini CLI (next unit), adapter-SDK docs, Codex hooks/notify integration, gpt-5 price entries (user-overridable), backfill of Codex sessions older than the rollout format in evidence.
