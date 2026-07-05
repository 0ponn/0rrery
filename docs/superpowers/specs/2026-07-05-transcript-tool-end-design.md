# 0rrery Transcript-Side Tool Span Ends

Date: 2026-07-05
Status: approved pending user spec review
Parent: `docs/dogfood-findings-2026-07-05.md` (P0 finding), `2026-07-05-user-deny-detection-design.md` (established the tool_result-scan pattern this generalizes).

## Summary

Every `tool_result` block in the transcript closes its tool span: `span.end` on `tool:<tool_use_id>` with status `error` when `is_error`, else `ok`. Tool spans stop rendering "running" forever; imported sessions render truthfully end to end.

## Evidence (probed 2026-07-05, live dashboard walkthrough)

- 879 of 2022 tool spans in the current dogfood session (hooks active) have no `ended_at`; in a fresh-imported session it is 100%. The waterfall renders full-width "running" bars for all of them.
- Tool `span.start` is emitted by both the PreToolUse hook and the transcript parser (`transcript.ts:110`, from assistant `tool_use` blocks), but `span.end` comes only from the PostToolUse hook (`map.ts:26`) — lossy live (no PostToolUse for errors/interrupts in some paths, dropped batches) and absent entirely for `0rrery import`.
- The transcript's `tool_result` block is the completion ground truth: it carries `tool_use_id` and `is_error`, and the parser already iterates exactly these blocks (denial detection, agent linkage).

## Change

**`packages/claude-code/src/transcript.ts`** — restructure the user-array-content branch into one loop over `tool_result` blocks (with `tool_use_id`); per block:

1. If `line.toolUseResult === 'User rejected tool use'`: the existing denial pair, unchanged (`permission.resolved` + `span.end` status `error`, attrs `{denied: true}`). No additional generic end for these blocks.
2. Otherwise: `{ op: 'span.end', id: 'tool:<tool_use_id>', ts, status: block.is_error ? 'error' : 'ok', attrs: {} }`.
3. The agent-linkage scan runs for the block regardless (an Agent tool_result now also closes its `tool:` span — correct: the subagent is done).

Interactions, all verified semantics from prior units: hook PostToolUse may also end the same span — same ID, MAX-ratchet `ended_at`, last-write status, both report the same outcome; store's orphan placeholder covers ends arriving before any start; ordinary erroring tools now render red (`is_error` → `error`), which is truthful.

## Read side

Zero changes. Waterfall stops showing eternal "running"; `permissionStatus` unaffected (denied still derived from the event).

## Testing

- Parser TDD: ok tool_result → single `span.end` status `ok`; `is_error: true` (non-denial) → status `error`; denial line → exactly the denial pair, no second end for the same block.
- Fixture ripple: `fix1.jsonl` already carries tool_results (`toolu_t01`, `toolu_ag1`); e2e gains their ends — update the affected span-status assertions deliberately.
- Live rollout: re-import a transcript and verify zero open tool spans in the imported session.

## Rollout note

Insert-only posture as always: already-tailed history back-fills only via fresh import or file growth. The live tailer starts closing spans on service restart.

## Out of scope

Waterfall virtualization (P1), span detail panel (P1), sessions-list polish (P2) — separate units from the findings doc.
