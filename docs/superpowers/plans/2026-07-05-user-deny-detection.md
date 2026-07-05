# User-Deny Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User-clicked permission denials become `permission.resolved(denied, user)` events and close their orphaned tool spans as `error` — detected via the transcript's exact structured marker, no text matching.

**Architecture:** One addition to `parseTranscriptLine`'s user-array-content branch, gated on `line.toolUseResult === 'User rejected tool use'`. The dashboard needs zero changes (`permissionStatus` checks denied before ended). Fixture + e2e updated deliberately.

**Tech Stack:** Existing: TypeScript, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-user-deny-detection-design.md`. Read it first.
- Detector is EXACT equality on the line-level field: `line.toolUseResult === 'User rejected tool use'`. Never pattern-match tool_result text.
- Per denied tool_result (with `tool_use_id`), exactly two ops: the `permission.resolved` event (id `evt:perm:res:<tool_use_id>`, spanId `tool:<tool_use_id>`, attrs `{outcome: 'denied', source: 'user'}`) and `span.end` (id `tool:<tool_use_id>`, status `'error'`, attrs `{denied: true}`).
- Ordinary string `toolUseResult` values (e.g. `Error: Exit code 1`) and object values must emit NO denial ops.
- The existing agent-linkage scan in the same branch is untouched.
- `bun test` FROM THE REPO ROOT (currently 107 pass) + `bunx tsc --noEmit` green before commit; paste the actual root tail.
- Fixture changes ripple into existing assertions — update ONLY the ones this plan names, with the exact new values given here.

---

### Task 1: denial detection in the parser

**Files:**
- Modify: `packages/claude-code/src/transcript.ts` (Line type + user-array branch, currently lines 65-78), `packages/claude-code/fixtures/fix1.jsonl` (append 2 lines), `test/e2e.test.ts` (two assertion updates)
- Test: `packages/claude-code/test/transcript.test.ts` (append)

**Interfaces:**
- Consumes: existing `parseTranscriptLine(raw, state)`; `Line` gains `toolUseResult?: unknown`.
- Produces: the two-op emission per the Global Constraints; consumed by the existing store/permissionStatus with no changes.

- [ ] **Step 1: Write the failing tests**

Append to `packages/claude-code/test/transcript.test.ts`:
```ts
const denyLine = (tur: unknown) => JSON.stringify({
  type: 'user', toolUseResult: tur,
  message: { role: 'user', content: [{ tool_use_id: 'toolu_dn1', type: 'tool_result', is_error: true, content: "The user doesn't want to proceed with this tool use. The tool use was rejected." }] },
  uuid: 'ud1', timestamp: '2026-07-05T12:00:00.000Z', cwd: '/p/x', sessionId: 'dn1', gitBranch: 'main',
})

test('user rejection marker emits denial event and closes the span', () => {
  const ops = parseTranscriptLine(denyLine('User rejected tool use'), newTranscriptState())
  const evt = ops.find(o => o.op === 'event' && (o as any).type === 'permission.resolved') as any
  expect(evt).toMatchObject({ id: 'evt:perm:res:toolu_dn1', spanId: 'tool:toolu_dn1', attrs: { outcome: 'denied', source: 'user' } })
  const end = ops.find(o => o.op === 'span.end') as any
  expect(end).toMatchObject({ id: 'tool:toolu_dn1', status: 'error', attrs: { denied: true } })
})

test('ordinary error toolUseResult strings emit no denial ops', () => {
  for (const tur of ['Error: Exit code 1', 'Error: File has not been read yet. Read it first before writing to it.', { stdout: 'x' }, undefined]) {
    const ops = parseTranscriptLine(denyLine(tur), newTranscriptState())
    expect(ops.some(o => o.op === 'event' && (o as any).type === 'permission.resolved')).toBe(false)
    expect(ops.some(o => o.op === 'span.end')).toBe(false)
  }
})

test('denial blocks without tool_use_id emit nothing', () => {
  const l = JSON.stringify({ type: 'user', toolUseResult: 'User rejected tool use', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'rejected' }] }, uuid: 'ud2', timestamp: '2026-07-05T12:00:01.000Z', cwd: '/p/x', sessionId: 'dn1' })
  const ops = parseTranscriptLine(l, newTranscriptState())
  expect(ops.filter(o => o.op !== 'session.start')).toHaveLength(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/claude-code/test/transcript.test.ts`
Expected: FAIL — no denial ops emitted (first test's finds return undefined).

- [ ] **Step 3: Implement**

In `packages/claude-code/src/transcript.ts`:
- Extend `Line` with `toolUseResult?: unknown`.
- Inside the existing `if (line.type === 'user' && Array.isArray(line.message?.content))` block, ABOVE the linkage loop, add:
```ts
    if (line.toolUseResult === 'User rejected tool use') {
      for (const block of line.message.content as any[]) {
        if (block?.type !== 'tool_result' || !block.tool_use_id) continue
        ops.push({
          op: 'event', id: `evt:perm:res:${block.tool_use_id}`, sessionId: sid, spanId: `tool:${block.tool_use_id}`,
          type: 'permission.resolved', ts, attrs: { outcome: 'denied', source: 'user' },
        })
        ops.push({ op: 'span.end', id: `tool:${block.tool_use_id}`, ts, status: 'error', attrs: { denied: true } })
      }
    }
```
The linkage loop below stays byte-identical.

- [ ] **Step 4: Fixture + e2e updates**

Append these 2 lines to `packages/claude-code/fixtures/fix1.jsonl`:
```jsonl
{"parentUuid":"u7","isSidechain":false,"type":"assistant","message":{"model":"claude-fable-5","id":"msg_03","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_dn1","name":"Bash","input":{"command":"rm -rf /"}}],"usage":{"input_tokens":10,"output_tokens":5}},"uuid":"u8","timestamp":"2026-07-04T12:00:08.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
{"parentUuid":"u8","isSidechain":false,"type":"user","toolUseResult":"User rejected tool use","message":{"role":"user","content":[{"tool_use_id":"toolu_dn1","type":"tool_result","is_error":true,"content":"The user doesn't want to proceed with this tool use. The tool use was rejected."}]},"uuid":"u9","timestamp":"2026-07-04T12:00:09.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
```

Update EXACTLY these two `test/e2e.test.ts` assertions (msg_03 adds an llm span, toolu_dn1 adds a tool span, the denial adds one event):
```ts
  expect(kinds).toEqual(['agent', 'llm', 'llm', 'llm', 'llm', 'tool', 'tool', 'tool'])
```
```ts
  expect(types).toEqual(['message.assistant', 'message.assistant', 'message.user', 'message.user', 'permission.resolved', 'session.compact', 'session.compact_summary'])
```
Also append one new e2e assertion right after the `types` check (the denied span must be closed as error):
```ts
  const denied = detail.spans.find((s: any) => s.id === 'tool:toolu_dn1')
  expect(denied).toMatchObject({ status: 'error', ended_at: Date.parse('2026-07-04T12:00:09.000Z') })
```

- [ ] **Step 5: Verify**

Run: `bun test` from the repo root (expect 110 pass / 0 fail — 107 + 3 new) and `bunx tsc --noEmit`.
Expected: all green. If any OTHER pre-existing assertion breaks from the fixture ripple, hand-trace before touching it and record the reasoning — only the two named e2e assertions should need updating.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code test/e2e.test.ts && git commit -m "Detect user-denied tools from transcript rejection marker"
```

- [ ] **Step 7: Live rollout verification**

The tailer picks up the new parser on service restart; history back-fills only via fresh import (offset persistence). Verify against a REAL historical denial:
```bash
systemctl --user restart 0rrery && sleep 6
# find one transcript containing the marker (personal data stays local; only counts are reported)
F=$(grep -rl '"toolUseResult":"User rejected tool use"' ~/.claude/projects/*/*.jsonl | head -1)
echo "importing: $(basename $F)"
bun packages/cli/src/index.ts import "$F"
SID=$(basename "$F" .jsonl)
curl -s "localhost:7317/api/sessions/$SID" -o /tmp/deny-check.json
python3 -c "
import json
d = json.load(open('/tmp/deny-check.json'))
denials = [e for e in d['events'] if e['type'] == 'permission.resolved' and 'user' in e['attrs']]
errored = [s for s in d['spans'] if s['status'] == 'error' and 'denied' in s['attrs']]
print(f'permission.resolved(user) events: {len(denials)} | denied-closed spans: {len(errored)}')
"
rm /tmp/deny-check.json
```
Expected: both counts ≥ 1. Report the observed numbers — OBSERVED from the probe output, never inferred; if the probe output looks garbled (RTK compression), write it to a file and Read the file instead of trusting the piped rendering.

---

## Out of scope (per spec)

Interrupted-request tracking, hook-side detection, deny-reason capture, forced re-parse of history.
