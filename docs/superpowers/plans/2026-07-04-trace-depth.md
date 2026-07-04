# Trace Depth (0PO-432) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subagent activity becomes `agent` span subtrees, permission prompts become typed paired events, compaction becomes visible — and the tailer learns to read subagent transcript files it currently misses entirely.

**Architecture:** All collection changes live in `@0rrery/claude-code` (parser/importer/tailer/hook map) plus one generic merge-rule addition in the store; read-side is a pure `permissionStatus` helper and small render additions in the dashboard. Wire format unchanged; no schema migration.

**Tech Stack:** Existing: Bun 1.3.x, TypeScript, `bun:sqlite`, zod, React/Vite, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-trace-depth-design.md`. Read it before starting any task.
- Evidence formats are FIXED — do not invent fields: subagent files at `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` with per-line `sessionId` (parent), `agentId`, `attributionAgent`; compact lines `{"type":"system","subtype":"compact_boundary","compactMetadata":{...}}` and user lines with `isCompactSummary: true`; hooks `PermissionRequest` (`tool_use_id`, `tool_name`, `permission_reason`, `permission_mode`) and `PermissionDenied` (`tool_use_id`, `tool_name`, fires only on auto-mode denials).
- Span/event ID conventions: `agent:<agentId>`, `evt:perm:req:<tool_use_id>`, `evt:perm:res:<tool_use_id>`, `evt:compact:<uuid>`.
- Emitters stay fail-open and stateless per invocation. Permission resolution for "allowed" is NEVER emitted — derived at read time.
- Ingest stays idempotent: every op re-applyable; the importer's full-state snapshot must restore ALL `TranscriptState` fields on failed emit.
- TDD per task: failing test first, RED output captured, then implement. `bun test` (currently 55 pass) and `bunx tsc --noEmit` must be green before every commit.
- Commit after every task, imperative messages. Author resolves to memmmmike.

---

### Task 1: Hook emitter — permission events, notification_type, install additions

**Files:**
- Modify: `packages/claude-code/src/map.ts`
- Modify: `packages/cli/src/install.ts:4` (HOOK_EVENTS)
- Test: `packages/claude-code/test/map.test.ts`, `packages/cli/test/install.test.ts`

**Interfaces:**
- Consumes: existing `mapHookEvent(input, now)`, `installHooks(claudeDir, hookCommand)`.
- Produces: `mapHookEvent` handles `PermissionRequest` → `permission.requested` event and `PermissionDenied` → `permission.resolved` event (shapes below); `HOOK_EVENTS` includes both new names. Task 6's `permissionStatus` relies on exactly `type: 'permission.requested' | 'permission.resolved'`, `spanId: tool:<tool_use_id>`, and `attrs.outcome === 'denied'`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/claude-code/test/map.test.ts`:
```ts
test('PermissionRequest → permission.requested on the tool span', () => {
  const ops = mapHookEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu9', permission_reason: 'rule match', permission_mode: 'default' }, 50)
  expect(ops).toEqual([{
    op: 'event', id: 'evt:perm:req:tu9', sessionId: 's1', spanId: 'tool:tu9',
    type: 'permission.requested', ts: 50,
    attrs: { tool: 'Bash', reason: 'rule match', mode: 'default' },
  }])
})

test('PermissionDenied → permission.resolved denied', () => {
  const ops = mapHookEvent({ hook_event_name: 'PermissionDenied', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu9' }, 60)
  expect(ops).toEqual([{
    op: 'event', id: 'evt:perm:res:tu9', sessionId: 's1', spanId: 'tool:tu9',
    type: 'permission.resolved', ts: 60,
    attrs: { outcome: 'denied', source: 'auto', tool: 'Bash' },
  }])
})

test('permission hooks without tool_use_id fall back to session-scoped ids', () => {
  const ops = mapHookEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'Bash' }, 70)
  expect(ops[0]).toMatchObject({ id: 'evt:perm:req:s1:70', spanId: null })
})

test('Notification carries notification_type', () => {
  const ops = mapHookEvent({ hook_event_name: 'Notification', session_id: 's1', message: 'hi', notification_type: 'idle_prompt' }, 80)
  expect((ops[0] as any).attrs).toEqual({ message: 'hi', notification_type: 'idle_prompt' })
})
```

Append to `packages/cli/test/install.test.ts` (the first test currently expects 7 added hooks — update its `expect(added).toHaveLength(7)` to `9`, and add):
```ts
test('re-running install on a v1 settings file adds only the two new permission hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  const V1_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']
  const hooks: any = {}
  for (const e of V1_EVENTS) hooks[e] = [{ ...(e.endsWith('ToolUse') ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: 'bun /x/hook.ts' }] }]
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks }))
  const { added } = installHooks(dir, 'bun /x/hook.ts')
  expect(added.sort()).toEqual(['PermissionDenied', 'PermissionRequest'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/claude-code/test/map.test.ts packages/cli/test/install.test.ts`
Expected: FAIL — permission cases return `[]`, install adds 7 not 9.

- [ ] **Step 3: Implement**

In `packages/claude-code/src/map.ts`, extend `HookInput`:
```ts
export type HookInput = {
  hook_event_name: string; session_id: string; cwd?: string; transcript_path?: string
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; tool_use_id?: string
  message?: string; notification_type?: string; permission_reason?: string; permission_mode?: string
  [k: string]: unknown
}
```

Replace the `Notification` case and add the two new cases before `default`:
```ts
    case 'Notification':
      return [{ op: 'event', id: `evt:${sid}:notification:${now}`, sessionId: sid, type: 'notification', ts: now, attrs: { message: input.message ?? '', notification_type: input.notification_type ?? '' } }]
    case 'PermissionRequest': {
      const key = input.tool_use_id ?? `${sid}:${now}`
      return [{ op: 'event', id: `evt:perm:req:${key}`, sessionId: sid, spanId: input.tool_use_id ? `tool:${input.tool_use_id}` : null, type: 'permission.requested', ts: now, attrs: { tool: input.tool_name ?? '', reason: input.permission_reason ?? '', mode: input.permission_mode ?? '' } }]
    }
    case 'PermissionDenied': {
      const key = input.tool_use_id ?? `${sid}:${now}`
      return [{ op: 'event', id: `evt:perm:res:${key}`, sessionId: sid, spanId: input.tool_use_id ? `tool:${input.tool_use_id}` : null, type: 'permission.resolved', ts: now, attrs: { outcome: 'denied', source: 'auto', tool: input.tool_name ?? '' } }]
    }
```

In `packages/cli/src/install.ts:4`:
```ts
const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PermissionRequest', 'PermissionDenied'] as const
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/claude-code/test/map.test.ts packages/cli/test/install.test.ts` then `bun test && bunx tsc --noEmit`
Expected: all pass (the existing Notification attrs test in map.test.ts asserts `{ message: 'needs permission' }` via `toMatchObject` — still passes with the added key; if it used `toEqual`, update it to include `notification_type: ''`).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code packages/cli && git commit -m "Map PermissionRequest/PermissionDenied hooks to typed permission events"
```

---

### Task 2: Store — placeholder name/kind upgrade on span merge

**Files:**
- Modify: `packages/server/src/store.ts:78-89` (span.start merge branch)
- Test: `packages/server/test/store.test.ts`

**Interfaces:**
- Consumes: existing read-merge-write span.start branch.
- Produces: generic rule Tasks 3b/4 rely on: a span whose current `name` is `'(unknown)'` upgrades `name` (and `kind` when current kind is `'custom'`) from a later `span.start`. Non-placeholder names never change.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/store.test.ts`:
```ts
test('placeholder name/kind upgrade on merge; real names never regress', () => {
  const store = new Store(':memory:')
  // linkage-style placeholder arrives first
  store.applyOps([{ op: 'span.start', id: 'agent:a1', sessionId: 's1', parentId: 'tool:t1', kind: 'agent', name: '(unknown)', ts: 10 }])
  store.applyOps([{ op: 'span.start', id: 'agent:a1', sessionId: 's1', parentId: null, kind: 'agent', name: 'general-purpose', ts: 12 }])
  let sp = store.db.query("SELECT * FROM spans WHERE id='agent:a1'").get() as any
  expect(sp.name).toBe('general-purpose')
  expect(sp.parent_id).toBe('tool:t1')
  // reverse order: real name first is kept
  store.applyOps([{ op: 'span.start', id: 'agent:a2', sessionId: 's1', kind: 'agent', name: 'Explore', ts: 20 }])
  store.applyOps([{ op: 'span.start', id: 'agent:a2', sessionId: 's1', kind: 'agent', name: '(unknown)', ts: 21 }])
  sp = store.db.query("SELECT * FROM spans WHERE id='agent:a2'").get() as any
  expect(sp.name).toBe('Explore')
  // orphan span.end placeholder heals kind AND name from the real start
  store.applyOps([{ op: 'span.end', id: 'late2', ts: 30, status: 'ok' }])
  store.applyOps([{ op: 'span.start', id: 'late2', sessionId: 's1', kind: 'tool', name: 'Bash', ts: 29 }])
  sp = store.db.query("SELECT * FROM spans WHERE id='late2'").get() as any
  expect(sp.kind).toBe('tool')
  expect(sp.name).toBe('Bash')
  store.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/store.test.ts`
Expected: FAIL — name stays `'(unknown)'` / kind stays `'custom'`.

- [ ] **Step 3: Implement**

In the span.start merge branch, widen the SELECT and UPDATE:
```ts
        const existing = this.db.query('SELECT session_id, parent_id, started_at, attrs, kind, name FROM spans WHERE id = ?').get(op.id) as
          { session_id: string; parent_id: string | null; started_at: number; attrs: string; kind: string; name: string } | null
```
and in the `else` branch:
```ts
          const sessionId = existing.session_id === '' ? op.sessionId : existing.session_id
          const parentId = existing.parent_id ?? (op.parentId ?? null)
          const startedAt = Math.min(existing.started_at, op.ts)
          const name = existing.name === '(unknown)' ? op.name : existing.name
          const kind = existing.kind === 'custom' && existing.name === '(unknown)' ? op.kind : existing.kind
          const merged = { ...JSON.parse(existing.attrs), ...(op.attrs ?? {}) }
          this.db.run(
            `UPDATE spans SET session_id = ?, parent_id = ?, started_at = ?, kind = ?, name = ?, attrs = ? WHERE id = ?`,
            [sessionId, parentId, startedAt, kind, name, JSON.stringify(merged), op.id],
          )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/server && bunx tsc --noEmit`
Expected: all pass, including the existing merge-idempotency and hook-then-transcript tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Upgrade placeholder span name/kind on merge"
```

---

### Task 3a: Parser — agent-file support

**Files:**
- Modify: `packages/claude-code/src/transcript.ts`
- Create: `packages/claude-code/fixtures/fix1/subagents/agent-a1b2c3d4e5.jsonl`
- Test: `packages/claude-code/test/transcript.test.ts`

**Interfaces:**
- Consumes: existing `parseTranscriptLine(raw, state)`.
- Produces (Tasks 3b/4/5 rely on these exactly):
```ts
export type TranscriptState = {
  sessionStarted: boolean
  agentStarted: boolean   // agent span.start emitted at least once
  agentNamed: boolean     // a name-bearing (attributionAgent) emission happened
  agentId: string | null
  agentFirstTs: number | null  // ts of the first agent line; re-emissions reuse it so MIN(started_at) holds
}
export function newTranscriptState(): TranscriptState
// { sessionStarted: false, agentStarted: false, agentNamed: false, agentId: null, agentFirstTs: null }
```
Behavior: lines carrying `agentId` never emit `session.start`; the first such line emits `span.start { id: agent:<agentId>, kind: 'agent', name: <attributionAgent ?? '(agent)'>, parentId: null }` and sets `state.agentStarted`/`state.agentId`; llm spans from agent lines get `parentId: agent:<agentId>`; events from agent lines carry `attrs.agentId`.

- [ ] **Step 1: Create the fixture**

`packages/claude-code/fixtures/fix1/subagents/agent-a1b2c3d4e5.jsonl` (exactly two lines):
```jsonl
{"parentUuid":null,"isSidechain":true,"agentId":"a1b2c3d4e5","type":"user","message":{"role":"user","content":"count the files"},"uuid":"au1","timestamp":"2026-07-04T12:00:03.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
{"parentUuid":"au1","isSidechain":true,"agentId":"a1b2c3d4e5","attributionAgent":"general-purpose","type":"assistant","message":{"model":"claude-haiku-4-5","id":"msg_a1","type":"message","role":"assistant","content":[{"type":"text","text":"There are 2 files."}],"usage":{"input_tokens":40,"output_tokens":8}},"uuid":"au2","timestamp":"2026-07-04T12:00:04.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
```

- [ ] **Step 2: Write the failing test**

Append to `packages/claude-code/test/transcript.test.ts`:
```ts
const agentLines = (await Bun.file(new URL('../fixtures/fix1/subagents/agent-a1b2c3d4e5.jsonl', import.meta.url)).text()).split('\n').filter(Boolean)

test('agent file: agent span, parenting, no session.start, attributed events', () => {
  const state = newTranscriptState()
  const ops = agentLines.flatMap(l => parseTranscriptLine(l, state))
  expect(ops.filter(o => o.op === 'session.start')).toHaveLength(0)
  const agent = ops.find(o => o.op === 'span.start' && (o as any).kind === 'agent') as any
  expect(agent).toMatchObject({ id: 'agent:a1b2c3d4e5', sessionId: 'fix1', name: 'general-purpose', parentId: null })
  expect(agent.ts).toBe(Date.parse('2026-07-04T12:00:03.000Z'))
  expect(ops.filter(o => o.op === 'span.start' && (o as any).kind === 'agent')).toHaveLength(1)
  const llm = ops.find(o => o.op === 'span.start' && (o as any).kind === 'llm') as any
  expect(llm).toMatchObject({ id: 'llm:msg_a1', parentId: 'agent:a1b2c3d4e5' })
  const userEvt = ops.find(o => o.op === 'event' && (o as any).type === 'message.user') as any
  expect(userEvt.attrs.agentId).toBe('a1b2c3d4e5')
  expect(state.agentId).toBe('a1b2c3d4e5')
})
```

Semantics under test: the agent span's `name` comes from the SECOND line's `attributionAgent` (the first line lacks it), yet the span must start at the FIRST line's ts. So the first agent line emits `span.start` named `'(unknown)'` (Task 2's merge-upgradeable placeholder), and the first later line carrying `attributionAgent` re-emits `span.start` with the real name and the ORIGINAL first ts (`state.agentFirstTs`); the store merge upgrades the name and MIN keeps `started_at`. `state.agentNamed` tracks whether a name-bearing emission has happened.

Add to the test above, after the `expect(state.agentId)` line:
```ts
  // first line lacks attributionAgent → placeholder emitted, then upgraded by second line
  const starts = ops.filter(o => o.op === 'span.start' && (o as any).id === 'agent:a1b2c3d4e5') as any[]
  expect(starts[0].name).toBe('(unknown)')
  expect(starts[1]).toMatchObject({ name: 'general-purpose', ts: Date.parse('2026-07-04T12:00:03.000Z') })
```
(The re-emission keeps the FIRST line's ts so `started_at` stays correct via MIN.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/claude-code/test/transcript.test.ts`
Expected: FAIL — no agent span emitted; `newTranscriptState()` lacks the new fields (tsc will also complain until implemented).

- [ ] **Step 4: Implement**

In `packages/claude-code/src/transcript.ts`:
```ts
export type TranscriptState = {
  sessionStarted: boolean; agentStarted: boolean; agentNamed: boolean
  agentId: string | null; agentFirstTs: number | null
}
export function newTranscriptState(): TranscriptState {
  return { sessionStarted: false, agentStarted: false, agentNamed: false, agentId: null, agentFirstTs: null }
}
```
Extend `Line` with `agentId?: string; attributionAgent?: string`.

In `parseTranscriptLine`, after the `if (!sid) return []` guard, replace the session.start block with:
```ts
  const agentId = line.agentId ?? state.agentId

  if (line.agentId) {
    state.agentId = line.agentId
    state.agentFirstTs ??= ts
    if (!state.agentStarted || (!state.agentNamed && line.attributionAgent)) {
      state.agentStarted = true
      if (line.attributionAgent) state.agentNamed = true
      ops.push({
        op: 'span.start', id: `agent:${line.agentId}`, sessionId: sid, parentId: null, kind: 'agent',
        name: line.attributionAgent ?? '(unknown)', ts: state.agentFirstTs, attrs: {},
      })
    }
  } else if (!state.sessionStarted && line.cwd) {
    state.sessionStarted = true
    ops.push({
      op: 'session.start', sessionId: sid, source: 'claude-code',
      project: line.cwd.split('/').pop(), cwd: line.cwd, gitBranch: line.gitBranch, ts,
    })
  }
```

Change the llm span's parent and event attrs:
```ts
  const side = line.isSidechain ? { sidechain: true } : {}
  const agentAttr = agentId ? { agentId } : {}
```
- llm `span.start`: `parentId: agentId ? `agent:${agentId}` : null`
- `message.user` and `message.assistant` events: attrs gain `...agentAttr`
- tool spans keep `parentId: llm:<id>` unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/claude-code && bunx tsc --noEmit`
Expected: all pass — including the untouched existing fixture tests (parent-session behavior is unchanged by this task).

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code && git commit -m "Parse subagent transcript files into agent span subtrees"
```

---

### Task 3b: Parser — linkage, compaction, summary suppression + parent fixture

**Files:**
- Modify: `packages/claude-code/src/transcript.ts`, `packages/claude-code/fixtures/session.jsonl` (append 4 lines)
- Test: `packages/claude-code/test/transcript.test.ts` (new tests + update ONE existing assertion)

**Interfaces:**
- Consumes: Task 3a state shape; Task 2 merge rule (linkage emits placeholder name `'(unknown)'`).
- Produces: parent-session parsing emits — `span.start {id: agent:<match>, parentId: tool:<tool_use_id>, kind: 'agent', name: '(unknown)'}` from Agent tool_results matching `/agentId: (a[0-9a-f]{6,})/`; `event session.compact` (id `evt:compact:<uuid>`, attrs `{trigger, preTokens, durationMs}`); `event session.compact_summary` instead of `message.user` for `isCompactSummary` lines.

- [ ] **Step 1: Append to the fixture**

Append these 4 lines to `packages/claude-code/fixtures/session.jsonl` (before the `not json at all` line or after — order-independent; append at end):
```jsonl
{"parentUuid":"u3","isSidechain":false,"type":"assistant","message":{"model":"claude-fable-5","id":"msg_02","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_ag1","name":"Agent","input":{"description":"count files","subagent_type":"general-purpose","prompt":"count the files"}}],"usage":{"input_tokens":50,"output_tokens":10}},"uuid":"u4","timestamp":"2026-07-04T12:00:02.500Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
{"parentUuid":"u4","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_ag1","type":"tool_result","content":"Async agent launched successfully. agentId: a1b2c3d4e5 (internal ID)"}]},"uuid":"u5","timestamp":"2026-07-04T12:00:05.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
{"parentUuid":"u5","isSidechain":false,"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":150000,"durationMs":21000},"uuid":"u6","timestamp":"2026-07-04T12:00:06.000Z","cwd":"/home/dev/myproj","sessionId":"fix1"}
{"parentUuid":"u6","isSidechain":false,"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation."},"uuid":"u7","timestamp":"2026-07-04T12:00:07.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/claude-code/test/transcript.test.ts`:
```ts
test('Agent tool_result links the agent span under the spawning tool span', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))
  const link = ops.find(o => o.op === 'span.start' && (o as any).id === 'agent:a1b2c3d4e5') as any
  expect(link).toMatchObject({ parentId: 'tool:toolu_ag1', kind: 'agent', name: '(unknown)', sessionId: 'fix1' })
})

test('compact_boundary → session.compact with metadata', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))
  const c = ops.find(o => o.op === 'event' && (o as any).type === 'session.compact') as any
  expect(c).toMatchObject({ id: 'evt:compact:u6', attrs: { trigger: 'auto', preTokens: 150000, durationMs: 21000 } })
})

test('isCompactSummary suppresses message.user and emits session.compact_summary', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'message.user')).toHaveLength(1)  // still just 'list the files'
  const s = ops.find(o => o.op === 'event' && (o as any).type === 'session.compact_summary') as any
  expect(s.attrs.preview).toContain('continued from a previous conversation')
})
```

Update ONE existing assertion in the first fixture test: the fixture now yields two llm spans (`llm:msg_01`, `llm:msg_02`) and two tool spans — if the existing test asserts single-instance finds only (it uses `.find(...)`), it still passes; verify and only change assertions that count spans if any do.

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/claude-code/test/transcript.test.ts`
Expected: FAIL — no linkage span, no compact events, and `message.user` count is 2 (summary not yet suppressed).

- [ ] **Step 4: Implement**

Extend `Line` with `subtype?: string; compactMetadata?: Record<string, unknown>; isCompactSummary?: boolean`.

In `parseTranscriptLine`:

Replace the `message.user` block:
```ts
  if (line.type === 'user' && typeof line.message?.content === 'string') {
    ops.push({
      op: 'event', id: `evt:msg:${line.uuid}`, sessionId: sid,
      type: line.isCompactSummary ? 'session.compact_summary' : 'message.user', ts,
      attrs: { preview: line.message.content.slice(0, 200), ...side, ...agentAttr },
    })
  }
```

Add after it — tool_result scan for agent linkage (user lines with array content):
```ts
  if (line.type === 'user' && Array.isArray(line.message?.content)) {
    for (const block of line.message.content as any[]) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      const m = text.match(/agentId: (a[0-9a-f]{6,})/)
      if (m) {
        ops.push({
          op: 'span.start', id: `agent:${m[1]}`, sessionId: sid, parentId: `tool:${block.tool_use_id}`,
          kind: 'agent', name: '(unknown)', ts, attrs: {},
        })
      }
    }
  }
```

Add the compact case:
```ts
  if (line.type === 'system' && line.subtype === 'compact_boundary') {
    const md = (line.compactMetadata ?? {}) as Record<string, unknown>
    ops.push({
      op: 'event', id: `evt:compact:${line.uuid}`, sessionId: sid, type: 'session.compact', ts,
      attrs: { trigger: md.trigger ?? '', preTokens: md.preTokens ?? 0, durationMs: md.durationMs ?? 0 },
    })
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/claude-code && bunx tsc --noEmit`
Expected: all pass. If the run surfaces other assertion drift from the fixture additions, update only assertions whose counts legitimately changed and record each in the report.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code && git commit -m "Link agent spans to spawning tool calls; emit compaction events"
```

---

### Task 4: Importer — full state snapshot, agent span.end ratchet, importSession helper

**Files:**
- Modify: `packages/claude-code/src/importer.ts`, `packages/claude-code/src/index.ts` (export), `packages/cli/src/index.ts` (import case)
- Test: `packages/claude-code/test/importer.test.ts`

**Interfaces:**
- Consumes: Task 3a `TranscriptState` (multi-field), `parseTranscriptLine`, `emitOps`.
- Produces:
```ts
// unchanged signature, new behavior: snapshot/restore covers ALL state fields; when state.agentId
// is set and ops were parsed, appends span.end { id: agent:<agentId>, ts: <max ts>, status: 'ok' }
export async function importTranscript(path, url, fromByte = 0, state = newTranscriptState(), finalize = false): Promise<ImportResult>

// NEW — imports a session file plus its <dir>/<sessionId>/subagents/*.jsonl siblings
export async function importSession(path: string, url: string, opts?: { finalize?: boolean }): Promise<{ files: number; ops: number; emitted: boolean }>
```
CLI `import` command switches to `importSession(path, url, { finalize: true })` (finalize applies to the main file only, never agent files).

- [ ] **Step 1: Write the failing tests**

Append to `packages/claude-code/test/importer.test.ts`:
```ts
const agentLine = JSON.stringify({ isSidechain: true, agentId: 'a1b2c3d4e5', attributionAgent: 'general-purpose', type: 'assistant', message: { model: 'm', id: 'msg_x', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'ax1', timestamp: '2026-07-04T12:00:09.000Z', cwd: '/p/x', sessionId: 'imp2' })

test('agent file import appends a ratcheting agent span.end', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 'agent-a1b2c3d4e5.jsonl')
  writeFileSync(file, agentLine + '\n')
  await importTranscript(file, url, 0, newTranscriptState())
  const ops = batches[0]
  const end = ops.filter((o: any) => o.op === 'span.end' && o.id === 'agent:a1b2c3d4e5')
  expect(end).toHaveLength(1)
  expect(end[0].ts).toBe(Date.parse('2026-07-04T12:00:09.000Z'))
  expect(ops.some((o: any) => o.op === 'session.end')).toBe(false)  // agent files never finalize sessions
  stop()
})

test('failed emit restores ALL state fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 'agent-a1b2c3d4e5.jsonl')
  writeFileSync(file, agentLine + '\n')
  const state = newTranscriptState()
  const r = await importTranscript(file, 'http://localhost:1', 0, state)
  expect(r.emitted).toBe(false)
  expect(state).toEqual(newTranscriptState())
})

test('importSession imports main file plus subagents dir, finalize on main only', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  writeFileSync(join(dir, 's9.jsonl'), line1.replace(/imp1/g, 's9') + '\n')
  const subDir = join(dir, 's9', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(subDir, 'agent-a1b2c3d4e5.jsonl'), agentLine.replace(/imp2/g, 's9') + '\n')
  const { importSession } = await import('../src/importer')
  const r = await importSession(join(dir, 's9.jsonl'), url, { finalize: true })
  expect(r.files).toBe(2)
  expect(r.emitted).toBe(true)
  const all = batches.flat()
  expect(all.filter((o: any) => o.op === 'session.end')).toHaveLength(1)
  expect(all.some((o: any) => o.op === 'span.start' && o.id === 'agent:a1b2c3d4e5')).toBe(true)
  stop()
})
```
(`mkdirSync` needs adding to the existing fs imports in this test file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/claude-code/test/importer.test.ts`
Expected: FAIL — no agent span.end, `importSession` not exported, state restore partial.

- [ ] **Step 3: Implement**

In `packages/claude-code/src/importer.ts` replace the snapshot/finalize/emit block:
```ts
  // parsing mutates state; snapshot ALL fields so a failed emit retries cleanly
  const snapshot = { ...state }
  const ops = complete.split('\n').filter(Boolean).flatMap(l => parseTranscriptLine(l, state))
  if (ops.length > 0) {
    const maxTs = ops.reduce((max, o) => (o.ts > max ? o.ts : max), 0)
    if (state.agentId) {
      ops.push({ op: 'span.end', id: `agent:${state.agentId}`, ts: maxTs, status: 'ok' } satisfies IngestOp)
    }
    if (finalize && !state.agentId) {
      const sessionId = (ops.find(o => 'sessionId' in o) as { sessionId: string } | undefined)?.sessionId
      if (sessionId) ops.push({ op: 'session.end', sessionId, ts: maxTs } satisfies IngestOp)
    }
  }
  const emitted = await emitOps(url, ops, 5000)
  if (!emitted) {
    Object.assign(state, snapshot)
    return { ops: ops.length, emitted: false, bytesRead: fromByte }
  }
  return { ops: ops.length, emitted, bytesRead: fromByte + consumedBytes }
```

Add at the bottom:
```ts
import { readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

export async function importSession(path: string, url: string, opts: { finalize?: boolean } = {}) {
  let files = 0, ops = 0, emitted = true
  const main = await importTranscript(path, url, 0, newTranscriptState(), opts.finalize ?? false)
  files++; ops += main.ops; emitted = emitted && main.emitted
  const subDir = join(dirname(path), basename(path, '.jsonl'), 'subagents')
  let subs: string[] = []
  try { subs = readdirSync(subDir).filter(f => f.endsWith('.jsonl')) } catch {}
  for (const f of subs) {
    const r = await importTranscript(join(subDir, f), url, 0, newTranscriptState())
    files++; ops += r.ops; emitted = emitted && r.emitted
  }
  return { files, ops, emitted }
}
```
(Merge the fs/path imports with the existing import lines at the top of the file rather than duplicating.)

Export from `packages/claude-code/src/index.ts`:
```ts
export { importTranscript, importSession, type ImportResult } from './importer'
```

In `packages/cli/src/index.ts` import case, replace the `importTranscript(resolve(arg), url)` call with `importSession(resolve(arg), url, { finalize: true })` (import the new symbol; success message becomes `imported ${r.ops} ops from ${r.files} file(s)`; keep the existing try/catch and exit codes; `r.emitted` drives exit code as before).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (existing importer tests unchanged: line1-based files carry no agentId, so no ratchet ops appear in their batches).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code packages/cli && git commit -m "Import subagent files with agent span ratcheting; full state snapshots"
```

---

### Task 5: Tailer — recurse into subagents dirs

**Files:**
- Modify: `packages/claude-code/src/tailer.ts`
- Test: `packages/claude-code/test/tailer.test.ts` (new file)

**Interfaces:**
- Consumes: `importTranscript`, `newTranscriptState`.
- Produces: `startTailer(projectsDir, url, pollMs?)` unchanged signature; now also tails `<project>/<sessionId>/subagents/*.jsonl` with independent offsets.

- [ ] **Step 1: Write the failing test**

`packages/claude-code/test/tailer.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTailer } from '../src/tailer'

test('tailer discovers session files and subagent files', async () => {
  const batches: any[][] = []
  const srv = Bun.serve({ port: 0, async fetch(req) { batches.push(await req.json()); return new Response('{"accepted":1,"rejected":[]}') } })
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tail-'))
  const proj = join(projects, '-home-x-proj')
  const subDir = join(proj, 'sess1', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(proj, 'sess1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: '2026-07-04T12:00:00.000Z', cwd: '/x/proj', sessionId: 'sess1' }) + '\n')
  writeFileSync(join(subDir, 'agent-a1b2c3d4e5.jsonl'), JSON.stringify({ isSidechain: true, agentId: 'a1b2c3d4e5', attributionAgent: 'Explore', type: 'user', message: { role: 'user', content: 'go' }, uuid: 'au1', timestamp: '2026-07-04T12:00:01.000Z', cwd: '/x/proj', sessionId: 'sess1' }) + '\n')

  const tailer = startTailer(projects, `http://localhost:${srv.port}`, 100)
  await Bun.sleep(400)
  tailer.stop()
  srv.stop(true)

  const all = batches.flat()
  expect(all.some((o: any) => o.op === 'session.start' && o.sessionId === 'sess1')).toBe(true)
  expect(all.some((o: any) => o.op === 'span.start' && o.id === 'agent:a1b2c3d4e5')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/claude-code/test/tailer.test.ts`
Expected: FAIL — session.start arrives but the agent span never does (subagents dir not scanned).

- [ ] **Step 3: Implement**

Replace `pass()` in `packages/claude-code/src/tailer.ts` (and hoist the per-file logic into `scanFile`):
```ts
  async function scanFile(path: string) {
    let fs = files.get(path)
    if (!fs) { fs = { offset: 0, state: newTranscriptState() }; files.set(path, fs) }
    try {
      if (statSync(path).size > fs.offset) {
        const r = await importTranscript(path, url, fs.offset, fs.state)
        fs.offset = r.bytesRead
      }
    } catch {}
  }

  async function pass() {
    let dirs: string[] = []
    try { dirs = readdirSync(projectsDir) } catch { return }
    for (const d of dirs) {
      const dir = join(projectsDir, d)
      let entries: import('node:fs').Dirent[] = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          await scanFile(join(dir, e.name))
        } else if (e.isDirectory()) {
          const subDir = join(dir, e.name, 'subagents')
          let subs: string[] = []
          try { subs = readdirSync(subDir).filter(f => f.endsWith('.jsonl')) } catch { continue }
          for (const f of subs) await scanFile(join(subDir, f))
        }
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code && git commit -m "Tail subagent transcript directories"
```

---

### Task 6: Dashboard — permission status, event detail rendering

**Files:**
- Create: `packages/dashboard/src/perms.ts`
- Modify: `packages/dashboard/src/views/SessionDetailView.tsx`, `packages/dashboard/src/theme.css` (append)
- Test: `packages/dashboard/test/perms.test.ts`

**Interfaces:**
- Consumes: `EventRow`, `SpanRow` from `../types`; event shapes from Task 1.
- Produces:
```ts
// perms.ts
export type PermStatus = 'allowed' | 'denied' | 'pending'
export function permissionStatus(events: EventRow[], spans: SpanRow[]): Map<string, PermStatus>  // keyed by spanId
export function eventDetail(attrs: string): string  // preview ?? message ?? reason ?? outcome/trigger rendering ?? ''
```

- [ ] **Step 1: Write the failing test**

`packages/dashboard/test/perms.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { permissionStatus, eventDetail } from '../src/perms'
import type { EventRow, SpanRow } from '../src/types'

const evt = (id: string, type: string, spanId: string | null, attrs = {}): EventRow =>
  ({ id, session_id: 's', span_id: spanId, ts: 1, type, attrs: JSON.stringify(attrs) })
const span = (id: string, ended: number | null): SpanRow =>
  ({ id, session_id: 's', parent_id: null, kind: 'tool', name: 'Bash', started_at: 1, ended_at: ended, status: ended ? 'ok' : 'running', attrs: '{}' })

test('permissionStatus derives allowed/denied/pending', () => {
  const events = [
    evt('r1', 'permission.requested', 'tool:a'),
    evt('r2', 'permission.requested', 'tool:b'),
    evt('r3', 'permission.requested', 'tool:c'),
    evt('d2', 'permission.resolved', 'tool:b', { outcome: 'denied' }),
  ]
  const spans = [span('tool:a', 99), span('tool:c', null)]
  const m = permissionStatus(events, spans)
  expect(m.get('tool:a')).toBe('allowed')   // requested, span ran to completion
  expect(m.get('tool:b')).toBe('denied')    // explicit denial event
  expect(m.get('tool:c')).toBe('pending')   // requested, never ended, no denial
  expect(m.size).toBe(3)
})

test('eventDetail renders each attr shape', () => {
  expect(eventDetail(JSON.stringify({ preview: 'hi' }))).toBe('hi')
  expect(eventDetail(JSON.stringify({ message: 'note' }))).toBe('note')
  expect(eventDetail(JSON.stringify({ reason: 'rule', tool: 'Bash' }))).toBe('Bash: rule')
  expect(eventDetail(JSON.stringify({ outcome: 'denied', tool: 'Bash' }))).toBe('Bash: denied')
  expect(eventDetail(JSON.stringify({ trigger: 'auto', preTokens: 150000 }))).toBe('auto compact at 150000 tokens')
  expect(eventDetail('garbage')).toBe('')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard/test/perms.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/dashboard/src/perms.ts`:
```ts
import type { EventRow, SpanRow } from './types'

export type PermStatus = 'allowed' | 'denied' | 'pending'

export function permissionStatus(events: EventRow[], spans: SpanRow[]): Map<string, PermStatus> {
  const ended = new Set(spans.filter(s => s.ended_at != null).map(s => s.id))
  const denied = new Set(events.filter(e => e.type === 'permission.resolved' && e.span_id).map(e => e.span_id as string))
  const out = new Map<string, PermStatus>()
  for (const e of events) {
    if (e.type !== 'permission.requested' || !e.span_id) continue
    out.set(e.span_id, denied.has(e.span_id) ? 'denied' : ended.has(e.span_id) ? 'allowed' : 'pending')
  }
  return out
}

export function eventDetail(attrs: string): string {
  let a: Record<string, unknown>
  try { a = JSON.parse(attrs) } catch { return '' }
  if (typeof a.preview === 'string') return a.preview
  if (typeof a.message === 'string' && a.message) return a.message
  if (typeof a.reason === 'string' && a.reason) return `${a.tool ?? ''}: ${a.reason}`
  if (typeof a.outcome === 'string') return `${a.tool ?? ''}: ${a.outcome}`
  if (typeof a.trigger === 'string') return `${a.trigger} compact at ${a.preTokens ?? '?'} tokens`
  return ''
}
```

In `SessionDetailView.tsx`:
- `import { permissionStatus, eventDetail, type PermStatus } from '../perms'`
- In the component body: `const perms = useMemo(() => permissionStatus(events, spans), [detail])` — note `events`/`spans` destructure currently happens after the early returns; move the destructure above the `useMemo` calls or derive from `detail` guardedly: `const perms = useMemo(() => detail ? permissionStatus(detail.events, detail.spans) : new Map<string, PermStatus>(), [detail])` (place next to the existing `tree` useMemo).
- Pass `perms` into the waterfall: `<WaterfallRow key={n.span.id} node={n} t0={t0} total={total} perms={perms} />`; extend `WaterfallRow` props with `perms: Map<string, PermStatus>` (thread to children) and render after the name:
```tsx
{perms.has(s.id) && <span className={`perm-badge ${perms.get(s.id)}`}>{perms.get(s.id)}</span>}
```
- Replace the events-table detail cell IIFE with `{eventDetail(e.attrs)}`.

Append to `theme.css`:
```css
.perm-badge { font-size: 10px; padding: 0 6px; border-radius: 8px; margin-left: 6px; }
.perm-badge.allowed { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.perm-badge.denied { background: color-mix(in srgb, var(--err) 20%, transparent); color: var(--err); }
.perm-badge.pending { background: color-mix(in srgb, var(--run) 20%, transparent); color: var(--run); }
```

- [ ] **Step 4: Verify**

Run: `bun test packages/dashboard && cd packages/dashboard && bun run build && cd ../.. && bunx tsc --noEmit`
Expected: tests pass, build clean, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard && git commit -m "Derive and render permission status; typed event detail rendering"
```

---

### Task 7: E2E extension + rollout

**Files:**
- Modify: `test/e2e.test.ts`
- Rollout commands (not committed): install + service restart.

**Interfaces:**
- Consumes: `importSession` from `@0rrery/claude-code`; fixtures from Tasks 3a/3b.

- [ ] **Step 1: Extend the e2e test**

In `test/e2e.test.ts`, switch the import call to `importSession` and extend assertions. Replace the body after server startup with:
```ts
  const fixture = new URL('../packages/claude-code/fixtures/session.jsonl', import.meta.url).pathname
  const { importSession } = await import('@0rrery/claude-code')
  const r = await importSession(fixture, srv.url)
  expect(r.emitted).toBe(true)
  expect(r.files).toBe(2)  // session + one subagent file

  const detail = await (await fetch(`${srv.url}/api/sessions/fix1`)).json()
  const kinds = detail.spans.map((s: any) => s.kind).sort()
  expect(kinds).toEqual(['agent', 'llm', 'llm', 'llm', 'tool', 'tool'])

  const agent = detail.spans.find((s: any) => s.id === 'agent:a1b2c3d4e5')
  expect(agent).toMatchObject({ parent_id: 'tool:toolu_ag1', kind: 'agent', name: 'general-purpose' })
  expect(agent.ended_at).not.toBeNull()

  const subLlm = detail.spans.find((s: any) => s.id === 'llm:msg_a1')
  expect(subLlm.parent_id).toBe('agent:a1b2c3d4e5')

  const types = detail.events.map((e: any) => e.type).sort()
  expect(types).toEqual(['message.assistant', 'message.assistant', 'message.user', 'message.user', 'session.compact', 'session.compact_summary'])
  srv.stop()
```
Keep the sessions-list assertions that precede this. Note the merge-order test embedded here: the parent file (linkage placeholder, name `'(unknown)'`) imports BEFORE the agent file, and the final name must be `general-purpose` — proving Task 2's upgrade rule end-to-end. If the actual op counts differ when run, reason about which side is wrong (fixture vs expectation) and report — do not blind-patch numbers.

- [ ] **Step 2: Run the full suite**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add test/e2e.test.ts && git commit -m "Extend e2e: agent subtree, linkage merge, compact and permission-ready events"
```

- [ ] **Step 4: Rollout + live verification**

```bash
bun packages/cli/src/index.ts install       # adds PermissionRequest, PermissionDenied
systemctl --user restart 0rrery
sleep 8
curl -s localhost:7317/api/stats
curl -s "localhost:7317/api/sessions/$(ls -t ~/.claude/projects/-home-mlayug-Documents-0pon-commercial-0rrery/*.jsonl | head -1 | xargs basename -s .jsonl)" | python3 -c "import json,sys; d=json.load(sys.stdin); print('agent spans:', sum(1 for s in d['spans'] if s['kind']=='agent'))"
```
Expected: install reports the two new hooks; after restart-backfill, the current session shows agent spans > 0 (this session spawned many subagents). Report the observed numbers.

---

## Out of scope (unchanged debt)

Tailer offset persistence, active-status staleness rule, user-clicked-deny detection, `mcp`/`hook` span kinds, permission analytics.
