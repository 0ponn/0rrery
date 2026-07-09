# Adapter Hardening + ADAPTERS.md Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The adapter pattern becomes safe to copy: generic types make parser/state mismatches compile errors, a `finalize` hook closes crashed-rollout spans, event ids survive multi-file session merges, and `ADAPTERS.md` documents the contract for outsiders.

**Architecture:** Pure refactor + additions over `packages/claude-code` (importer/offsets/sweep seams) and `packages/codex`; the 187-test suite is the byte-identical guard for every Claude path, and new regression pins freeze codex main-file event ids so re-imports stay idempotent.

**Tech Stack:** Existing: TypeScript generics, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-adapter-hardening-design.md`. Read it first.
- `Parser<S> = { parse: (raw: string, state: S) => IngestOp[]; finalize?: (state: S, maxTs: number) => IngestOp[] }` — exact shape; the importer's Claude agent-close STAYS in the importer under its existing `'agentId' in state` guard (the spec's "additive form"); `parser.finalize` is called at the same point, purely additive.
- Event-id rule: ids UNCHANGED when `threadId === sessionId` (regression-pinned); salted with `<threadId>` inserted after `<sid>` when they differ. Idempotent re-ingest is the contract.
- Claude emissions byte-identical: the full existing suite green with zero test-file edits outside codex tests explicitly named here.
- No new dependencies. All `Parser`-consuming call sites are in-repo — update them all; no compat shims.
- `bun test` FROM THE REPO ROOT + `bunx tsc --noEmit` + `bun run build` green before every commit; paste actual tails. Baseline at ebbfa74: 187 pass / 0 fail.

---

### Task 1: generics, finalize hook, event-id salting, leftovers

**Files:**
- Modify: `packages/claude-code/src/importer.ts`, `packages/claude-code/src/offsets.ts`, `packages/claude-code/src/index.ts` (export `Parser`), `packages/codex/src/codex.ts`, `packages/codex/src/tailer.ts`, `packages/codex/src/index.ts`, `packages/cli/src/index.ts` (sniff call site), `packages/cli/src/sweep.ts` (helper extraction + call sites)
- Test: `packages/codex/test/codex.test.ts` (append), `test/e2e.test.ts` (append idempotency pin)

**Interfaces:**
- Produces:
```ts
// @0rrery/claude-code
export type Parser<S> = {
  parse: (raw: string, state: S) => IngestOp[]
  finalize?: (state: S, maxTs: number) => IngestOp[]
}
export function importTranscript<S>(path: string, url: string, fromByte = 0, state: S, finalize = false, parser: Parser<S>): Promise<ImportResult>
// default-arg Claude convenience preserved via an exported `claudeParser: Parser<TranscriptState>` used when the caller passes nothing — adapt the current default-arg shape to whatever compiles cleanest while keeping every existing call site working unchanged
export function importSession(path: string, url: string, opts?: { finalize?: boolean; parser?: Parser<any>; newState?: () => any }): Promise<...>
export type FileState<S> = { offset: number; state: S }
export function loadOffsets<S>(path: string, revive: (json: unknown) => S): Map<string, FileState<S>>
export function saveOffsets<S>(path: string, files: Map<string, FileState<S>>): void
// @0rrery/codex
export const codexParser: Parser<CodexState>  // { parse: parseCodexLine, finalize: closes state.openTurnId at maxTs }
// CodexState gains threadId: string | null (payload.id at session_meta; reviveCodexState + newCodexState updated)
```
Note: `loadOffsets`' reviver loses its default (callers must say which adapter they are) — update the two call sites (Claude tailer passes `reviveState`, codex tailer `reviveCodexState`). If other tests call `loadOffsets` without a reviver, update those calls (that is a call-site edit, not an emission change).

- [ ] **Step 1: Write the failing tests**

Append to `packages/codex/test/codex.test.ts`:
```ts
import { codexParser } from '../src/codex'

test('codexParser.finalize closes an open turn at maxTs, nothing when none open', () => {
  const s = newCodexState()
  s.sessionId = 'cx1'; s.openTurnId = 't9'
  expect(codexParser.finalize!(s, 12345)).toEqual([{ op: 'span.end', id: 'llm:t9', ts: 12345, status: 'ok' }])
  expect(codexParser.finalize!(newCodexState(), 12345)).toEqual([])
})

test('main-file event ids are byte-identical to the pre-salt scheme', () => {
  const state = newCodexState()
  parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'cxm', id: 'cxm', cwd: '/home/dev/p' } }), state)
  const ops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } }), state)
  expect((ops[0] as any).id).toBe(`evt:msg:cxm:${Date.parse('2026-07-09T10:00:01.000Z')}:user`)
})

test('subagent-thread event ids are salted with the thread id', () => {
  const state = newCodexState()
  parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'cxm', id: 'thread-42', cwd: '/home/dev/p' } }), state)
  const ops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }), state)
  expect((ops[0] as any).id).toBe(`evt:msg:cxm:thread-42:${Date.parse('2026-07-09T10:00:01.000Z')}:assistant`)
})

test('codex session.start carries cwd', () => {
  const state = newCodexState()
  const ops = parseCodexLine(JSON.stringify({ timestamp: '2026-07-09T10:00:00.000Z', type: 'session_meta', payload: { session_id: 'cxc', id: 'cxc', cwd: '/home/dev/somewhere' } }), state)
  expect((ops[0] as any).cwd).toBe('/home/dev/somewhere')
})
```
Append to `test/e2e.test.ts`:
```ts
test('re-importing the codex fixture is event-idempotent', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-cxi-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))
  const fixture = new URL('../packages/codex/fixtures/codex1.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  const { codexParser, newCodexState } = await import('@0rrery/codex')
  const opts = { finalize: true, parser: codexParser, newState: newCodexState }
  await importSession(fixture, srv.url, opts)
  const before = ((await fetch(`${srv.url}/api/sessions/cx1`).then(r => r.json())) as any).events.length
  await importSession(fixture, srv.url, opts)
  const after = ((await fetch(`${srv.url}/api/sessions/cx1`).then(r => r.json())) as any).events.length
  expect(after).toBe(before)
  srv.stop()
})
```
(The existing codex e2e test's `{ parse: parseCodexLine, newState: newCodexState }` opts shape changes to `{ parser: codexParser, newState: newCodexState }` — update it in the same commit; that is a named call-site edit, not an emission change.)

- [ ] **Step 2: RED**

Run: `bun test packages/codex/test/codex.test.ts test/e2e.test.ts`
Expected: FAIL — `codexParser` not exported; cwd/salt assertions fail; idempotency test may pass trivially pre-change (it pins the invariant — note in the report whether it was red or a pin).

- [ ] **Step 3: Implement**

Work through, adapting to the current source (read each file first; the suite is the guard):
1. `Parser<S>` type in importer.ts, exported through `packages/claude-code/src/index.ts`. `importTranscript` takes `parser: Parser<S>` (replacing the bare parse function param); after the existing finalize block, `if (parser.finalize && ops.length) ops.push(...parser.finalize(state, maxTs))` — placed so codex turn-closes ride the same emit batch. Claude's agent-close/session.end stay exactly where they are.
2. Generic `FileState<S>`/`loadOffsets<S>`/`saveOffsets<S>`; reviver param loses its default; fix the two tailer call sites + any test callers.
3. `importSession` opts: `parse`/`newState` become `parser`/`newState`; subagent-dir discovery still gated on the parser being the Claude default (gate on `opts.parser === undefined`).
4. codex.ts: `threadId` in state (+ revive + new); salt rule exactly per Global Constraints applied to `evt:msg:` and `evt:stop:` ids; `cwd` on session.start; export `codexParser` with the finalize from the spec.
5. cli index.ts sniff + codex tailer: pass `codexParser`; sweep.ts: extract
```ts
async function importOne(path: string, url: string, opts: Parameters<typeof importSession>[2], label: string): Promise<'ok' | 'failed' | 'unreachable'>
```
used by both loops (preserve the abort-on-unreachable + continue-on-throw accounting and log lines exactly).
6. Clone-contract comment at the importer snapshot site, verbatim from the spec §4.

- [ ] **Step 4: GREEN + guards**

Run: root `bun test` (expect 192 pass / 0 fail: 187 + 5) + `bunx tsc --noEmit` + `bun run build`. Manually verify the negative type check: a scratch file passing `claudeParser` with `newCodexState()` state must FAIL tsc — paste the error into the report, then delete the scratch.

- [ ] **Step 5: Commit**

```bash
git add packages test/e2e.test.ts && git commit -m "Generic adapter contract with finalize hook and merge-safe event ids"
```

---

### Task 2: ADAPTERS.md + live rollout

**Files:**
- Create: `ADAPTERS.md` (repo root)
- Modify: `README.md` (one line under Development linking to it)
- Test: none new (doc unit + rollout verification)

- [ ] **Step 1: Write ADAPTERS.md**

Full content — verify every file/line pointer against the actual tree before committing, and correct any that drifted:
````markdown
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

## The rules (each one earned by a real bug)

1. **State must be flat: scalars and Sets only.** The importer's emit-failure rollback clones by shallow spread + Set copy; a nested object or Map would alias and corrupt on rollback.
2. **Ids must be deterministic and globally unique.** Idempotent re-ingest is the contract — the store dedupes by id (`INSERT OR IGNORE`). Derive ids from source-file identifiers (call ids, turn ids, thread ids), NEVER from parse time or counters. If multiple files merge into one session, salt event ids with the file's own thread id (codex: `evt:msg:<sid>:<threadId>:<ts>:<role>` when thread ≠ session).
3. **Sum per-call deltas, not cumulative counters.** Check your source's semantics against real files first (codex `last_token_usage` is a delta; `total_token_usage` is cumulative — summing the wrong one double-counts).
4. **Status from evidence, ok as default.** e.g. codex greps `exited with code [1-9]`; Claude uses `is_error`. Never guess errors.
5. **Per-adapter offset files.** `loadOffsets(path, reviveMyState)` applies ONE reviver to every entry — never share a snapshot file between adapters.
6. **No schema changes without review.** The wire (`IngestOp`) is tool-agnostic; if you think you need a new kind or field, you probably want attrs. (Adding your tool's name to the sessions `source` enum is the one expected change.)

## Wiring points

- **Tailer**: append-only logs → copy `packages/codex/src/tailer.ts` (offset-based, ~40 lines). Rewrite-on-save formats need a different model (mtime re-read + idempotent re-ingest) — nothing in-tree does this yet.
- **Import sniffing**: `packages/cli/src/index.ts` `import` case reads the file head to pick a parser — add your format's signature.
- **Sweep**: `packages/cli/src/sweep.ts` `importAll` — add your root dir, reuse `importOne`.
- **Serve**: `packages/cli/src/index.ts` `serve` case — start your tailer behind an `existsSync` guard with its own `<tool>-offsets.json`.

## Testing (the pattern that caught real bugs, twice)

1. **Fixture TDD**: a sanitized real log in `packages/<tool>/fixtures/`, one test per mapping row, plus: a pre-session line, an unknown type, a garbage line.
2. **Parse your own real files**: a scratch script over everything in the tool's log dir — assert zero thrown exceptions and zero `parseOps` rejections. This caught codex's legacy `id`-vs-`session_id` variance (two sessions silently vanishing) and validated the token-delta semantics. Fixtures lie; your own history doesn't.
3. **E2E**: import the fixture through a real server; assert the session summary; import it TWICE and assert the event count doesn't grow.
````

- [ ] **Step 2: README pointer**

In README.md's Development section add: `Want 0rrery to ingest another agent CLI? See [ADAPTERS.md](./ADAPTERS.md).`

- [ ] **Step 3: Live rollout**

```bash
bun run build:pkg && cp -r dist-pkg/. /home/mlayug/node_modules/0rrery/
systemctl --user restart 0rrery && sleep 6 && systemctl --user is-active 0rrery
/home/mlayug/.bun/bin/0rrery import --all 2>&1 | tail -3
```
Verify (OBSERVED; file-and-read):
1. Crashed-rollout finalize: query the DB for codex sessions with `status='ended'` containing llm spans with `ended_at IS NULL` — expect 0 after the re-import (report the before count if you capture it first).
2. The FOSSINT merged session's event count: report before/after — growth must be ≤ the bounded subagent-thread duplication the spec accepts (a handful), not wholesale.
3. Root suite still green post-deploy sanity: `curl -s -o /dev/null -w '%{http_code}\n' localhost:7317/api/fleet` → 200.

- [ ] **Step 4: Commit**

```bash
git add ADAPTERS.md README.md && git commit -m "Document the adapter contract"
```

---

## Out of scope (per spec)

Gemini, new adapters, structuredClone migration, npm release.
