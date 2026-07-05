# Transcript-Side Tool Span Ends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every transcript `tool_result` block closes its tool span (`error` when `is_error`, else `ok`), so tool spans stop rendering "running" forever and imports are truthful end to end.

**Architecture:** Restructure the user-array-content branch of `parseTranscriptLine` into ONE loop over tool_result blocks: denial blocks keep their exact existing pair, all other blocks get a generic `span.end`, and the agent-linkage scan runs per block regardless. Dashboard: zero changes.

**Tech Stack:** Existing: TypeScript, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-transcript-tool-end-design.md`. Read it first.
- Per non-denial tool_result block (with `tool_use_id`): exactly one op — `{ op: 'span.end', id: 'tool:<tool_use_id>', ts, status: block.is_error ? 'error' : 'ok', attrs: {} }`.
- Denial blocks (`line.toolUseResult === 'User rejected tool use'`): the existing pair EXACTLY as-is (`permission.resolved` event + `span.end` status `'error'` attrs `{denied: true}`), and NO additional generic end.
- Blocks without `tool_use_id`: nothing, as today.
- Agent-linkage behavior unchanged: same gate (`state.agentToolUseIds`), same regex, same emitted op — Agent tool_results now ALSO get the generic end (correct per spec).
- `bun test` FROM THE REPO ROOT (currently 110 pass) + `bunx tsc --noEmit` green before commit; paste the actual root tail.
- Only the assertions this plan names may be updated; any other breakage gets hand-traced and reported, not silently edited.

---

### Task 1: generic tool span ends in the parser

**Files:**
- Modify: `packages/claude-code/src/transcript.ts:66-90` (the user-array branch), `packages/claude-code/test/transcript.test.ts:121-127` (one existing test updated), `test/e2e.test.ts` (two new assertions)
- Test: `packages/claude-code/test/transcript.test.ts` (append)

**Interfaces:**
- Consumes: existing `parseTranscriptLine(raw, state)` and the `denyLine(tur)` helper already defined in `transcript.test.ts` (module scope, reusable by appended tests).
- Produces: the per-block emission per Global Constraints; consumed by existing store with no changes.

- [ ] **Step 1: Write the failing tests**

Append to `packages/claude-code/test/transcript.test.ts`:
```ts
const resLine = (blocks: any[]) => JSON.stringify({
  type: 'user', message: { role: 'user', content: blocks },
  uuid: 'ur1', timestamp: '2026-07-05T13:00:00.000Z', cwd: '/p/x', sessionId: 'te1', gitBranch: 'main',
})

test('tool_result closes its tool span with status ok', () => {
  const ops = parseTranscriptLine(resLine([{ tool_use_id: 'toolu_ok1', type: 'tool_result', content: 'done' }]), newTranscriptState())
  const end = ops.find(o => o.op === 'span.end') as any
  expect(end).toMatchObject({ id: 'tool:toolu_ok1', status: 'ok' })
})

test('is_error tool_result closes its span with status error and no denial ops', () => {
  const ops = parseTranscriptLine(resLine([{ tool_use_id: 'toolu_er1', type: 'tool_result', is_error: true, content: 'Error: Exit code 1' }]), newTranscriptState())
  const end = ops.find(o => o.op === 'span.end') as any
  expect(end).toMatchObject({ id: 'tool:toolu_er1', status: 'error' })
  expect((end.attrs ?? {}).denied).toBeUndefined()
  expect(ops.some(o => o.op === 'event' && (o as any).type === 'permission.resolved')).toBe(false)
})

test('one line with two tool_results closes both spans', () => {
  const ops = parseTranscriptLine(resLine([
    { tool_use_id: 'toolu_m1', type: 'tool_result', content: 'a' },
    { tool_use_id: 'toolu_m2', type: 'tool_result', is_error: true, content: 'b' },
  ]), newTranscriptState())
  const ends = ops.filter(o => o.op === 'span.end') as any[]
  expect(ends.map(e => [e.id, e.status])).toEqual([['tool:toolu_m1', 'ok'], ['tool:toolu_m2', 'error']])
})

test('denied blocks get exactly one span.end (the denial one)', () => {
  const ops = parseTranscriptLine(denyLine('User rejected tool use'), newTranscriptState())
  const ends = ops.filter(o => o.op === 'span.end') as any[]
  expect(ends).toHaveLength(1)
  expect(ends[0].attrs).toMatchObject({ denied: true })
})
```

- [ ] **Step 2: Update the one existing test whose expectation deliberately flips**

Replace the test at `packages/claude-code/test/transcript.test.ts:121-127` (`'ordinary error toolUseResult strings emit no denial ops'`) with:
```ts
test('ordinary error toolUseResult strings emit a generic end, no denial ops', () => {
  for (const tur of ['Error: Exit code 1', 'Error: File has not been read yet. Read it first before writing to it.', { stdout: 'x' }, undefined]) {
    const ops = parseTranscriptLine(denyLine(tur), newTranscriptState())
    expect(ops.some(o => o.op === 'event' && (o as any).type === 'permission.resolved')).toBe(false)
    const end = ops.find(o => o.op === 'span.end') as any
    expect(end).toMatchObject({ id: 'tool:toolu_dn1', status: 'error' })
    expect((end.attrs ?? {}).denied).toBeUndefined()
  }
})
```
(`denyLine`'s block carries `is_error: true`, so the generic end is status `'error'` for all four values.)

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `bun test packages/claude-code/test/transcript.test.ts`
Expected: the first three Step-1 tests FAIL (no generic end emitted yet) and the Step-2 test FAILS (`end` is undefined). The fourth Step-1 test (`denied blocks get exactly one span.end`) PASSES both before and after — it is a regression pin against double-ending denial blocks, not a red test. The pre-existing denial tests still pass.

- [ ] **Step 4: Implement**

Replace `packages/claude-code/src/transcript.ts:66-90` (the entire `if (line.type === 'user' && Array.isArray(line.message?.content))` block) with:
```ts
  if (line.type === 'user' && Array.isArray(line.message?.content)) {
    const denied = line.toolUseResult === 'User rejected tool use'
    for (const block of line.message.content as any[]) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue
      if (denied) {
        ops.push({
          op: 'event', id: `evt:perm:res:${block.tool_use_id}`, sessionId: sid, spanId: `tool:${block.tool_use_id}`,
          type: 'permission.resolved', ts, attrs: { outcome: 'denied', source: 'user' },
        })
        ops.push({ op: 'span.end', id: `tool:${block.tool_use_id}`, ts, status: 'error', attrs: { denied: true } })
      } else {
        ops.push({ op: 'span.end', id: `tool:${block.tool_use_id}`, ts, status: block.is_error ? 'error' : 'ok', attrs: {} })
      }
      if (state.agentToolUseIds.has(block.tool_use_id)) {
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
  }
```
This is a restructure, not a rewrite: the denial pair and the linkage op are byte-identical to the current code; only the loop structure and the new `else` arm change.

- [ ] **Step 5: e2e additions**

The fixture already carries tool_results for `toolu_01` and `toolu_ag1` (and the denial's `toolu_dn1`); no fixture changes. Append right after the existing `denied` assertion in `test/e2e.test.ts` (currently line 36):
```ts
  for (const id of ['tool:toolu_01', 'tool:toolu_ag1']) {
    const t = detail.spans.find((s: any) => s.id === id)
    expect(t).toMatchObject({ status: 'ok' })
    expect(t.ended_at).not.toBeNull()
  }
```
No existing e2e assertions reference tool span status except the denied one, which is unchanged.

- [ ] **Step 6: Verify**

Run: `bun test` from the repo root (expect 114 pass / 0 fail — 110 + 4 new) and `bunx tsc --noEmit`.
Expected: all green. If any assertion OTHER than the one named in Step 2 breaks, hand-trace before touching it and report the reasoning.

- [ ] **Step 7: Commit**

```bash
git add packages/claude-code test/e2e.test.ts && git commit -m "Close tool spans from transcript tool_result blocks"
```

- [ ] **Step 8: Live rollout verification**

```bash
systemctl --user restart 0rrery && sleep 6
F=$(grep -rl '"toolUseResult":"User rejected tool use"' ~/.claude/projects/*/*.jsonl | head -1)
bun packages/cli/src/index.ts import "$F"
SID=$(basename "$F" .jsonl)
OUT=/home/mlayug/.cache/claude-tmp/claude-1000/-home-mlayug-Documents-0pon-commercial-0rrery/f56f7822-2b63-4860-a522-0e03202916a5/scratchpad/toolend-check.json
curl -s "localhost:7317/api/sessions/$SID" -o "$OUT"
python3 -c "
import json
d = json.load(open('$OUT'))
tools = [s for s in d['spans'] if s['kind'] in ('tool', 'mcp')]
open_ = [s for s in tools if not s.get('ended_at')]
err = [s for s in tools if s['status'] == 'error']
print(f'tool/mcp spans: {len(tools)} | still open: {len(open_)} | error-status: {len(err)}')
"
```
Expected: `still open: 0` (every tool_result in a complete transcript closes its span; the denial one counts among error-status). Report OBSERVED numbers only; if piped output looks garbled (RTK), read the file instead. A nonzero open count is worth one hand-trace (e.g. a tool_use with no tool_result at end-of-file is legitimately open only if the session died mid-call) — report what the open spans are before judging pass/fail.

---

## Out of scope (per spec)

Waterfall virtualization, span detail panel, sessions-list polish — separate units from the findings doc.
