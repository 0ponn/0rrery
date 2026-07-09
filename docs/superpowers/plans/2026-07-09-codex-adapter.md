# Codex Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 0rrery ingests OpenAI Codex CLI rollout files: `packages/codex` parses them into the existing `IngestOp` wire, the tailer/import/init grow a second root, and the whole read side works unchanged with `source: 'codex'`.

**Architecture:** A pure `parseCodexLine` mirroring `parseTranscriptLine`'s contract; the shared importer/offsets machinery gains parser/reviver parameters (additive, defaults preserve Claude behavior); Codex gets its own small recursive tailer (the Claude tailer's directory walk is layout-specific). No hooks — transcript-tail-only, already truthful.

**Tech Stack:** Existing: TypeScript, Bun, `bun test`. New workspace package `@0rrery/codex` (auto-registered by the `packages/*` workspace glob + `@0rrery/*` tsconfig path).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-codex-adapter-design.md`. Read it first.
- The mapping table in spec §1 is binding, including the skip list (reasoning, developer/system messages, `event_msg` message duplicates, task_started, info-null token_counts, unknown types) and pre-`session_meta` lines dropped.
- Token source is `payload.info.last_token_usage` (per-call, ACCUMULATED in parser state per turn — verified against real data 2026-07-09), merged onto the open `llm:<turn_id>` span via span.start upsert.
- Tool status: `error` iff output matches `/exited with code [1-9]/` (i.e. nonzero), else `ok`.
- All machinery changes are ADDITIVE with defaults — every existing Claude path must behave byte-identically (the full suite is the guard).
- No new dependencies. Null-honest pricing unchanged (gpt-5* unpriced).
- `bun test` FROM THE REPO ROOT + `bunx tsc --noEmit` green before every commit; paste actual tails. Baseline at a102598: 176 pass / 0 fail.
- Deviation from spec §2, deliberate: `ORRERY_CODEX_DIR` is a CLI-side helper (like `claudeDir()`), NOT a server Config field — only the CLI consumes it; adding it to Config would be dead weight. Record this in the report.

---

### Task 1: `packages/codex` — parser + fixture

**Files:**
- Create: `packages/codex/package.json`, `packages/codex/src/index.ts`, `packages/codex/src/codex.ts`, `packages/codex/fixtures/codex1.jsonl`
- Test: `packages/codex/test/codex.test.ts` (new)

**Interfaces:**
- Consumes: `IngestOp` types + `isMcpTool` from `@0rrery/schema`.
- Produces (Task 2 wires these):
```ts
export type CodexState = {
  sessionId: string | null; project: string | null; model: string | null
  openTurnId: string | null; turnIn: number; turnOut: number
}
export function newCodexState(): CodexState
export function parseCodexLine(raw: string, state: CodexState): IngestOp[]
export function reviveCodexState(json: unknown): CodexState
```

- [ ] **Step 1: Package scaffold**

`packages/codex/package.json`:
```json
{
  "name": "@0rrery/codex",
  "version": "0.1.0",
  "module": "src/index.ts",
  "dependencies": { "@0rrery/schema": "workspace:*" }
}
```
`packages/codex/src/index.ts`:
```ts
export { parseCodexLine, newCodexState, reviveCodexState, type CodexState } from './codex'
```
Run `bun install` (links the workspace).

- [ ] **Step 2: Fixture**

Create `packages/codex/fixtures/codex1.jsonl` with EXACTLY these lines (sanitized real-format lines; one JSON object per line):
```jsonl
{"timestamp":"2026-07-09T09:59:59.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"pre-meta line must be dropped"}]}}
{"timestamp":"2026-07-09T10:00:00.000Z","type":"session_meta","payload":{"session_id":"cx1","id":"cx1","timestamp":"2026-07-09T10:00:00.000Z","cwd":"/home/dev/proj-x","originator":"codex_exec","cli_version":"0.142.0","source":"exec","model_provider":"openai"}}
{"timestamp":"2026-07-09T10:00:01.000Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/home/dev/proj-x","model":"gpt-5.4","approval_policy":"on-request"}}
{"timestamp":"2026-07-09T10:00:01.500Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"list the files in this repo"}]}}
{"timestamp":"2026-07-09T10:00:01.600Z","type":"event_msg","payload":{"type":"user_message","message":"list the files in this repo"}}
{"timestamp":"2026-07-09T10:00:02.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"ls\",\"workdir\":\"/home/dev/proj-x\"}","call_id":"call_aaa"}}
{"timestamp":"2026-07-09T10:00:03.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_aaa","output":"Wall time: 0.01 seconds\nProcess exited with code 0\nOutput:\nREADME.md src"}}
{"timestamp":"2026-07-09T10:00:03.500Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9000,"output_tokens":400},"last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":50},"model_context_window":258400},"rate_limits":{}}}
{"timestamp":"2026-07-09T10:00:04.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Two entries: README.md and src."}]}}
{"timestamp":"2026-07-09T10:00:04.100Z","type":"event_msg","payload":{"type":"agent_message","message":"Two entries: README.md and src."}}
{"timestamp":"2026-07-09T10:00:05.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"git status\"}","call_id":"call_bbb"}}
{"timestamp":"2026-07-09T10:00:06.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_bbb","output":"Wall time: 0.00 seconds\nProcess exited with code 128\nOutput:\nfatal: not a git repository"}}
{"timestamp":"2026-07-09T10:00:07.000Z","type":"response_item","payload":{"type":"web_search_call","id":"ws_123","status":"completed","action":{"type":"search","query":"bun docs"}}}
{"timestamp":"2026-07-09T10:00:07.500Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"skipped"}]}}
{"timestamp":"2026-07-09T10:00:07.600Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}
{"timestamp":"2026-07-09T10:00:08.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"skipped role"}]}}
{"timestamp":"2026-07-09T10:00:09.000Z","type":"turn_context","payload":{"turn_id":"t2","cwd":"/home/dev/proj-x","model":"gpt-5.4"}}
{"timestamp":"2026-07-09T10:00:10.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":11000,"output_tokens":500},"last_token_usage":{"input_tokens":2000,"output_tokens":100},"model_context_window":258400},"rate_limits":{}}}
{"timestamp":"2026-07-09T10:00:11.000Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}
{"timestamp":"2026-07-09T10:00:12.000Z","type":"weird_future_type","payload":{"anything":true}}
```

- [ ] **Step 3: Write the failing tests**

Create `packages/codex/test/codex.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseCodexLine, newCodexState, reviveCodexState } from '../src/codex'
import type { IngestOp } from '@0rrery/schema'

function parseFixture(): IngestOp[] {
  const state = newCodexState()
  const ops: IngestOp[] = []
  const raw = readFileSync(new URL('../fixtures/codex1.jsonl', import.meta.url), 'utf8')
  for (const line of raw.split('\n')) if (line.trim()) ops.push(...parseCodexLine(line, state))
  return ops
}

test('session_meta starts a codex-source session; pre-meta lines dropped', () => {
  const ops = parseFixture()
  const start = ops.find(o => o.op === 'session.start') as any
  expect(start).toMatchObject({ sessionId: 'cx1', source: 'codex', project: 'proj-x' })
  expect(start.meta).toMatchObject({ model_provider: 'openai', cli_version: '0.142.0' })
  // the pre-meta user message must not have produced an event
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'message.user')).toHaveLength(1)
})

test('turns become llm spans: t1 closed by next turn_context, t2 by task_complete', () => {
  const ops = parseFixture()
  const starts = ops.filter(o => o.op === 'span.start' && (o as any).kind === 'llm') as any[]
  expect(starts.map(s => s.id)).toContain('llm:t1')
  expect(starts.map(s => s.id)).toContain('llm:t2')
  expect(starts.find(s => s.id === 'llm:t1')!.name).toBe('gpt-5.4')
  const ends = ops.filter(o => o.op === 'span.end' && (o as any).id.startsWith('llm:')) as any[]
  expect(ends.map(e => e.id).sort()).toEqual(['llm:t1', 'llm:t2'])
})

test('function calls become tool spans joined by call_id, status from exit code', () => {
  const ops = parseFixture()
  const aaa = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:call_aaa') as any
  expect(aaa).toMatchObject({ kind: 'tool', name: 'exec_command' })
  expect(aaa.attrs.input).toMatchObject({ cmd: 'ls' })
  expect((ops.find(o => o.op === 'span.end' && (o as any).id === 'tool:call_aaa') as any).status).toBe('ok')
  expect((ops.find(o => o.op === 'span.end' && (o as any).id === 'tool:call_bbb') as any).status).toBe('error')
})

test('web_search_call becomes a completed tool span', () => {
  const ops = parseFixture()
  const ws = ops.find(o => o.op === 'span.start' && (o as any).id === 'tool:ws_123') as any
  expect(ws).toMatchObject({ kind: 'tool', name: 'web_search' })
  expect(ws.attrs.input).toMatchObject({ query: 'bun docs' })
  expect(ops.some(o => o.op === 'span.end' && (o as any).id === 'tool:ws_123')).toBe(true)
})

test('token counts accumulate per turn onto the llm span, info-null skipped', () => {
  const ops = parseFixture()
  const merges = ops.filter(o => o.op === 'span.start' && (o as any).id === 'llm:t1') as any[]
  const last = merges[merges.length - 1]
  expect(last.attrs).toMatchObject({ input_tokens: 1000, output_tokens: 50 })
  const t2merge = ops.filter(o => o.op === 'span.start' && (o as any).id === 'llm:t2') as any[]
  expect(t2merge[t2merge.length - 1].attrs).toMatchObject({ input_tokens: 2000, output_tokens: 100 })
})

test('messages: one event per user/assistant message, event_msg duplicates and developer role skipped', () => {
  const ops = parseFixture()
  const msgs = ops.filter(o => o.op === 'event' && ((o as any).type === 'message.user' || (o as any).type === 'message.assistant')) as any[]
  expect(msgs).toHaveLength(2)
  expect(msgs[0].attrs.preview).toBe('list the files in this repo')
  expect(msgs[1].attrs.preview).toBe('Two entries: README.md and src.')
})

test('turn boundary events: turn.context per turn, turn.stop on task_complete', () => {
  const ops = parseFixture()
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'turn.context')).toHaveLength(2)
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'turn.stop')).toHaveLength(1)
})

test('garbage, unknown types, and skip-listed lines yield nothing', () => {
  const state = newCodexState()
  expect(parseCodexLine('not json', state)).toEqual([])
  expect(parseCodexLine('{"type":"weird_future_type","payload":{}}', state)).toEqual([])
})

test('reviveCodexState round-trips and defaults malformed fields', () => {
  const s = newCodexState()
  s.sessionId = 'cx1'; s.openTurnId = 't1'; s.turnIn = 5
  expect(reviveCodexState(JSON.parse(JSON.stringify(s)))).toEqual(s)
  expect(reviveCodexState({ sessionId: 42 })).toEqual(newCodexState())
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `bun test packages/codex`
Expected: FAIL — `../src/codex` does not exist.

- [ ] **Step 5: Implement `packages/codex/src/codex.ts`**

```ts
import type { IngestOp } from '@0rrery/schema'
import { isMcpTool } from '@0rrery/schema'

export type CodexState = {
  sessionId: string | null; project: string | null; model: string | null
  openTurnId: string | null; turnIn: number; turnOut: number
}

export function newCodexState(): CodexState {
  return { sessionId: null, project: null, model: null, openTurnId: null, turnIn: 0, turnOut: 0 }
}

export function reviveCodexState(json: unknown): CodexState {
  const fresh = newCodexState()
  if (typeof json !== 'object' || json === null) return fresh
  const j = json as any
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // any malformed field resets the whole state (parser correctness over partial recovery)
  if (j.sessionId !== null && typeof j.sessionId !== 'string') return fresh
  return {
    sessionId: str(j.sessionId), project: str(j.project), model: str(j.model),
    openTurnId: str(j.openTurnId), turnIn: num(j.turnIn), turnOut: num(j.turnOut),
  }
}

const preview = (s: string) => s.slice(0, 200)

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => c?.text ?? '').join('').trim()
}

export function parseCodexLine(raw: string, state: CodexState): IngestOp[] {
  let line: any
  try { line = JSON.parse(raw) } catch { return [] }
  if (typeof line !== 'object' || line === null) return []
  const ts = Date.parse(line.timestamp) || Date.now()
  const p = line.payload
  if (typeof p !== 'object' || p === null) return []

  if (line.type === 'session_meta') {
    state.sessionId = typeof p.session_id === 'string' ? p.session_id : null
    if (!state.sessionId) return []
    state.project = typeof p.cwd === 'string' ? p.cwd.split('/').pop() ?? null : null
    state.model = typeof p.model_provider === 'string' ? p.model_provider : null
    return [{
      op: 'session.start', sessionId: state.sessionId, source: 'codex', ts,
      project: state.project ?? undefined,
      meta: { model_provider: p.model_provider, cli_version: p.cli_version, originator: p.originator },
    }]
  }

  const sid = state.sessionId
  if (!sid) return []  // pre-meta lines dropped
  const ops: IngestOp[] = []

  const closeTurn = (endTs: number) => {
    if (!state.openTurnId) return
    ops.push({ op: 'span.end', id: `llm:${state.openTurnId}`, ts: endTs, status: 'ok' })
    state.openTurnId = null
    state.turnIn = 0
    state.turnOut = 0
  }

  if (line.type === 'turn_context') {
    closeTurn(ts)
    const turnId = typeof p.turn_id === 'string' ? p.turn_id : null
    if (typeof p.model === 'string') state.model = p.model
    if (turnId) {
      state.openTurnId = turnId
      ops.push({
        op: 'span.start', id: `llm:${turnId}`, sessionId: sid, parentId: null,
        kind: 'llm', name: state.model ?? '(model)', ts, attrs: {},
      })
      ops.push({ op: 'event', id: `evt:turn:${turnId}`, sessionId: sid, type: 'turn.context', ts, attrs: {} })
    }
    return ops
  }

  if (line.type === 'event_msg') {
    if (p.type === 'task_complete') {
      closeTurn(ts)
      ops.push({ op: 'event', id: `evt:stop:${sid}:${ts}`, sessionId: sid, type: 'turn.stop', ts, attrs: {} })
      return ops
    }
    if (p.type === 'token_count' && p.info && typeof p.info === 'object' && state.openTurnId) {
      const u = p.info.last_token_usage
      if (u && typeof u === 'object') {
        state.turnIn += u.input_tokens ?? 0
        state.turnOut += u.output_tokens ?? 0
        ops.push({
          op: 'span.start', id: `llm:${state.openTurnId}`, sessionId: sid, parentId: null,
          kind: 'llm', name: state.model ?? '(model)', ts,
          attrs: { input_tokens: state.turnIn, output_tokens: state.turnOut },
        })
      }
      return ops
    }
    return []  // user_message/agent_message duplicates, task_started, rate-limit-only counts
  }

  if (line.type === 'response_item') {
    if (p.type === 'function_call' && typeof p.call_id === 'string') {
      let input: unknown = p.arguments
      try { input = JSON.parse(p.arguments) } catch {}
      const name = typeof p.name === 'string' ? p.name : '(tool)'
      return [{
        op: 'span.start', id: `tool:${p.call_id}`, sessionId: sid,
        parentId: state.openTurnId ? `llm:${state.openTurnId}` : null,
        kind: isMcpTool(name) ? 'mcp' : 'tool', name, ts, attrs: { input },
      }]
    }
    if (p.type === 'function_call_output' && typeof p.call_id === 'string') {
      const out = typeof p.output === 'string' ? p.output : ''
      const status = /exited with code [1-9]/.test(out) ? 'error' : 'ok'
      return [{ op: 'span.end', id: `tool:${p.call_id}`, ts, status, attrs: {} }]
    }
    if (p.type === 'web_search_call' && typeof p.id === 'string') {
      return [
        {
          op: 'span.start', id: `tool:${p.id}`, sessionId: sid,
          parentId: state.openTurnId ? `llm:${state.openTurnId}` : null,
          kind: 'tool', name: 'web_search', ts, attrs: { input: { query: p.action?.query ?? '' } },
        },
        { op: 'span.end', id: `tool:${p.id}`, ts, status: 'ok', attrs: {} },
      ]
    }
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = messageText(p.content)
      if (!text) return []
      return [{
        op: 'event', id: `evt:msg:${sid}:${ts}:${p.role}`, sessionId: sid,
        type: p.role === 'user' ? 'message.user' : 'message.assistant', ts,
        attrs: { preview: preview(text) },
      }]
    }
    return []  // reasoning, developer/system messages, everything else
  }

  return []  // unknown top-level types
}
```
Note the tool spans' `parentId` points at the open turn's llm span — richer than the spec's table (which left parentage unstated); the trace tree then mirrors Claude's llm→tool nesting. If the reviewer flags this as beyond-spec, the rationale is topology/waterfall parity.

VERIFY-FIRST: check `SessionStartSchema` in `packages/schema/src/index.ts` actually accepts a `meta` field (the sessions table has a meta column, but the op schema may not expose it). If it doesn't, DROP the `meta` key from the session.start op and note it in your report (schema widening is out of scope) — the corresponding test assertion on `start.meta` then changes to assert `project` only.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/codex`, root `bun test`, `bunx tsc --noEmit`.
Expected: root 185 pass / 0 fail (176 + 9).

- [ ] **Step 7: Commit**

```bash
git add packages/codex bun.lock && git commit -m "Add Codex CLI adapter package"
```

---

### Task 2: machinery parameterization + wiring + rollout

**Files:**
- Modify: `packages/claude-code/src/importer.ts` (parse param + generic clone), `packages/claude-code/src/offsets.ts` (reviver param), `packages/cli/src/index.ts` (codexDir helper, serve second tailer, import sniff), `packages/cli/src/sweep.ts` (codex root), `packages/cli/skill/SKILL.md` (one clause), `README.md` (one line)
- Create: `packages/codex/src/tailer.ts` (+ export from `packages/codex/src/index.ts`)
- Test: `test/e2e.test.ts` (append), `packages/claude-code/test/` (existing suites are the byte-identical guard)

**Interfaces:**
- Consumes: Task 1's `parseCodexLine`/`newCodexState`/`reviveCodexState`; existing `importTranscript`, `importSession`, `loadOffsets`, `saveOffsets`, `FileState`, `emitOps`.
- Produces:
  - `importTranscript(path, url, fromByte = 0, state: any = newTranscriptState(), finalize = false, parse: (raw: string, state: any) => IngestOp[] = parseTranscriptLine)`
  - `importSession(path, url, opts: { finalize?: boolean; parse?: (raw: string, state: any) => IngestOp[]; newState?: () => any } = {})` — subagent-dir discovery runs ONLY when `opts.parse` is absent (Claude layout only)
  - `loadOffsets(path, revive: (json: unknown) => any = reviveState)`
  - `startCodexTailer(rootDir: string, url: string, pollMs = 2000, offsetsPath?: string): { stop(): void }` from `@0rrery/codex`

- [ ] **Step 1: Machinery — failing test first**

Append to `test/e2e.test.ts`:
```ts
test('codex fixture imports as a codex-source session', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-cx-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))
  const fixture = new URL('../packages/codex/fixtures/codex1.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  const { parseCodexLine, newCodexState } = await import('@0rrery/codex')
  const r = await importSession(fixture, srv.url, { finalize: true, parse: parseCodexLine, newState: newCodexState })
  expect(r.emitted).toBe(true)

  const s = await fetch(`${srv.url}/api/sessions/cx1/summary`).then(x => x.json()) as any
  expect(s.project).toBe('proj-x')
  expect(s.tokens_in).toBe(3000)
  expect(s.tokens_out).toBe(150)
  expect(s.models).toEqual([{ model: 'gpt-5.4', calls: 2 }])
  expect(s.top_tools.find((t: any) => t.name === 'exec_command')).toMatchObject({ calls: 2, errors: 1 })
  expect(s.errors).toBe(1)

  const list = await fetch(`${srv.url}/api/sessions`).then(x => x.json()) as any[]
  expect(list.find(x => x.id === 'cx1')!.source).toBe('codex')
  srv.stop()
})
```
Run: `bun test test/e2e.test.ts` — the new test FAILS (importSession has no parse/newState opts yet; `@0rrery/codex` resolves from Task 1).

- [ ] **Step 2: Implement the machinery**

`packages/claude-code/src/importer.ts`:
- Widen the signatures exactly as the Interfaces block states (default args preserve every existing call site unchanged).
- Snapshot clone generalizes from the hardcoded `agentToolUseIds` copy to: `const snapshot: any = { ...state }; for (const k of Object.keys(snapshot)) if (snapshot[k] instanceof Set) snapshot[k] = new Set(snapshot[k])` (and the restore mirrors it via `Object.assign(state, snapshot)` as today).
- The agent-close finalize guard becomes `if ('agentId' in state && state.agentId && ops.length)` (codex state has no agentId — skipped naturally); the `finalize && !state.agentId` session.end branch: change the condition to `finalize && !('agentId' in state && state.agentId)` so codex finalize emits session.end.
- `importSession`: thread `opts.parse`/`opts.newState` into both the main call and (Claude-only) subagent calls; wrap the subagent block in `if (!opts.parse) { ... }`.

`packages/claude-code/src/offsets.ts`: `loadOffsets(path: string, revive: (json: unknown) => any = reviveState)` — the per-entry state revival calls `revive(entry.state)`.

`packages/codex/src/tailer.ts`:
```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importTranscript, loadOffsets, saveOffsets, type FileState } from '@0rrery/claude-code'
import { parseCodexLine, newCodexState, reviveCodexState } from './codex'

export function startCodexTailer(rootDir: string, url: string, pollMs = 2000, offsetsPath?: string) {
  const files: Map<string, FileState> = offsetsPath ? loadOffsets(offsetsPath, reviveCodexState) : new Map()
  let stopped = false

  const pass = async () => {
    let dirty = false
    let entries: string[] = []
    try {
      entries = (readdirSync(rootDir, { recursive: true }) as string[]).filter(e => e.endsWith('.jsonl'))
    } catch { return }
    for (const rel of entries) {
      const path = join(rootDir, String(rel))
      try {
        let fs = files.get(path)
        if (!fs) { fs = { offset: 0, state: newCodexState() }; files.set(path, fs) }
        const size = statSync(path).size
        if (size < fs.offset) { fs.offset = 0; fs.state = newCodexState(); dirty = true }
        if (size > fs.offset) {
          const r = await importTranscript(path, url, fs.offset, fs.state, false, parseCodexLine)
          if (r.bytesRead !== fs.offset) { fs.offset = r.bytesRead; dirty = true }
        }
      } catch {}
    }
    if (dirty && offsetsPath) saveOffsets(offsetsPath, files)
  }

  const loop = async () => { while (!stopped) { await pass(); await Bun.sleep(pollMs) } }
  loop()
  return { stop() { stopped = true } }
}
```
Export it from `packages/codex/src/index.ts`. NOTE: `saveOffsets` serializes any `Set` fields; codex state has none — verify `saveOffsets` doesn't assume `agentToolUseIds` exists (read it; if it does, make the Set-to-array conversion generic the same way the importer clone is).

`packages/cli/src/index.ts`:
- Helper beside `claudeDir()`: `const codexDir = () => process.env.ORRERY_CODEX_DIR ?? join(homedir(), '.codex', 'sessions')`
- `serve`: after the Claude tailer, `const cx = existsSync(codexDir()) ? startCodexTailer(codexDir(), srv.url, 2000, join(config.dataDir, 'codex-offsets.json')) : null`, log `tailing ${codexDir()} (codex)` when active, and `cx?.stop()` in the SIGINT handler.
- `import <file>` sniff: before calling importSession, read the first line (`readFileSync(path, 'utf8').slice(0, 400)`... use a 400-byte `openSync`/`readSync` head to avoid loading huge files); if it matches `/"type"\s*:\s*"session_meta"/` call `importSession(path, url, { finalize: true, parse: parseCodexLine, newState: newCodexState })` else the existing call.

`packages/cli/src/sweep.ts`: `importAll(projectsDir: string, url: string, codexRoot?: string)` — after the Claude loop, if `codexRoot` is provided and exists, glob `new Bun.Glob('**/*.jsonl').scanSync({ cwd: codexRoot, absolute: true })` sorted, import each with the codex parse opts, same ok/failed/abort-on-unreachable accounting (shared totals). Update both call sites (`import --all`, `init`) to pass `codexDir()` guarded by `existsSync`.

`packages/cli/skill/SKILL.md`: first paragraph, change "records every Claude Code session" to "records every Claude Code and Codex CLI session". `README.md`: in the summary line, append "Ingests Claude Code and OpenAI Codex CLI sessions."

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test test/e2e.test.ts`, then root `bun test` and `bunx tsc --noEmit` and `bun run build`.
Expected: root 186 pass / 0 fail (185 + 1). Every pre-existing Claude test green untouched — that's the additive-defaults guard.

- [ ] **Step 4: Commit**

```bash
git add packages/claude-code packages/codex packages/cli test/e2e.test.ts README.md && git commit -m "Wire Codex ingestion through tailer, import, and init"
```

- [ ] **Step 5: Live rollout**

```bash
bun run build:pkg && cp -r dist-pkg/. /home/mlayug/node_modules/0rrery/
systemctl --user restart 0rrery && sleep 6 && systemctl --user is-active 0rrery
journalctl --user -u 0rrery --no-pager | tail -2   # expect the codex tailing log line
/home/mlayug/.bun/bin/0rrery import --all 2>&1 | tail -3   # sweeps ~/.claude AND ~/.codex (24 codex files)
```
Then verify (OBSERVED; file-and-read anything garbled):
1. `curl -s 'localhost:7317/api/sessions?limit=200' -o /tmp/s.json` → count sessions with `source == 'codex'` (expect ~24, minus any pre-session_meta-format files — report the actual number and, if below ~20, sample one skipped file's first line to explain why).
2. Open the c0mbwell Codex session in the browser: trace shows llm turn spans with nested exec_command tool spans, tokens in the header, errors red. Screenshot.
3. Topology tab on that session shows model gpt-5.x → tools. Screenshot.
4. `/api/insights/projects` now includes codex-project rows; spot-check one.
5. Fleet: a codex session active within the hour would show a card (fine if none live right now — state what you saw).

---

## Out of scope (per spec)

Gemini (next unit), adapter-SDK docs, Codex hooks, gpt-5 prices, pre-rollout-format backfill.
