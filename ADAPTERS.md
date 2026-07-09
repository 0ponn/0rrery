# Writing a 0rrery adapter

An adapter teaches 0rrery to ingest another agent tool's session logs. Two exist — `packages/claude-code` (transcripts + hooks) and `packages/codex` (rollout files) — and this is the contract they both follow.

## The shape

An adapter is a workspace package (`packages/<tool>`) exporting:

```ts
export type MyState = { sessionId: string | null /* ...flat fields only */ }
export function newMyState(): MyState
export function reviveMyState(json: unknown): MyState   // defaults every malformed field
export const myParser: Parser<MyState>                  // { parse, finalize? } from @0rrery/claude-code
```

- `parse(raw, state)`: ONE log line/record in, `IngestOp[]` out. Garbage in → `[]`, never throw. The state carries session identity between lines.
- `finalize(state, maxTs)`: emitted at import-finalize — close anything your format leaves open when a session ends abnormally (e.g. codex closes its open turn span). Live tailing does NOT finalize; open spans render "running", which is truthful.

`Parser<S>` lives in `packages/claude-code/src/importer.ts`, alongside the default: `claudeParser: Parser<TranscriptState> = { parse: parseTranscriptLine }` (no `finalize` — Claude transcripts don't leave anything open to close). Passing your own parser explicitly to `importSession` (via `opts.parser`) skips subagent-dir discovery — that gate is `opts.parser === undefined`, so it only fires for Claude transcripts, which is why the codex sweep path passes `parser: codexParser` explicitly and never triggers it.

## The rules (each one earned by a real bug)

1. **State must be flat: scalars and Sets only.** The importer's emit-failure rollback clones by shallow spread + Set copy; a nested object or Map would alias and corrupt on rollback.
2. **Ids must be deterministic and globally unique.** Idempotent re-ingest is the contract — the store dedupes by id (`INSERT OR IGNORE`). Derive ids from source-file identifiers (call ids, turn ids, thread ids), NEVER from parse time or counters. If multiple files merge into one session, salt event ids with the file's own thread id (codex: `evt:msg:<sid>:<threadId>:<ts>:<role>` when thread ≠ session).
3. **Sum per-call deltas, not cumulative counters.** Check your source's semantics against real files first (codex `last_token_usage` is a delta; `total_token_usage` is cumulative — summing the wrong one double-counts).
4. **Status from evidence, ok as default.** e.g. codex greps `exited with code [1-9]`; Claude uses `is_error`. Never guess errors.
5. **Per-adapter offset files.** `loadOffsets(path, reviveMyState)` applies ONE reviver to every entry — never share a snapshot file between adapters.
6. **No schema changes without review.** The wire (`IngestOp`) is tool-agnostic; if you think you need a new kind or field, you probably want attrs. (Adding your tool's name to the sessions `source` enum is the one expected change.)

## Wiring points

- **Tailer**: append-only logs → copy `packages/codex/src/tailer.ts` (offset-based, ~35 lines). Rewrite-on-save formats need a different model (mtime re-read + idempotent re-ingest) — nothing in-tree does this yet.
- **Import sniffing**: `packages/cli/src/index.ts` `import` case reads the file head to pick a parser — add your format's signature.
- **Sweep**: `packages/cli/src/sweep.ts` `importAll` — add your root dir, reuse `importOne`.
- **Serve**: `packages/cli/src/index.ts` `serve` case — start your tailer behind an `existsSync` guard with its own `<tool>-offsets.json`.

## Testing (the pattern that caught real bugs, twice)

1. **Fixture TDD**: a sanitized real log in `packages/<tool>/fixtures/`, one test per mapping row, plus: a pre-session line, an unknown type, a garbage line.
2. **Parse your own real files**: a scratch script over everything in the tool's log dir — assert zero thrown exceptions and zero `parseOps` rejections. This caught codex's legacy `id`-vs-`session_id` variance (two sessions silently vanishing) and validated the token-delta semantics. Fixtures lie; your own history doesn't.
3. **E2E**: import the fixture through a real server; assert the session summary; import it TWICE and assert the event count doesn't grow.
