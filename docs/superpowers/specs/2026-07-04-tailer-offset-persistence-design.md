# 0rrery Tailer Offset Persistence Design

Date: 2026-07-04
Status: approved pending user spec review
Parent specs: `2026-07-04-0rrery-rebuild-design.md`, `2026-07-04-trace-depth-design.md` (this closes their shared "tailer offset persistence" debt item).

## Summary

The tailer's per-file byte offsets and parse state survive restarts via an atomic JSON snapshot in the server's data dir. Restarts stop re-reading all transcript history, which also eliminates the Live-feed replay flood; `agentToolUseIds` round-trips so linkage gating survives restarts.

## Decisions

| Decision | Choice |
|---|---|
| Mechanism | JSON snapshot file, atomic tmp+rename; no server/SQLite coupling (collector stays fail-open and server-agnostic) |
| Location | `<dataDir>/tailer-offsets.json`, passed by the CLI; the tailer itself takes an optional path |
| Failure posture | Persistence is an optimization: corrupt/missing/unwritable snapshot degrades to today's full re-ingest (idempotent, safe). Never throws. |
| Forward compatibility | Snapshot carries `version: 1`; state revival fills missing fields from `newTranscriptState()` |

## Interface

```ts
// packages/claude-code/src/tailer.ts
export function startTailer(projectsDir: string, url: string, pollMs = 2000, offsetsPath?: string): { stop(): void }
// offsetsPath omitted → in-memory only (existing behavior, existing tests unchanged)

// packages/claude-code/src/offsets.ts (new)
export type FileState = { offset: number; state: TranscriptState }   // moves here from tailer.ts
export function loadOffsets(path: string): Map<string, FileState>    // missing/corrupt/wrong-version → empty map; prunes entries whose file no longer exists; never throws
export function saveOffsets(path: string, files: Map<string, FileState>): void  // {version: 1, files: {...}} via <path>.tmp + renameSync; agentToolUseIds as array; logs once on failure, never throws
export function reviveState(json: unknown): TranscriptState          // rebuilds the Set, fills missing fields from newTranscriptState()
```

CLI `serve` passes `join(config.dataDir, 'tailer-offsets.json')`.

## Behavior

- On start: seed the tailer's file map from `loadOffsets(offsetsPath)` when a path is given.
- After each `pass()` in which at least one offset advanced (dirty flag): `saveOffsets`. Idle passes never write.
- Truncation/rotation: when `statSync(path).size < entry.offset`, reset that entry to `{offset: 0, state: newTranscriptState()}` and re-ingest (idempotent). Today's `size <= offset` skip would otherwise wedge a rotated file forever once offsets persist.
- First restart after deploying this feature has no snapshot and backfills once (current behavior); subsequent restarts are incremental.

## Testing

- `offsets.ts` TDD: round-trip including the `agentToolUseIds` Set; corrupt JSON → empty map + no throw; version mismatch → empty map; revival fills fields missing from an older snapshot; save is atomic (no partial file when interrupted mid-write is approximated by asserting tmp file absence after save).
- Tailer integration (temp dirs + mock ingest server): pass → stop → new tailer with the same offsetsPath on an unchanged file → zero POSTs; append one line → only the increment POSTs; truncate + rewrite → full re-ingest of new content.
- E2E untouched.

## Accepted semantics

- Server-rejected (schema-invalid) ops are skipped and the offset advances past them — retrying is futile by definition; persistence makes that skip survive restarts, which is intended.
- Same-path file recreation LARGER than the old offset silently skips the recreated head. Claude Code session files are append-only and UUID-named, so this cannot occur today; if transcript rewriting ever ships, harden by persisting an inode or first-line hash per entry.

## Out of scope

Offset persistence for `0rrery import` (one-shot by design), multi-tailer coordination on one snapshot file, snapshot compaction/GC beyond dead-file pruning at load.
