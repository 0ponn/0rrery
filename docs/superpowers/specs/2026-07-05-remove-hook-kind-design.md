# 0rrery: Remove the `hook` Span Kind

Date: 2026-07-05
Status: approved pending user spec review
Parent specs: `2026-07-04-0rrery-rebuild-design.md` (introduced the enum value), `2026-07-04-trace-depth-design.md` and `2026-07-05-mcp-span-kind-design.md` (both deferred it: "no emission source identified").

## Summary

`'hook'` is removed from the `SpanKind` enum. It has never been emitted, no evidence source for it exists, and carrying it is speculative surface that every review cycle re-litigates. Closure, not deferral.

## Evidence (probed 2026-07-05)

Transcripts do not record hook executions. A sweep of the six most recent session files — covering a session in which 0rrery's own seven hooks plus rtk and superpowers hooks fired hundreds of times — found no hook names, commands, durations, or per-invocation lines. The only hook-adjacent artifacts are a payload-free `system/stop_hook_summary` marker and incidental text mentions. Hook input schemas (current Claude Code docs) confirm hooks receive data; nothing reports on their execution.

## Alternatives rejected

- **Self-instrumentation** (0rrery's hook timing itself): observes only our own collector, not the user's other hooks. No trace value.
- **Command-wrapper shims** (`0rrery install` rewriting all configured hook commands): full observability at the cost of mutating configuration 0rrery does not own — upgrade hazards and a breakage surface contrary to the fail-open collector ethos. If ever wanted, it needs its own brainstorm and spec.
- **Keep as documented-reserved**: carries dead surface indefinitely; re-adding an enum value later is trivial, so reservation buys nothing.

## Change

- `packages/schema/src/index.ts`: remove `'hook'` from the `SpanKind` type union and from the `z.enum` list in `SpanStartSchema`. These are the only two occurrences in the codebase (no collector, dashboard kind, CSS class, or test references it).
- New schema test pinning that `kind: 'hook'` is now rejected item-wise by `parseOps` (deliberate, visible closure — not an accident a future reader must guess at).
- No data migration: no stored span has ever carried the kind (verifiable against the live DB in rollout).

## Re-add path

If Claude Code ships hook-execution telemetry, re-adding the enum value is a one-line change that must arrive with a real spec defining the emitter, IDs, and rendering.

## Testing

The rejection pin plus the full suite (nothing else may change). Rollout verification: `SELECT COUNT(*) FROM spans WHERE kind='hook'` equivalent via the API confirms zero historical rows.

## Out of scope

Wrapper-based hook observability, dashboard changes (nothing rendered the kind), touching parent specs (historical record).
