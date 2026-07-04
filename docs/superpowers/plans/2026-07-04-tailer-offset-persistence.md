# Tailer Offset Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tailer byte offsets and parse state survive restarts via an atomic JSON snapshot, ending full-history re-ingest (and the Live-feed replay flood) on every `0rrery serve` restart.

**Architecture:** New `packages/claude-code/src/offsets.ts` owns the snapshot format (load/save/revive, version 1, atomic tmp+rename, never throws); `tailer.ts` gains an optional `offsetsPath`, seeds from the snapshot, saves after dirty passes, and resets truncated/rotated files; the CLI's `serve` passes `<dataDir>/tailer-offsets.json`.

**Tech Stack:** Existing: Bun 1.3.x, TypeScript, node:fs sync APIs, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-tailer-offset-persistence-design.md`. Read it first.
- Persistence is an optimization: corrupt/missing/unwritable snapshot degrades to full re-ingest. `loadOffsets`/`saveOffsets` NEVER throw. One `console.error` on corrupt load and on failed save; silence for a missing file.
- Snapshot format exactly `{version: 1, files: {[path]: {offset, state}}}` with `state.agentToolUseIds` serialized as an array. Wrong/missing version → empty map.
- `reviveState` fills fields missing from older snapshots using `newTranscriptState()` defaults.
- `startTailer(projectsDir, url, pollMs = 2000, offsetsPath?: string)` — omitted path preserves today's behavior byte-for-byte; existing tests must pass unchanged.
- Truncation guard: `size < entry.offset` → reset entry to `{offset: 0, state: newTranscriptState()}` and re-ingest that pass.
- Idle passes (no offset advanced) never write the snapshot.
- `bun test` FROM THE REPO ROOT (currently 78 pass) and `bunx tsc --noEmit` green before every commit; paste the actual root-suite tail in reports, never a subset count.
- Commit per task, imperative messages.

---

### Task 1: offsets module

**Files:**
- Create: `packages/claude-code/src/offsets.ts`
- Modify: `packages/claude-code/src/tailer.ts:6` (FileState moves to offsets.ts; tailer imports it), `packages/claude-code/src/index.ts` (export the new module's public surface)
- Test: `packages/claude-code/test/offsets.test.ts`

**Interfaces:**
- Consumes: `TranscriptState`, `newTranscriptState` from `./transcript`.
- Produces (Task 2 relies on these exactly):
```ts
export type FileState = { offset: number; state: TranscriptState }
export function loadOffsets(path: string): Map<string, FileState>
export function saveOffsets(path: string, files: Map<string, FileState>): void
export function reviveState(json: unknown): TranscriptState
```

- [ ] **Step 1: Write the failing test**

`packages/claude-code/test/offsets.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOffsets, saveOffsets, reviveState, type FileState } from '../src/offsets'
import { newTranscriptState } from '../src/transcript'

function tmpPath() { return join(mkdtempSync(join(tmpdir(), '0rrery-off-')), 'tailer-offsets.json') }

test('round-trips offsets and full state including the Set', () => {
  const p = tmpPath()
  const trackedFile = tmpPath()  // any real file path; existence is what load checks
  writeFileSync(trackedFile, 'x')
  const state = newTranscriptState()
  state.sessionStarted = true
  state.agentId = 'a1b2c3d4e5'
  state.agentFirstTs = 42
  state.agentToolUseIds.add('tu1').add('tu2')
  const files = new Map<string, FileState>([[trackedFile, { offset: 123, state }]])
  saveOffsets(p, files)
  const loaded = loadOffsets(p)
  const entry = loaded.get(trackedFile)!
  expect(entry.offset).toBe(123)
  expect(entry.state.sessionStarted).toBe(true)
  expect(entry.state.agentId).toBe('a1b2c3d4e5')
  expect(entry.state.agentFirstTs).toBe(42)
  expect(entry.state.agentToolUseIds).toBeInstanceOf(Set)
  expect([...entry.state.agentToolUseIds].sort()).toEqual(['tu1', 'tu2'])
  expect(existsSync(p + '.tmp')).toBe(false)  // atomic write left no tmp behind
})

test('missing file → empty map, no throw, no log', () => {
  expect(loadOffsets(join(tmpdir(), '0rrery-off-nope', 'none.json')).size).toBe(0)
})

test('corrupt JSON and wrong version → empty map, no throw', () => {
  const p1 = tmpPath()
  writeFileSync(p1, '{ not json')
  expect(loadOffsets(p1).size).toBe(0)
  const p2 = tmpPath()
  writeFileSync(p2, JSON.stringify({ version: 99, files: {} }))
  expect(loadOffsets(p2).size).toBe(0)
})

test('entries for files that no longer exist are pruned at load', () => {
  const p = tmpPath()
  const gone = join(tmpdir(), '0rrery-off-gone', 'deleted.jsonl')
  const files = new Map<string, FileState>([[gone, { offset: 5, state: newTranscriptState() }]])
  saveOffsets(p, files)
  expect(loadOffsets(p).size).toBe(0)
})

test('reviveState fills fields missing from older snapshots', () => {
  const revived = reviveState({ sessionStarted: true })  // v-old snapshot lacking agent fields
  expect(revived.sessionStarted).toBe(true)
  expect(revived.agentStarted).toBe(false)
  expect(revived.agentId).toBeNull()
  expect(revived.agentToolUseIds).toBeInstanceOf(Set)
  expect(revived.agentToolUseIds.size).toBe(0)
  const junk = reviveState('not an object')
  expect(junk.sessionStarted).toBe(false)
})

test('saveOffsets to an unwritable path does not throw', () => {
  const files = new Map<string, FileState>()
  expect(() => saveOffsets('/proc/definitely/not/writable.json', files)).not.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/claude-code/test/offsets.test.ts`
Expected: FAIL — cannot resolve `../src/offsets`.

- [ ] **Step 3: Implement**

`packages/claude-code/src/offsets.ts`:
```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { newTranscriptState, type TranscriptState } from './transcript'

export type FileState = { offset: number; state: TranscriptState }

const VERSION = 1

export function reviveState(json: unknown): TranscriptState {
  const fresh = newTranscriptState()
  if (typeof json !== 'object' || json === null) return fresh
  const j = json as Record<string, unknown>
  return {
    sessionStarted: typeof j.sessionStarted === 'boolean' ? j.sessionStarted : fresh.sessionStarted,
    agentStarted: typeof j.agentStarted === 'boolean' ? j.agentStarted : fresh.agentStarted,
    agentNamed: typeof j.agentNamed === 'boolean' ? j.agentNamed : fresh.agentNamed,
    agentId: typeof j.agentId === 'string' ? j.agentId : fresh.agentId,
    agentFirstTs: typeof j.agentFirstTs === 'number' ? j.agentFirstTs : fresh.agentFirstTs,
    agentToolUseIds: Array.isArray(j.agentToolUseIds) ? new Set(j.agentToolUseIds.filter(x => typeof x === 'string')) : fresh.agentToolUseIds,
  }
}

export function loadOffsets(path: string): Map<string, FileState> {
  const out = new Map<string, FileState>()
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return out }  // missing file: silent
  try {
    const snap = JSON.parse(raw)
    if (snap?.version !== VERSION || typeof snap.files !== 'object' || snap.files === null) return out
    for (const [file, entry] of Object.entries(snap.files as Record<string, any>)) {
      if (!existsSync(file)) continue  // prune dead files
      const offset = typeof entry?.offset === 'number' && entry.offset >= 0 ? entry.offset : 0
      out.set(file, { offset, state: reviveState(entry?.state) })
    }
  } catch (e) {
    console.error('0rrery: tailer offsets snapshot corrupt, starting fresh', e)
    return new Map()
  }
  return out
}

export function saveOffsets(path: string, files: Map<string, FileState>): void {
  try {
    const filesJson: Record<string, unknown> = {}
    for (const [file, { offset, state }] of files) {
      filesJson[file] = { offset, state: { ...state, agentToolUseIds: [...state.agentToolUseIds] } }
    }
    writeFileSync(path + '.tmp', JSON.stringify({ version: VERSION, files: filesJson }))
    renameSync(path + '.tmp', path)
  } catch (e) {
    console.error('0rrery: failed to save tailer offsets', e)
  }
}
```

In `packages/claude-code/src/tailer.ts`, delete the local `type FileState` line and import it instead:
```ts
import { type FileState } from './offsets'
```

Add to `packages/claude-code/src/index.ts`:
```ts
export { loadOffsets, saveOffsets, reviveState, type FileState } from './offsets'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/claude-code/test/offsets.test.ts` then `bun test` from the repo root (expect 84 pass / 0 fail) and `bunx tsc --noEmit`.
Expected: all green; paste the root tail.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code && git commit -m "Add tailer offsets snapshot module"
```

---

### Task 2: tailer wiring + CLI + rollout

**Files:**
- Modify: `packages/claude-code/src/tailer.ts`, `packages/cli/src/index.ts:16`
- Test: `packages/claude-code/test/tailer.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `loadOffsets`/`saveOffsets`/`FileState`.
- Produces: `startTailer(projectsDir, url, pollMs = 2000, offsetsPath?: string)`; CLI `serve` passes `join(config.dataDir, 'tailer-offsets.json')` — note `serve` currently reads `config` from `loadConfig()`, which already exposes `dataDir`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/claude-code/test/tailer.test.ts` (reuse its existing imports; add `rmSync`, `truncateSync`, `appendFileSync` to the fs import as needed):
```ts
function mockIngestCounting() {
  const batches: any[][] = []
  const srv = Bun.serve({ port: 0, async fetch(req) { batches.push(await req.json()); return new Response('{"accepted":1,"rejected":[]}') } })
  return { batches, url: `http://localhost:${srv.port}`, stop: () => srv.stop(true) }
}

const line = (n: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: `msg ${n}` }, uuid: `u${n}`, timestamp: '2026-07-04T12:00:00.000Z', cwd: '/x/proj', sessionId: 'persist1' }) + '\n'

test('offsets persist across tailer restarts: no re-ingest, increments only, truncation resets', async () => {
  const m1 = mockIngestCounting()
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tailp-'))
  const proj = join(projects, '-home-x-proj')
  mkdirSync(proj, { recursive: true })
  const file = join(proj, 'persist1.jsonl')
  writeFileSync(file, line(1))
  const offsetsPath = join(projects, 'tailer-offsets.json')

  // first run ingests, snapshot written
  const t1 = startTailer(projects, m1.url, 100, offsetsPath)
  await Bun.sleep(400)
  t1.stop(); m1.stop()
  expect(m1.batches.flat().some((o: any) => o.type === 'message.user')).toBe(true)

  // second run, unchanged file: ZERO posts
  const m2 = mockIngestCounting()
  const t2 = startTailer(projects, m2.url, 100, offsetsPath)
  await Bun.sleep(400)
  t2.stop(); m2.stop()
  expect(m2.batches).toHaveLength(0)

  // third run after appending one line: only the increment arrives
  appendFileSync(file, line(2))
  const m3 = mockIngestCounting()
  const t3 = startTailer(projects, m3.url, 100, offsetsPath)
  await Bun.sleep(400)
  t3.stop(); m3.stop()
  const previews3 = m3.batches.flat().filter((o: any) => o.type === 'message.user').map((o: any) => o.attrs.preview)
  expect(previews3).toEqual(['msg 2'])

  // fourth run after truncate+rewrite: full re-ingest of new content
  writeFileSync(file, line(9))
  const m4 = mockIngestCounting()
  const t4 = startTailer(projects, m4.url, 100, offsetsPath)
  await Bun.sleep(400)
  t4.stop(); m4.stop()
  const previews4 = m4.batches.flat().filter((o: any) => o.type === 'message.user').map((o: any) => o.attrs.preview)
  expect(previews4).toEqual(['msg 9'])
})

test('omitted offsetsPath stays in-memory: restart re-ingests (existing behavior)', async () => {
  const projects = mkdtempSync(join(tmpdir(), '0rrery-tailm-'))
  const proj = join(projects, '-home-x-proj')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, 'mem1.jsonl'), line(1).replace(/persist1/g, 'mem1'))
  const m1 = mockIngestCounting()
  const t1 = startTailer(projects, m1.url, 100)
  await Bun.sleep(300)
  t1.stop(); m1.stop()
  const m2 = mockIngestCounting()
  const t2 = startTailer(projects, m2.url, 100)
  await Bun.sleep(300)
  t2.stop(); m2.stop()
  expect(m2.batches.length).toBeGreaterThan(0)  // no snapshot → re-ingest, as today
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/claude-code/test/tailer.test.ts`
Expected: FAIL — `startTailer` takes no fourth argument (tsc error) / second run still posts.

- [ ] **Step 3: Implement**

Replace `packages/claude-code/src/tailer.ts` body (full file):
```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importTranscript } from './importer'
import { newTranscriptState } from './transcript'
import { loadOffsets, saveOffsets, type FileState } from './offsets'

export function startTailer(projectsDir: string, url: string, pollMs = 2000, offsetsPath?: string) {
  const files: Map<string, FileState> = offsetsPath ? loadOffsets(offsetsPath) : new Map()
  let stopped = false
  let dirty = false

  async function scanFile(path: string) {
    let fs = files.get(path)
    if (!fs) { fs = { offset: 0, state: newTranscriptState() }; files.set(path, fs) }
    try {
      const size = statSync(path).size
      if (size < fs.offset) {
        // truncated/rotated: start over on this file
        fs.offset = 0
        fs.state = newTranscriptState()
      }
      if (size > fs.offset) {
        const r = await importTranscript(path, url, fs.offset, fs.state)
        if (r.bytesRead !== fs.offset) dirty = true
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
    if (dirty && offsetsPath) {
      saveOffsets(offsetsPath, files)
      dirty = false
    }
  }

  const loop = async () => {
    while (!stopped) { await pass(); await Bun.sleep(pollMs) }
  }
  loop()
  return { stop() { stopped = true } }
}
```

In `packages/cli/src/index.ts`, the serve case (line ~16) becomes:
```ts
    const tailer = startTailer(projectsDir, srv.url, 2000, join(config.dataDir, 'tailer-offsets.json'))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/claude-code/test/tailer.test.ts`, then `bun test` from the repo root (expect 86 pass / 0 fail) and `bunx tsc --noEmit`.
Expected: all green; paste the root tail.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code packages/cli && git commit -m "Persist tailer offsets across restarts"
```

- [ ] **Step 6: Rollout + live verification**

```bash
systemctl --user restart 0rrery && sleep 10
ls -la ~/.0rrery/tailer-offsets.json                     # snapshot exists after first dirty pass
curl -s localhost:7317/api/stats                          # note span/event counts
systemctl --user restart 0rrery && sleep 10
curl -s localhost:7317/api/stats                          # counts stable (no backfill churn)
journalctl --user -u 0rrery --since '-1 min' --no-pager | tail -5
```
Expected: the first restart backfills once more (no snapshot existed) and writes the snapshot; the second restart shows stats immediately stable with no multi-second ingest burst and no offset errors in the journal. Report observed numbers.

---

## Out of scope (per spec)

Offset persistence for `0rrery import`, multi-tailer coordination, snapshot compaction beyond dead-file pruning.
