# Remove Hook Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the never-emitted `'hook'` value from the `SpanKind` enum, with a rejection test making the closure deliberate and visible.

**Architecture:** Two-line removal in `packages/schema/src/index.ts` (type union + zod enum — verified as the only occurrences) plus one pinning test. Nothing else in the codebase references the value.

**Tech Stack:** Existing: TypeScript, zod, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-remove-hook-kind-design.md`. Read it first.
- ONLY the two `'hook'` occurrences in `packages/schema/src/index.ts` (type union line 3, z.enum line 17) may change, plus the new test. Any other diff is scope creep.
- `bun test` FROM THE REPO ROOT (currently 106 pass) + `bunx tsc --noEmit` green before commit; paste the actual root tail.
- Net LOC must be ≤ +8 (the test) −2 (the enum values).

---

### Task 1: remove the enum value

**Files:**
- Modify: `packages/schema/src/index.ts:3,17`
- Test: `packages/schema/test/schema.test.ts` (append)

**Interfaces:**
- Produces: `SpanKind = 'agent' | 'tool' | 'llm' | 'mcp' | 'custom'`; `parseOps` rejects `kind: 'hook'` item-wise.

- [ ] **Step 1: Write the failing test**

Append to `packages/schema/test/schema.test.ts`:
```ts
test('kind hook is rejected — removed 2026-07-05, no emission source exists (see remove-hook-kind spec)', () => {
  const { ok, rejected } = parseOps([
    { op: 'span.start', id: 'h1', sessionId: 's1', parentId: null, kind: 'hook', name: 'x', ts: 1, attrs: {} },
  ])
  expect(ok).toHaveLength(0)
  expect(rejected).toHaveLength(1)
  expect(rejected[0].error).toContain('kind')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/schema/test/schema.test.ts`
Expected: FAIL — `'hook'` is currently a valid enum value, so the op parses OK (`expect(ok).toHaveLength(0)` receives 1). This RED proves the removal is what flips the behavior.

- [ ] **Step 3: Implement the removal**

In `packages/schema/src/index.ts`:
- Line 3: `export type SpanKind = 'agent' | 'tool' | 'llm' | 'mcp' | 'custom'`
- Line 17: `kind: z.enum(['agent', 'tool', 'llm', 'mcp', 'custom']),`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/schema/test/schema.test.ts`, then `bun test` from the repo root (expect 107 pass / 0 fail) and `bunx tsc --noEmit`.
Expected: all green — if ANY other test or the typecheck breaks, something referenced the value after all: STOP and report BLOCKED with the failure (do not widen the change).

- [ ] **Step 5: Commit**

```bash
git add packages/schema && git commit -m "Remove never-emitted hook span kind"
```

- [ ] **Step 6: Rollout verification**

No service restart needed (schema change only affects future ingest validation; the running service picks it up on next restart — verify no historical rows exist so the tightening cannot dead-letter anything real):
```bash
curl -s 'localhost:7317/api/sessions?limit=250' | python3 -c "
import json, sys, urllib.request
total = 0
for s in json.load(sys.stdin):
    d = json.load(urllib.request.urlopen(f'http://localhost:7317/api/sessions/{s[\"id\"]}'))
    total += sum(1 for sp in d['spans'] if sp['kind'] == 'hook')
print('historical hook-kind spans:', total)
"
```
Expected: `historical hook-kind spans: 0`. Report the observed number; a nonzero count is BLOCKED (the spec's no-migration claim would be wrong).

---

## Out of scope (per spec)

Wrapper-based hook observability, dashboard changes, touching parent specs.
