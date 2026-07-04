# 0rrery Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild 0rrery as a trace-first, local-first observability platform for AI agent workflows: one Bun process (ingest + SQLite + WS live + dashboard) with deep Claude Code integration.

**Architecture:** Modular monolith. Monorepo workspaces: `@0rrery/schema` (zod wire format + row types), `@0rrery/server` (store, queries, live bus, HTTP/WS), `@0rrery/claude-code` (hook emitter, transcript parser/tailer), `@0rrery/dashboard` (React/Vite), `@0rrery/cli` (`0rrery serve|install|import`). Everything derives from three tables: sessions, spans, events.

**Tech Stack:** Bun 1.3.x, TypeScript, `bun:sqlite` (WAL), zod, React 18 + Vite, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-0rrery-rebuild-design.md`. Read it before starting any task.
- Package scope is `@0rrery/*`. The product name is `0rrery` (zero, not O) everywhere.
- Timestamps are epoch milliseconds (`number`) in the wire format and INTEGER in SQLite.
- Ingest is idempotent: every op carries a client-generated ID; re-applying an op is a no-op or a merge, never a duplicate row.
- Emitters are fail-open: nothing in `@0rrery/claude-code` may ever throw into or block its host process. Hook POST budget ~200ms.
- Invalid ingest items are rejected item-by-item (valid items still land) and appended to a dead-letter JSONL.
- Default port `7317`. Default DB `~/.0rrery/0rrery.db`. Env overrides: `ORRERY_PORT`, `ORRERY_DB`, `ORRERY_URL` (emitter target), `ORRERY_CLAUDE_DIR` (settings location, for tests).
- No dependencies beyond: zod, react, react-dom, vite, @vitejs/plugin-react, typescript. Justify anything else before adding.
- Tests run with `bun test`. Every code task is TDD: failing test first.
- Commit after every task with an imperative message. Author identity must resolve to memmmmike (repo default is already correct).

---

### Task 1: Clean slate + monorepo scaffold

Delete all v2 code and scaffold the workspace. No unit test; the verification is `bun install` succeeding and the tree being clean.

**Files:**
- Delete: `bin/`, `dashboard/`, `demo/`, `hooks/`, `instrumentation/`, `sessions/`, `mcp-emitter.js`, `orrery.config.js`, `playback.html`, `PLAYBACK.md`, `ws-server.js`, `start.sh`, `README.md`, `package.json`
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `README.md`, `packages/{schema,server,claude-code,dashboard,cli}/package.json`

**Interfaces:**
- Produces: workspace layout every later task assumes; base tsconfig all packages extend.

- [ ] **Step 1: Delete v2**

```bash
cd /home/mlayug/Documents/0pon/commercial/0rrery
git rm -r bin dashboard demo hooks instrumentation sessions mcp-emitter.js orrery.config.js playback.html PLAYBACK.md ws-server.js start.sh README.md package.json
```

- [ ] **Step 2: Root files**

`package.json`:
```json
{
  "name": "0rrery",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "bun test",
    "build": "bun run --filter '@0rrery/dashboard' build"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["bun-types"]
  }
}
```

`.gitignore`:
```
node_modules/
packages/dashboard/dist/
*.db
*.db-wal
*.db-shm
.0rrery/
dead-letter.jsonl
```

`README.md`:
```markdown
# 0rrery

Trace-first observability for AI agent workflows. Local-first, one process.

- `bun install`
- `bun run build`
- `bun packages/cli/src/index.ts serve` then open http://localhost:7317

Spec: docs/superpowers/specs/2026-07-04-0rrery-rebuild-design.md
```

- [ ] **Step 3: Package manifests**

`packages/schema/package.json`:
```json
{ "name": "@0rrery/schema", "version": "0.1.0", "module": "src/index.ts", "dependencies": { "zod": "^3.23.0" } }
```

`packages/server/package.json`:
```json
{ "name": "@0rrery/server", "version": "0.1.0", "module": "src/server.ts", "dependencies": { "@0rrery/schema": "workspace:*" } }
```

`packages/claude-code/package.json`:
```json
{ "name": "@0rrery/claude-code", "version": "0.1.0", "module": "src/index.ts", "dependencies": { "@0rrery/schema": "workspace:*" } }
```

`packages/dashboard/package.json`:
```json
{
  "name": "@0rrery/dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": { "react": "^18.3.0", "react-dom": "^18.3.0" },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0", "typescript": "^5.5.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0" }
}
```

`packages/cli/package.json`:
```json
{ "name": "@0rrery/cli", "version": "0.1.0", "bin": { "0rrery": "src/index.ts" }, "dependencies": { "@0rrery/server": "workspace:*", "@0rrery/claude-code": "workspace:*" } }
```

- [ ] **Step 4: Verify**

Run: `bun install && git status --short`
Expected: install succeeds; status shows only deletions and the new files above.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "Clean slate: delete v2, scaffold 0rrery Bun monorepo"
```

---

### Task 2: @0rrery/schema — wire format and row types

**Files:**
- Create: `packages/schema/src/index.ts`
- Test: `packages/schema/test/schema.test.ts`

**Interfaces:**
- Produces (exact, used by every other package):
```ts
export type SpanKind = 'agent' | 'tool' | 'llm' | 'mcp' | 'hook' | 'custom'
export type SessionStartOp = { op: 'session.start'; sessionId: string; source: 'claude-code' | 'api'; project?: string; cwd?: string; gitBranch?: string; ts: number; meta?: Record<string, unknown> }
export type SessionEndOp = { op: 'session.end'; sessionId: string; ts: number }
export type SpanStartOp = { op: 'span.start'; id: string; sessionId: string; parentId?: string | null; kind: SpanKind; name: string; ts: number; attrs?: Record<string, unknown> }
export type SpanEndOp = { op: 'span.end'; id: string; ts: number; status: 'ok' | 'error'; attrs?: Record<string, unknown> }
export type EventOp = { op: 'event'; id: string; sessionId: string; spanId?: string | null; type: string; ts: number; attrs?: Record<string, unknown> }
export type IngestOp = SessionStartOp | SessionEndOp | SpanStartOp | SpanEndOp | EventOp
export const IngestOpSchema: z.ZodType<IngestOp>
export function parseOps(input: unknown): { ok: IngestOp[]; rejected: { index: number; error: string; raw: unknown }[] }
export type SessionRow = { id: string; source: string; project: string | null; cwd: string | null; git_branch: string | null; started_at: number; last_event_at: number; status: 'active' | 'ended'; meta: string }
export type SpanRow = { id: string; session_id: string; parent_id: string | null; kind: SpanKind; name: string; started_at: number; ended_at: number | null; status: 'running' | 'ok' | 'error'; attrs: string }
export type EventRow = { id: string; session_id: string; span_id: string | null; ts: number; type: string; attrs: string }
```

- [ ] **Step 1: Write the failing test**

`packages/schema/test/schema.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { parseOps, IngestOpSchema } from '../src/index'

const good = [
  { op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'p', cwd: '/x', gitBranch: 'main', ts: 1 },
  { op: 'span.start', id: 'sp1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 2, attrs: { cmd: 'ls' } },
  { op: 'span.end', id: 'sp1', ts: 3, status: 'ok' },
  { op: 'event', id: 'e1', sessionId: 's1', type: 'permission.requested', ts: 4, attrs: {} },
  { op: 'session.end', sessionId: 's1', ts: 5 },
]

test('accepts all op kinds and round-trips', () => {
  const { ok, rejected } = parseOps(good)
  expect(rejected).toEqual([])
  expect(ok).toHaveLength(5)
  for (const [i, op] of ok.entries()) expect(IngestOpSchema.parse(good[i])).toEqual(op)
})

test('rejects bad items individually, keeps good ones', () => {
  const { ok, rejected } = parseOps([good[1], { op: 'span.start', id: 'x' }, 42])
  expect(ok).toHaveLength(1)
  expect(rejected).toHaveLength(2)
  expect(rejected[0].index).toBe(1)
  expect(rejected[1].index).toBe(2)
  expect(typeof rejected[0].error).toBe('string')
})

test('rejects non-array input as single rejection', () => {
  const { ok, rejected } = parseOps({ nope: true })
  expect(ok).toEqual([])
  expect(rejected).toHaveLength(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/schema`
Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 3: Implement**

`packages/schema/src/index.ts`:
```ts
import { z } from 'zod'

export type SpanKind = 'agent' | 'tool' | 'llm' | 'mcp' | 'hook' | 'custom'

const attrs = z.record(z.unknown()).optional()
const ts = z.number().int().nonnegative()

const SessionStartSchema = z.object({
  op: z.literal('session.start'), sessionId: z.string().min(1),
  source: z.enum(['claude-code', 'api']), project: z.string().optional(),
  cwd: z.string().optional(), gitBranch: z.string().optional(), ts, meta: attrs,
}).strict()
const SessionEndSchema = z.object({ op: z.literal('session.end'), sessionId: z.string().min(1), ts }).strict()
const SpanStartSchema = z.object({
  op: z.literal('span.start'), id: z.string().min(1), sessionId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  kind: z.enum(['agent', 'tool', 'llm', 'mcp', 'hook', 'custom']),
  name: z.string().min(1), ts, attrs,
}).strict()
const SpanEndSchema = z.object({
  op: z.literal('span.end'), id: z.string().min(1), ts, status: z.enum(['ok', 'error']), attrs,
}).strict()
const EventSchema = z.object({
  op: z.literal('event'), id: z.string().min(1), sessionId: z.string().min(1),
  spanId: z.string().nullable().optional(), type: z.string().min(1), ts, attrs,
}).strict()

export const IngestOpSchema = z.discriminatedUnion('op', [
  SessionStartSchema, SessionEndSchema, SpanStartSchema, SpanEndSchema, EventSchema,
])

export type SessionStartOp = z.infer<typeof SessionStartSchema>
export type SessionEndOp = z.infer<typeof SessionEndSchema>
export type SpanStartOp = z.infer<typeof SpanStartSchema>
export type SpanEndOp = z.infer<typeof SpanEndSchema>
export type EventOp = z.infer<typeof EventSchema>
export type IngestOp = z.infer<typeof IngestOpSchema>

export type Rejected = { index: number; error: string; raw: unknown }

export function parseOps(input: unknown): { ok: IngestOp[]; rejected: Rejected[] } {
  if (!Array.isArray(input)) return { ok: [], rejected: [{ index: 0, error: 'body must be a JSON array', raw: input }] }
  const ok: IngestOp[] = []
  const rejected: Rejected[] = []
  input.forEach((raw, index) => {
    const r = IngestOpSchema.safeParse(raw)
    if (r.success) ok.push(r.data)
    else rejected.push({ index, error: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), raw })
  })
  return { ok, rejected }
}

export type SessionRow = { id: string; source: string; project: string | null; cwd: string | null; git_branch: string | null; started_at: number; last_event_at: number; status: 'active' | 'ended'; meta: string }
export type SpanRow = { id: string; session_id: string; parent_id: string | null; kind: SpanKind; name: string; started_at: number; ended_at: number | null; status: 'running' | 'ok' | 'error'; attrs: string }
export type EventRow = { id: string; session_id: string; span_id: string | null; ts: number; type: string; attrs: string }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/schema`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/schema && git commit -m "Add @0rrery/schema: wire format ops, item-wise validation, row types"
```

---

### Task 3: Server store — SQLite open/migrate + idempotent applyOps

**Files:**
- Create: `packages/server/src/store.ts`
- Test: `packages/server/test/store.test.ts`

**Interfaces:**
- Consumes: `IngestOp`, row types from `@0rrery/schema`.
- Produces:
```ts
export class Store {
  constructor(dbPath: string)        // ':memory:' supported
  db: Database                       // bun:sqlite Database, read by queries.ts
  applyOps(ops: IngestOp[]): void    // single transaction, idempotent
  sweep(retentionDays: number, now?: number): number  // deletes old sessions+children, returns sessions deleted
  close(): void
}
```

- [ ] **Step 1: Write the failing test**

`packages/server/test/store.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { Store } from '../src/store'
import type { IngestOp, SessionRow, SpanRow, EventRow } from '@0rrery/schema'

const ops: IngestOp[] = [
  { op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'p', cwd: '/x', gitBranch: 'main', ts: 100 },
  { op: 'span.start', id: 'sp1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 110, attrs: { cmd: 'ls' } },
  { op: 'span.end', id: 'sp1', ts: 150, status: 'ok', attrs: { exit: 0 } },
  { op: 'event', id: 'e1', sessionId: 's1', spanId: 'sp1', type: 'permission.requested', ts: 120, attrs: {} },
  { op: 'session.end', sessionId: 's1', ts: 200 },
]

function freshApplied() {
  const store = new Store(':memory:')
  store.applyOps(ops)
  return store
}

test('applies ops into three tables', () => {
  const store = freshApplied()
  const s = store.db.query('SELECT * FROM sessions').all() as SessionRow[]
  expect(s).toHaveLength(1)
  expect(s[0]).toMatchObject({ id: 's1', source: 'claude-code', project: 'p', git_branch: 'main', status: 'ended', started_at: 100, last_event_at: 200 })
  const sp = store.db.query('SELECT * FROM spans').all() as SpanRow[]
  expect(sp[0]).toMatchObject({ id: 'sp1', session_id: 's1', kind: 'tool', status: 'ok', started_at: 110, ended_at: 150 })
  expect(JSON.parse(sp[0].attrs)).toEqual({ cmd: 'ls', exit: 0 })  // end attrs merged over start attrs
  const ev = store.db.query('SELECT * FROM events').all() as EventRow[]
  expect(ev[0]).toMatchObject({ id: 'e1', span_id: 'sp1', type: 'permission.requested' })
  store.close()
})

test('re-applying the same ops changes nothing (idempotent)', () => {
  const store = freshApplied()
  store.applyOps(ops)
  expect((store.db.query('SELECT COUNT(*) c FROM spans').get() as any).c).toBe(1)
  expect((store.db.query('SELECT COUNT(*) c FROM events').get() as any).c).toBe(1)
  expect((store.db.query('SELECT COUNT(*) c FROM sessions').get() as any).c).toBe(1)
  store.close()
})

test('span/event for unknown session auto-creates minimal session', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'span.start', id: 'x1', sessionId: 'ghost', kind: 'tool', name: 'Read', ts: 5 }])
  const s = store.db.query("SELECT * FROM sessions WHERE id='ghost'").get() as SessionRow
  expect(s).toMatchObject({ source: 'api', status: 'active', started_at: 5 })
  store.close()
})

test('span.end before span.start creates orphan-tolerant row', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'span.end', id: 'late', ts: 9, status: 'error' }])
  const sp = store.db.query("SELECT * FROM spans WHERE id='late'").get() as SpanRow
  expect(sp).toMatchObject({ status: 'error', ended_at: 9 })
  store.close()
})

test('sweep deletes sessions idle past retention, cascading children', () => {
  const store = freshApplied()
  const deleted = store.sweep(30, 200 + 31 * 86400_000)
  expect(deleted).toBe(1)
  expect((store.db.query('SELECT COUNT(*) c FROM spans').get() as any).c).toBe(0)
  expect((store.db.query('SELECT COUNT(*) c FROM events').get() as any).c).toBe(0)
  store.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/store.test.ts`
Expected: FAIL — cannot resolve `../src/store`.

- [ ] **Step 3: Implement**

`packages/server/src/store.ts`:
```ts
import { Database } from 'bun:sqlite'
import type { IngestOp } from '@0rrery/schema'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, project TEXT, cwd TEXT, git_branch TEXT,
  started_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', meta TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent_id TEXT,
  kind TEXT NOT NULL, name TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running', attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, span_id TEXT,
  ts INTEGER NOT NULL, type TEXT NOT NULL, attrs TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_spans_session ON spans(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_event_at);
`

export class Store {
  db: Database
  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  applyOps(ops: IngestOp[]): void {
    const tx = this.db.transaction((batch: IngestOp[]) => {
      for (const op of batch) this.applyOne(op)
    })
    tx(ops)
  }

  private touchSession(sessionId: string, ts: number) {
    this.db.run(
      `INSERT INTO sessions (id, source, started_at, last_event_at) VALUES (?, 'api', ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_event_at = MAX(last_event_at, excluded.last_event_at)`,
      [sessionId, ts, ts],
    )
  }

  private applyOne(op: IngestOp) {
    switch (op.op) {
      case 'session.start':
        this.db.run(
          `INSERT INTO sessions (id, source, project, cwd, git_branch, started_at, last_event_at, meta)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source = excluded.source, project = COALESCE(excluded.project, project),
             cwd = COALESCE(excluded.cwd, cwd), git_branch = COALESCE(excluded.git_branch, git_branch),
             started_at = MIN(started_at, excluded.started_at),
             last_event_at = MAX(last_event_at, excluded.last_event_at)`,
          [op.sessionId, op.source, op.project ?? null, op.cwd ?? null, op.gitBranch ?? null, op.ts, op.ts, JSON.stringify(op.meta ?? {})],
        )
        break
      case 'session.end':
        this.touchSession(op.sessionId, op.ts)
        this.db.run(`UPDATE sessions SET status = 'ended', last_event_at = MAX(last_event_at, ?) WHERE id = ?`, [op.ts, op.sessionId])
        break
      case 'span.start':
        this.touchSession(op.sessionId, op.ts)
        this.db.run(
          `INSERT OR IGNORE INTO spans (id, session_id, parent_id, kind, name, started_at, attrs)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [op.id, op.sessionId, op.parentId ?? null, op.kind, op.name, op.ts, JSON.stringify(op.attrs ?? {})],
        )
        break
      case 'span.end': {
        const existing = this.db.query('SELECT attrs, session_id FROM spans WHERE id = ?').get(op.id) as { attrs: string; session_id: string } | null
        if (existing) {
          const merged = { ...JSON.parse(existing.attrs), ...(op.attrs ?? {}) }
          this.db.run(`UPDATE spans SET ended_at = ?, status = ?, attrs = ? WHERE id = ?`, [op.ts, op.status, JSON.stringify(merged), op.id])
          this.touchSession(existing.session_id, op.ts)
        } else {
          // end arrived before start: orphan-tolerant placeholder under unknown session
          this.db.run(
            `INSERT OR IGNORE INTO spans (id, session_id, parent_id, kind, name, started_at, ended_at, status, attrs)
             VALUES (?, '', NULL, 'custom', '(unknown)', ?, ?, ?, ?)`,
            [op.id, op.ts, op.ts, op.status, JSON.stringify(op.attrs ?? {})],
          )
        }
        break
      }
      case 'event':
        this.touchSession(op.sessionId, op.ts)
        this.db.run(
          `INSERT OR IGNORE INTO events (id, session_id, span_id, ts, type, attrs) VALUES (?, ?, ?, ?, ?, ?)`,
          [op.id, op.sessionId, op.spanId ?? null, op.ts, op.type, JSON.stringify(op.attrs ?? {})],
        )
        break
    }
  }

  sweep(retentionDays: number, now: number = Date.now()): number {
    const cutoff = now - retentionDays * 86400_000
    const old = this.db.query('SELECT id FROM sessions WHERE last_event_at < ?').all(cutoff) as { id: string }[]
    const tx = this.db.transaction(() => {
      for (const { id } of old) {
        this.db.run('DELETE FROM spans WHERE session_id = ?', [id])
        this.db.run('DELETE FROM events WHERE session_id = ?', [id])
        this.db.run('DELETE FROM sessions WHERE id = ?', [id])
      }
    })
    tx()
    return old.length
  }

  close() { this.db.close() }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/store.test.ts`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Add server store: SQLite schema, idempotent applyOps, retention sweep"
```

---

### Task 4: Server queries

**Files:**
- Create: `packages/server/src/queries.ts`
- Test: `packages/server/test/queries.test.ts`

**Interfaces:**
- Consumes: `Store` from Task 3 (`store.db`), row types from schema.
- Produces:
```ts
export type SessionFilter = { project?: string; status?: 'active' | 'ended'; limit?: number; offset?: number }
export function listSessions(db: Database, f?: SessionFilter): SessionRow[]           // newest last_event_at first
export type SessionDetail = { session: SessionRow; spans: SpanRow[]; events: EventRow[] }
export function getSessionDetail(db: Database, id: string): SessionDetail | null     // spans by started_at, events by ts
export function getStats(db: Database): { sessions: number; activeSessions: number; spans: number; events: number }
```

- [ ] **Step 1: Write the failing test**

`packages/server/test/queries.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { Store } from '../src/store'
import { listSessions, getSessionDetail, getStats } from '../src/queries'

function seeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'a', source: 'claude-code', project: 'p1', ts: 100 },
    { op: 'span.start', id: 'sp1', sessionId: 'a', kind: 'agent', name: 'main', ts: 100 },
    { op: 'span.start', id: 'sp2', sessionId: 'a', parentId: 'sp1', kind: 'tool', name: 'Bash', ts: 110 },
    { op: 'event', id: 'e1', sessionId: 'a', type: 'message.user', ts: 105 },
    { op: 'session.end', sessionId: 'a', ts: 300 },
    { op: 'session.start', sessionId: 'b', source: 'api', project: 'p2', ts: 400 },
  ])
  return store
}

test('listSessions orders by recency and filters', () => {
  const store = seeded()
  const all = listSessions(store.db)
  expect(all.map(s => s.id)).toEqual(['b', 'a'])
  expect(listSessions(store.db, { status: 'active' }).map(s => s.id)).toEqual(['b'])
  expect(listSessions(store.db, { project: 'p1' }).map(s => s.id)).toEqual(['a'])
  expect(listSessions(store.db, { limit: 1, offset: 1 }).map(s => s.id)).toEqual(['a'])
  store.close()
})

test('getSessionDetail returns ordered spans and events, null for missing', () => {
  const store = seeded()
  const d = getSessionDetail(store.db, 'a')!
  expect(d.session.id).toBe('a')
  expect(d.spans.map(s => s.id)).toEqual(['sp1', 'sp2'])
  expect(d.events.map(e => e.id)).toEqual(['e1'])
  expect(getSessionDetail(store.db, 'nope')).toBeNull()
  store.close()
})

test('getStats counts', () => {
  const store = seeded()
  expect(getStats(store.db)).toEqual({ sessions: 2, activeSessions: 1, spans: 2, events: 1 })
  store.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/queries.test.ts`
Expected: FAIL — cannot resolve `../src/queries`.

- [ ] **Step 3: Implement**

`packages/server/src/queries.ts`:
```ts
import type { Database } from 'bun:sqlite'
import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'

export type SessionFilter = { project?: string; status?: 'active' | 'ended'; limit?: number; offset?: number }

export function listSessions(db: Database, f: SessionFilter = {}): SessionRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.project) { where.push('project = ?'); params.push(f.project) }
  if (f.status) { where.push('status = ?'); params.push(f.status) }
  const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY last_event_at DESC LIMIT ? OFFSET ?`
  params.push(f.limit ?? 50, f.offset ?? 0)
  return db.query(sql).all(...params) as SessionRow[]
}

export type SessionDetail = { session: SessionRow; spans: SpanRow[]; events: EventRow[] }

export function getSessionDetail(db: Database, id: string): SessionDetail | null {
  const session = db.query('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | null
  if (!session) return null
  const spans = db.query('SELECT * FROM spans WHERE session_id = ? ORDER BY started_at, id').all(id) as SpanRow[]
  const events = db.query('SELECT * FROM events WHERE session_id = ? ORDER BY ts, id').all(id) as EventRow[]
  return { session, spans, events }
}

export function getStats(db: Database) {
  const one = (sql: string) => (db.query(sql).get() as { c: number }).c
  return {
    sessions: one('SELECT COUNT(*) c FROM sessions'),
    activeSessions: one("SELECT COUNT(*) c FROM sessions WHERE status = 'active'"),
    spans: one('SELECT COUNT(*) c FROM spans'),
    events: one('SELECT COUNT(*) c FROM events'),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/queries.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Add server queries: session list, detail, stats"
```

---

### Task 5: Live bus

**Files:**
- Create: `packages/server/src/livebus.ts`
- Test: `packages/server/test/livebus.test.ts`

**Interfaces:**
- Consumes: `IngestOp` from schema.
- Produces:
```ts
export class LiveBus {
  subscribe(sessionId: string | '*', fn: (ops: IngestOp[]) => void): () => void  // returns unsubscribe
  publish(ops: IngestOp[]): void  // routes each op to its session subscribers + firehose; groups per subscriber
}
```

- [ ] **Step 1: Write the failing test**

`packages/server/test/livebus.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { LiveBus } from '../src/livebus'
import type { IngestOp } from '@0rrery/schema'

const opA: IngestOp = { op: 'event', id: 'e1', sessionId: 'a', type: 't', ts: 1 }
const opB: IngestOp = { op: 'event', id: 'e2', sessionId: 'b', type: 't', ts: 2 }
const opEnd: IngestOp = { op: 'span.end', id: 'sp9', ts: 3, status: 'ok' }  // no sessionId on span.end

test('routes by session, firehose gets everything', () => {
  const bus = new LiveBus()
  const gotA: IngestOp[][] = [], gotAll: IngestOp[][] = []
  bus.subscribe('a', ops => gotA.push(ops))
  bus.subscribe('*', ops => gotAll.push(ops))
  bus.publish([opA, opB, opEnd])
  expect(gotA).toEqual([[opA]])
  expect(gotAll).toEqual([[opA, opB, opEnd]])
})

test('unsubscribe stops delivery; subscriber errors are swallowed', () => {
  const bus = new LiveBus()
  const got: IngestOp[][] = []
  bus.subscribe('*', () => { throw new Error('boom') })
  const un = bus.subscribe('a', ops => got.push(ops))
  un()
  expect(() => bus.publish([opA])).not.toThrow()
  expect(got).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/livebus.test.ts`
Expected: FAIL — cannot resolve `../src/livebus`.

- [ ] **Step 3: Implement**

`packages/server/src/livebus.ts`:
```ts
import type { IngestOp } from '@0rrery/schema'

type Fn = (ops: IngestOp[]) => void

function sessionOf(op: IngestOp): string | null {
  return 'sessionId' in op ? op.sessionId : null  // span.end carries no session id
}

export class LiveBus {
  private subs = new Map<string, Set<Fn>>()

  subscribe(sessionId: string | '*', fn: Fn): () => void {
    if (!this.subs.has(sessionId)) this.subs.set(sessionId, new Set())
    this.subs.get(sessionId)!.add(fn)
    return () => this.subs.get(sessionId)?.delete(fn)
  }

  publish(ops: IngestOp[]): void {
    const bySession = new Map<string, IngestOp[]>()
    for (const op of ops) {
      const sid = sessionOf(op)
      if (sid) (bySession.get(sid) ?? bySession.set(sid, []).get(sid)!).push(op)
    }
    const deliver = (fns: Set<Fn> | undefined, batch: IngestOp[]) => {
      if (!fns || batch.length === 0) return
      for (const fn of fns) { try { fn(batch) } catch {} }
    }
    for (const [sid, batch] of bySession) deliver(this.subs.get(sid), batch)
    deliver(this.subs.get('*'), ops)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/livebus.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Add live bus: per-session and firehose pub/sub"
```

---

### Task 6: Config

**Files:**
- Create: `packages/server/src/config.ts`
- Test: `packages/server/test/config.test.ts`

**Interfaces:**
- Produces:
```ts
export type Config = { port: number; dbPath: string; retentionDays: number; dashboardDist: string | null; authToken: string | null; dataDir: string }
export function loadConfig(overrides?: Partial<Config>): Config
// precedence: overrides > env (ORRERY_PORT, ORRERY_DB) > defaults
// defaults: port 7317, dataDir ~/.0rrery, dbPath <dataDir>/0rrery.db, retentionDays 90,
// dashboardDist resolve(import.meta.dir, '../../dashboard/dist') if it exists else null, authToken null
```

- [ ] **Step 1: Write the failing test**

`packages/server/test/config.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { loadConfig } from '../src/config'

test('defaults', () => {
  delete process.env.ORRERY_PORT; delete process.env.ORRERY_DB
  const c = loadConfig()
  expect(c.port).toBe(7317)
  expect(c.dbPath.endsWith('/.0rrery/0rrery.db')).toBe(true)
  expect(c.retentionDays).toBe(90)
  expect(c.authToken).toBeNull()
})

test('env and overrides win in order', () => {
  process.env.ORRERY_PORT = '9999'
  expect(loadConfig().port).toBe(9999)
  expect(loadConfig({ port: 1234 }).port).toBe(1234)
  delete process.env.ORRERY_PORT
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 3: Implement**

`packages/server/src/config.ts`:
```ts
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type Config = {
  port: number; dbPath: string; retentionDays: number
  dashboardDist: string | null; authToken: string | null; dataDir: string
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? join(homedir(), '.0rrery')
  const dist = resolve(import.meta.dir, '../../dashboard/dist')
  return {
    dataDir,
    port: overrides.port ?? (process.env.ORRERY_PORT ? Number(process.env.ORRERY_PORT) : 7317),
    dbPath: overrides.dbPath ?? process.env.ORRERY_DB ?? join(dataDir, '0rrery.db'),
    retentionDays: overrides.retentionDays ?? 90,
    dashboardDist: overrides.dashboardDist !== undefined ? overrides.dashboardDist : (existsSync(dist) ? dist : null),
    authToken: overrides.authToken ?? process.env.ORRERY_TOKEN ?? null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/config.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Add server config with env overrides"
```

---

### Task 7: HTTP/WS server

**Files:**
- Create: `packages/server/src/server.ts`
- Test: `packages/server/test/server.test.ts`

**Interfaces:**
- Consumes: `Store`, `listSessions`/`getSessionDetail`/`getStats`, `LiveBus`, `Config`, `parseOps`.
- Produces:
```ts
export function startServer(config: Config): { url: string; store: Store; bus: LiveBus; stop(): void }
// Routes:
//   POST /api/ingest            → { accepted: number, rejected: Rejected[] } (207-style always 200)
//   GET  /api/sessions?project=&status=&limit=&offset=
//   GET  /api/sessions/:id      → SessionDetail | 404
//   GET  /api/stats
//   WS   /api/live?session=<id|*>  → server pushes JSON IngestOp[] batches
//   GET  /* → dashboardDist static with index.html fallback (503 JSON if no dist)
// If config.authToken set: POST /api/ingest requires `Authorization: Bearer <token>` else 401.
// Rejected ingest items appended to <dataDir>/dead-letter.jsonl as {ts, error, raw} lines.
```

- [ ] **Step 1: Write the failing test**

`packages/server/test/server.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server'
import { loadConfig } from '../src/config'

function boot(extra: Parameters<typeof loadConfig>[0] = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-'))
  return startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir, ...extra }))
}

const ops = [
  { op: 'session.start', sessionId: 's1', source: 'api', project: 'p', ts: 1 },
  { op: 'span.start', id: 'sp1', sessionId: 's1', kind: 'tool', name: 'Bash', ts: 2 },
]

test('ingest → query round trip, bad items dead-lettered', async () => {
  const srv = boot()
  const res = await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify([...ops, { op: 'nope' }]) })
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body.accepted).toBe(2)
  expect(body.rejected).toHaveLength(1)

  const list = await (await fetch(`${srv.url}/api/sessions`)).json()
  expect(list).toHaveLength(1)
  const detail = await (await fetch(`${srv.url}/api/sessions/s1`)).json()
  expect(detail.spans).toHaveLength(1)
  expect((await fetch(`${srv.url}/api/sessions/nope`)).status).toBe(404)
  const stats = await (await fetch(`${srv.url}/api/stats`)).json()
  expect(stats.sessions).toBe(1)
  srv.stop()
})

test('auth token gates ingest when configured', async () => {
  const srv = boot({ authToken: 'sekrit' })
  expect((await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: '[]' })).status).toBe(401)
  const ok = await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: '[]', headers: { Authorization: 'Bearer sekrit' } })
  expect(ok.status).toBe(200)
  srv.stop()
})

test('websocket live delivers ingested ops', async () => {
  const srv = boot()
  const wsUrl = srv.url.replace('http', 'ws') + '/api/live?session=*'
  const ws = new WebSocket(wsUrl)
  const got: any[] = []
  const gotBatch = new Promise<void>(done => {
    ws.onmessage = e => { got.push(...JSON.parse(e.data as string)); done() }
  })
  await new Promise<void>(r => { ws.onopen = () => r() })
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify(ops) })
  await gotBatch
  expect(got).toHaveLength(2)
  expect(got[0].sessionId).toBe('s1')
  ws.close()
  srv.stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server`.

- [ ] **Step 3: Implement**

`packages/server/src/server.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseOps, type IngestOp, type Rejected } from '@0rrery/schema'
import { Store } from './store'
import { listSessions, getSessionDetail, getStats, type SessionFilter } from './queries'
import { LiveBus } from './livebus'
import type { Config } from './config'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

export function startServer(config: Config) {
  mkdirSync(config.dataDir, { recursive: true })
  const store = new Store(config.dbPath)
  const bus = new LiveBus()
  store.sweep(config.retentionDays)

  const deadLetter = (rejected: Rejected[]) => {
    if (rejected.length === 0) return
    const lines = rejected.map(r => JSON.stringify({ ts: Date.now(), error: r.error, raw: r.raw })).join('\n') + '\n'
    try { appendFileSync(join(config.dataDir, 'dead-letter.jsonl'), lines) } catch {}
  }

  type WsData = { unsub: () => void; session: string }
  const server = Bun.serve({
    port: config.port,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname

      if (path === '/api/live') {
        const session = url.searchParams.get('session') ?? '*'
        if (srv.upgrade(req, { data: { session, unsub: () => {} } })) return undefined as unknown as Response
        return json({ error: 'websocket upgrade failed' }, 400)
      }

      if (path === '/api/ingest' && req.method === 'POST') {
        if (config.authToken && req.headers.get('authorization') !== `Bearer ${config.authToken}`) {
          return json({ error: 'unauthorized' }, 401)
        }
        let body: unknown
        try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
        const { ok, rejected } = parseOps(body)
        deadLetter(rejected)
        if (ok.length > 0) { store.applyOps(ok); bus.publish(ok) }
        return json({ accepted: ok.length, rejected })
      }

      if (path === '/api/sessions' && req.method === 'GET') {
        const f: SessionFilter = {
          project: url.searchParams.get('project') ?? undefined,
          status: (url.searchParams.get('status') as SessionFilter['status']) ?? undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
          offset: url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : undefined,
        }
        return json(listSessions(store.db, f))
      }

      const m = path.match(/^\/api\/sessions\/([^/]+)$/)
      if (m && req.method === 'GET') {
        const detail = getSessionDetail(store.db, decodeURIComponent(m[1]))
        return detail ? json(detail) : json({ error: 'not found' }, 404)
      }

      if (path === '/api/stats' && req.method === 'GET') return json(getStats(store.db))

      if (config.dashboardDist) {
        const filePath = join(config.dashboardDist, path === '/' ? 'index.html' : path)
        const file = Bun.file(filePath)
        if (await file.exists()) return new Response(file)
        return new Response(Bun.file(join(config.dashboardDist, 'index.html')))
      }
      return json({ error: 'dashboard not built; API only' }, 503)
    },
    websocket: {
      open(ws) {
        const data = ws.data as WsData
        data.unsub = bus.subscribe(data.session, (ops: IngestOp[]) => {
          try { ws.send(JSON.stringify(ops)) } catch {}
        })
      },
      close(ws) { (ws.data as WsData).unsub() },
      message() {},
    },
  })

  return {
    url: `http://localhost:${server.port}`,
    store, bus,
    stop() { server.stop(true); store.close() },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server`
Expected: all server tests pass (store, queries, livebus, config, server).

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Add HTTP/WS server: ingest, query API, live websocket, static dashboard"
```

---

### Task 8: Claude Code hook mapping + fail-open emitter

**Files:**
- Create: `packages/claude-code/src/map.ts`, `packages/claude-code/src/emit.ts`, `packages/claude-code/src/hook.ts`, `packages/claude-code/src/index.ts`
- Test: `packages/claude-code/test/map.test.ts`, `packages/claude-code/test/emit.test.ts`

**Interfaces:**
- Consumes: `IngestOp` from schema.
- Produces:
```ts
// map.ts
export type HookInput = { hook_event_name: string; session_id: string; cwd?: string; transcript_path?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown; tool_use_id?: string; message?: string; [k: string]: unknown }
export function mapHookEvent(input: HookInput, now?: number): IngestOp[]  // pure; unknown hook names → []
// emit.ts
export async function emitOps(url: string, ops: IngestOp[], timeoutMs?: number): Promise<boolean>  // never throws; false on any failure
// hook.ts: bun entry — reads stdin JSON, mapHookEvent, emitOps(ORRERY_URL ?? http://localhost:7317), always exit 0
// index.ts re-exports mapHookEvent, emitOps, and Task 9/10 exports
```
- Span ID convention (also used by the transcript parser so hook+transcript data merges): tool spans use `tool:<tool_use_id>`; without a tool_use_id, `tool:<session_id>:<tool_name>:<now>`.

- [ ] **Step 1: Write the failing tests**

`packages/claude-code/test/map.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mapHookEvent } from '../src/map'

test('SessionStart → session.start', () => {
  const ops = mapHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/home/x/proj' }, 500)
  expect(ops).toEqual([{ op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'proj', cwd: '/home/x/proj', ts: 500 }])
})

test('PreToolUse/PostToolUse pair to one span via tool_use_id', () => {
  const pre = mapHookEvent({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' } }, 500)
  expect(pre).toEqual([{ op: 'span.start', id: 'tool:tu1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 500, attrs: { input: { command: 'ls' } } }])
  const post = mapHookEvent({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1', tool_response: { ok: true } }, 600)
  expect(post).toEqual([{ op: 'span.end', id: 'tool:tu1', ts: 600, status: 'ok' }])
})

test('Notification → event; SessionEnd → session.end; unknown → []', () => {
  expect(mapHookEvent({ hook_event_name: 'Notification', session_id: 's1', message: 'needs permission' }, 5)[0])
    .toMatchObject({ op: 'event', type: 'notification', attrs: { message: 'needs permission' } })
  expect(mapHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1' }, 9)).toEqual([{ op: 'session.end', sessionId: 's1', ts: 9 }])
  expect(mapHookEvent({ hook_event_name: 'SomethingNew', session_id: 's1' }, 9)).toEqual([])
})

test('Stop and SubagentStop map to events', () => {
  expect(mapHookEvent({ hook_event_name: 'Stop', session_id: 's1' }, 7)[0]).toMatchObject({ op: 'event', type: 'turn.stop' })
  expect(mapHookEvent({ hook_event_name: 'SubagentStop', session_id: 's1' }, 8)[0]).toMatchObject({ op: 'event', type: 'agent.subagent_stop' })
})
```

`packages/claude-code/test/emit.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { emitOps } from '../src/emit'

test('emits to a live server and returns true', async () => {
  let received: unknown = null
  const srv = Bun.serve({ port: 0, async fetch(req) { received = await req.json(); return new Response('{"accepted":0,"rejected":[]}') } })
  const ok = await emitOps(`http://localhost:${srv.port}`, [{ op: 'session.end', sessionId: 's', ts: 1 }])
  expect(ok).toBe(true)
  expect(received).toEqual([{ op: 'session.end', sessionId: 's', ts: 1 }])
  srv.stop(true)
})

test('returns false, never throws, when server is down or slow', async () => {
  expect(await emitOps('http://localhost:1', [{ op: 'session.end', sessionId: 's', ts: 1 }])).toBe(false)
  const slow = Bun.serve({ port: 0, async fetch() { await Bun.sleep(2000); return new Response('') } })
  expect(await emitOps(`http://localhost:${slow.port}`, [{ op: 'session.end', sessionId: 's', ts: 1 }], 50)).toBe(false)
  slow.stop(true)
})

test('no-op on empty ops', async () => {
  expect(await emitOps('http://localhost:1', [])).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/claude-code`
Expected: FAIL — cannot resolve `../src/map` / `../src/emit`.

- [ ] **Step 3: Implement**

`packages/claude-code/src/map.ts`:
```ts
import type { IngestOp } from '@0rrery/schema'

export type HookInput = {
  hook_event_name: string; session_id: string; cwd?: string; transcript_path?: string
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; tool_use_id?: string
  message?: string; [k: string]: unknown
}

function toolSpanId(input: HookInput, now: number): string {
  return input.tool_use_id ? `tool:${input.tool_use_id}` : `tool:${input.session_id}:${input.tool_name}:${now}`
}

export function mapHookEvent(input: HookInput, now: number = Date.now()): IngestOp[] {
  const sid = input.session_id
  switch (input.hook_event_name) {
    case 'SessionStart':
      return [{ op: 'session.start', sessionId: sid, source: 'claude-code', project: input.cwd?.split('/').pop(), cwd: input.cwd, ts: now }]
    case 'SessionEnd':
      return [{ op: 'session.end', sessionId: sid, ts: now }]
    case 'PreToolUse':
      return [{ op: 'span.start', id: toolSpanId(input, now), sessionId: sid, parentId: null, kind: 'tool', name: input.tool_name ?? '(tool)', ts: now, attrs: { input: input.tool_input ?? null } }]
    case 'PostToolUse': {
      const r = input.tool_response as { is_error?: boolean } | undefined
      return [{ op: 'span.end', id: toolSpanId(input, now), ts: now, status: r?.is_error ? 'error' : 'ok' }]
    }
    case 'Notification':
      return [{ op: 'event', id: `evt:${sid}:notification:${now}`, sessionId: sid, type: 'notification', ts: now, attrs: { message: input.message ?? '' } }]
    case 'Stop':
      return [{ op: 'event', id: `evt:${sid}:stop:${now}`, sessionId: sid, type: 'turn.stop', ts: now, attrs: {} }]
    case 'SubagentStop':
      return [{ op: 'event', id: `evt:${sid}:substop:${now}`, sessionId: sid, type: 'agent.subagent_stop', ts: now, attrs: {} }]
    default:
      return []
  }
}
```

`packages/claude-code/src/emit.ts`:
```ts
import type { IngestOp } from '@0rrery/schema'

export async function emitOps(url: string, ops: IngestOp[], timeoutMs = 200): Promise<boolean> {
  if (ops.length === 0) return true
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ops),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}
```

`packages/claude-code/src/hook.ts`:
```ts
#!/usr/bin/env bun
// Claude Code hook entry. Fail-open: always exits 0, never blocks the host.
import { mapHookEvent, type HookInput } from './map'
import { emitOps } from './emit'

try {
  const raw = await Bun.stdin.text()
  const input = JSON.parse(raw) as HookInput
  await emitOps(process.env.ORRERY_URL ?? 'http://localhost:7317', mapHookEvent(input))
} catch {}
process.exit(0)
```

`packages/claude-code/src/index.ts`:
```ts
export { mapHookEvent, type HookInput } from './map'
export { emitOps } from './emit'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/claude-code`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code && git commit -m "Add Claude Code hook mapping and fail-open emitter"
```

---

### Task 9: Transcript parser + fixture

**Files:**
- Create: `packages/claude-code/src/transcript.ts`, `packages/claude-code/fixtures/session.jsonl`
- Modify: `packages/claude-code/src/index.ts` (add export)
- Test: `packages/claude-code/test/transcript.test.ts`

**Interfaces:**
- Consumes: `IngestOp` from schema.
- Produces:
```ts
export function parseTranscriptLine(line: string, state: TranscriptState): IngestOp[]
export type TranscriptState = { sessionStarted: boolean }   // caller keeps one per file
export function newTranscriptState(): TranscriptState
```
- Mapping rules (real transcript line shapes, verified against `~/.claude/projects/*/*.jsonl` on 2026-07-04):
  - Any line with `sessionId` + `cwd`, first seen → emit `session.start` (source `claude-code`, project = last path segment of `cwd`, gitBranch from `gitBranch`, ts from `timestamp` ISO string → epoch ms). Set `state.sessionStarted`.
  - `type: "assistant"` → one `llm` span, id `llm:<message.id>`, name `<message.model>`, started=ended=ts, status ok, attrs `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }` from `message.usage` (each defaulting 0). Additionally, for each `tool_use` content block → `span.start` id `tool:<block.id>` kind `tool` name `<block.name>` (merges with hook data via idempotent upsert). For each `text` block with non-empty text → `event` `message.assistant`, id `evt:msg:<message.id>:<blockIndex>`, attrs `{ preview: text.slice(0, 200) }`.
  - `type: "user"` where `message.content` is a string → `event` `message.user`, id `evt:msg:<uuid>`, attrs `{ preview: content.slice(0, 200) }`. Array content (tool results) → no event.
  - Lines with `isSidechain: true` → same rules; add `sidechain: true` into attrs of produced spans/events.
  - Unparseable lines and all other types (`attachment`, `system`, `mode`, `ai-title`, ...) → `[]`.

- [ ] **Step 1: Create the fixture**

`packages/claude-code/fixtures/session.jsonl` (hand-crafted, realistic shape, no personal data — write exactly):
```jsonl
{"type":"last-prompt","leafUuid":"u0","sessionId":"fix1"}
{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"list the files"},"uuid":"u1","timestamp":"2026-07-04T12:00:00.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","version":"2.0.0","gitBranch":"main"}
{"parentUuid":"u1","isSidechain":false,"type":"assistant","message":{"model":"claude-fable-5","id":"msg_01","type":"message","role":"assistant","content":[{"type":"text","text":"Listing files now."},{"type":"tool_use","id":"toolu_01","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}},"uuid":"u2","timestamp":"2026-07-04T12:00:01.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
{"parentUuid":"u2","isSidechain":false,"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":"file1\nfile2"}]},"uuid":"u3","timestamp":"2026-07-04T12:00:02.000Z","cwd":"/home/dev/myproj","sessionId":"fix1","gitBranch":"main"}
{"type":"ai-title","title":"Listing files","sessionId":"fix1"}
not json at all
```

- [ ] **Step 2: Write the failing test**

`packages/claude-code/test/transcript.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { parseTranscriptLine, newTranscriptState } from '../src/transcript'

const lines = (await Bun.file(new URL('../fixtures/session.jsonl', import.meta.url)).text()).split('\n').filter(Boolean)

test('fixture parses into expected ops', () => {
  const state = newTranscriptState()
  const ops = lines.flatMap(l => parseTranscriptLine(l, state))

  const start = ops.find(o => o.op === 'session.start') as any
  expect(start).toMatchObject({ sessionId: 'fix1', source: 'claude-code', project: 'myproj', cwd: '/home/dev/myproj', gitBranch: 'main' })
  expect(start.ts).toBe(Date.parse('2026-07-04T12:00:00.000Z'))
  expect(ops.filter(o => o.op === 'session.start')).toHaveLength(1)  // only once per file

  const userEvt = ops.find(o => o.op === 'event' && (o as any).type === 'message.user') as any
  expect(userEvt.attrs.preview).toBe('list the files')

  const llm = ops.find(o => o.op === 'span.start' && (o as any).kind === 'llm') as any
  expect(llm).toMatchObject({ id: 'llm:msg_01', name: 'claude-fable-5' })
  expect(llm.attrs).toMatchObject({ input_tokens: 100, output_tokens: 20 })
  const llmEnd = ops.find(o => o.op === 'span.end' && (o as any).id === 'llm:msg_01')
  expect(llmEnd).toBeDefined()

  const tool = ops.find(o => o.op === 'span.start' && (o as any).kind === 'tool') as any
  expect(tool).toMatchObject({ id: 'tool:toolu_01', name: 'Bash' })

  const asstEvt = ops.find(o => o.op === 'event' && (o as any).type === 'message.assistant') as any
  expect(asstEvt.attrs.preview).toBe('Listing files now.')

  // tool_result user line and ai-title and garbage produce nothing extra
  expect(ops.filter(o => o.op === 'event' && (o as any).type === 'message.user')).toHaveLength(1)
})

test('garbage line yields []', () => {
  expect(parseTranscriptLine('not json', newTranscriptState())).toEqual([])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/claude-code/test/transcript.test.ts`
Expected: FAIL — cannot resolve `../src/transcript`.

- [ ] **Step 4: Implement**

`packages/claude-code/src/transcript.ts`:
```ts
import type { IngestOp } from '@0rrery/schema'

export type TranscriptState = { sessionStarted: boolean }
export function newTranscriptState(): TranscriptState { return { sessionStarted: false } }

type Line = {
  type?: string; sessionId?: string; cwd?: string; gitBranch?: string; timestamp?: string
  uuid?: string; isSidechain?: boolean
  message?: { id?: string; model?: string; role?: string; content?: unknown; usage?: Record<string, number> }
}

export function parseTranscriptLine(raw: string, state: TranscriptState): IngestOp[] {
  let line: Line
  try { line = JSON.parse(raw) } catch { return [] }
  const ops: IngestOp[] = []
  const ts = line.timestamp ? Date.parse(line.timestamp) : Date.now()
  const sid = line.sessionId
  if (!sid) return []

  if (!state.sessionStarted && line.cwd) {
    state.sessionStarted = true
    ops.push({
      op: 'session.start', sessionId: sid, source: 'claude-code',
      project: line.cwd.split('/').pop(), cwd: line.cwd, gitBranch: line.gitBranch, ts,
    })
  }

  const side = line.isSidechain ? { sidechain: true } : {}

  if (line.type === 'user' && typeof line.message?.content === 'string') {
    ops.push({
      op: 'event', id: `evt:msg:${line.uuid}`, sessionId: sid, type: 'message.user', ts,
      attrs: { preview: line.message.content.slice(0, 200), ...side },
    })
  }

  if (line.type === 'assistant' && line.message?.id) {
    const m = line.message
    const u = m.usage ?? {}
    ops.push({
      op: 'span.start', id: `llm:${m.id}`, sessionId: sid, parentId: null, kind: 'llm',
      name: m.model ?? '(model)', ts,
      attrs: {
        input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, ...side,
      },
    })
    ops.push({ op: 'span.end', id: `llm:${m.id}`, ts, status: 'ok' })
    const content = Array.isArray(m.content) ? m.content : []
    content.forEach((block: any, i: number) => {
      if (block?.type === 'tool_use') {
        ops.push({
          op: 'span.start', id: `tool:${block.id}`, sessionId: sid, parentId: `llm:${m.id}`,
          kind: 'tool', name: block.name ?? '(tool)', ts, attrs: { input: block.input ?? null, ...side },
        })
      } else if (block?.type === 'text' && block.text?.trim()) {
        ops.push({
          op: 'event', id: `evt:msg:${m.id}:${i}`, sessionId: sid, type: 'message.assistant', ts,
          attrs: { preview: block.text.slice(0, 200), ...side },
        })
      }
    })
  }

  return ops
}
```

Add to `packages/claude-code/src/index.ts`:
```ts
export { parseTranscriptLine, newTranscriptState, type TranscriptState } from './transcript'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test packages/claude-code`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/claude-code && git commit -m "Add transcript parser with golden fixture"
```

---

### Task 10: Import + tailer

**Files:**
- Create: `packages/claude-code/src/importer.ts`, `packages/claude-code/src/tailer.ts`
- Modify: `packages/claude-code/src/index.ts` (add exports)
- Test: `packages/claude-code/test/importer.test.ts`

**Interfaces:**
- Consumes: `parseTranscriptLine`, `emitOps`.
- Produces:
```ts
// importer.ts — also the tailer's incremental engine
export type ImportResult = { ops: number; emitted: boolean; bytesRead: number }
export async function importTranscript(path: string, url: string, fromByte?: number, state?: TranscriptState): Promise<ImportResult>
// reads file from fromByte (default 0), parses complete lines only (last partial line not consumed), emits in one batch
// tailer.ts
export function startTailer(projectsDir: string, url: string, pollMs?: number): { stop(): void }
// polls projectsDir/**/*.jsonl every pollMs (default 2000), keeps per-file byte offset + TranscriptState, imports increments
```

- [ ] **Step 1: Write the failing test**

`packages/claude-code/test/importer.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importTranscript } from '../src/importer'
import { newTranscriptState } from '../src/transcript'

function mockIngest() {
  const batches: any[][] = []
  const srv = Bun.serve({ port: 0, async fetch(req) { batches.push(await req.json()); return new Response('{"accepted":1,"rejected":[]}') } })
  return { batches, url: `http://localhost:${srv.port}`, stop: () => srv.stop(true) }
}

const line1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: '2026-07-04T12:00:00.000Z', cwd: '/p/x', sessionId: 'imp1', gitBranch: 'main' })
const line2 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'again' }, uuid: 'u2', timestamp: '2026-07-04T12:00:05.000Z', cwd: '/p/x', sessionId: 'imp1', gitBranch: 'main' })

test('imports full file, then only the increment on second call', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')

  const state = newTranscriptState()
  const r1 = await importTranscript(file, url, 0, state)
  expect(r1.emitted).toBe(true)
  expect(r1.ops).toBe(2)  // session.start + message.user
  expect(batches).toHaveLength(1)

  appendFileSync(file, line2 + '\n')
  const r2 = await importTranscript(file, url, r1.bytesRead, state)
  expect(r2.ops).toBe(1)  // only the new message.user
  expect(batches).toHaveLength(2)
  expect(batches[1]).toHaveLength(1)
  stop()
})

test('partial trailing line is not consumed', async () => {
  const { url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n' + line2.slice(0, 20))  // second line incomplete, no newline
  const r = await importTranscript(file, url, 0, newTranscriptState())
  expect(r.ops).toBe(2)
  expect(r.bytesRead).toBe(Buffer.byteLength(line1 + '\n'))
  stop()
})

test('empty increment emits nothing and succeeds', async () => {
  const { batches, url, stop } = mockIngest()
  const dir = mkdtempSync(join(tmpdir(), '0rrery-imp-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, line1 + '\n')
  const r1 = await importTranscript(file, url, 0, newTranscriptState())
  const r2 = await importTranscript(file, url, r1.bytesRead, newTranscriptState())
  expect(r2.ops).toBe(0)
  expect(r2.emitted).toBe(true)
  expect(batches).toHaveLength(1)
  stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/claude-code/test/importer.test.ts`
Expected: FAIL — cannot resolve `../src/importer`.

- [ ] **Step 3: Implement**

`packages/claude-code/src/importer.ts`:
```ts
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { parseTranscriptLine, newTranscriptState, type TranscriptState } from './transcript'
import { emitOps } from './emit'

export type ImportResult = { ops: number; emitted: boolean; bytesRead: number }

export async function importTranscript(
  path: string, url: string, fromByte = 0, state: TranscriptState = newTranscriptState(),
): Promise<ImportResult> {
  const fd = openSync(path, 'r')
  let text!: string
  try {
    const size = fstatSync(fd).size
    if (size <= fromByte) return { ops: 0, emitted: true, bytesRead: fromByte }
    const buf = Buffer.alloc(size - fromByte)
    readSync(fd, buf, 0, buf.length, fromByte)
    text = buf.toString('utf8')
  } finally {
    closeSync(fd)
  }

  // consume only complete lines; leave a trailing partial for the next pass
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { ops: 0, emitted: true, bytesRead: fromByte }
  const complete = text.slice(0, lastNewline)
  const consumedBytes = Buffer.byteLength(text.slice(0, lastNewline + 1))

  const ops = complete.split('\n').filter(Boolean).flatMap(l => parseTranscriptLine(l, state))
  const emitted = await emitOps(url, ops, 5000)
  return { ops: ops.length, emitted, bytesRead: fromByte + consumedBytes }
}
```

`packages/claude-code/src/tailer.ts`:
```ts
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importTranscript } from './importer'
import { newTranscriptState, type TranscriptState } from './transcript'

type FileState = { offset: number; state: TranscriptState }

export function startTailer(projectsDir: string, url: string, pollMs = 2000) {
  const files = new Map<string, FileState>()
  let stopped = false

  async function pass() {
    let dirs: string[] = []
    try { dirs = readdirSync(projectsDir) } catch { return }
    for (const d of dirs) {
      const dir = join(projectsDir, d)
      let entries: string[] = []
      try { entries = readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
      for (const f of entries) {
        const path = join(dir, f)
        let fs = files.get(path)
        if (!fs) { fs = { offset: 0, state: newTranscriptState() }; files.set(path, fs) }
        try {
          if (statSync(path).size > fs.offset) {
            const r = await importTranscript(path, url, fs.offset, fs.state)
            fs.offset = r.bytesRead
          }
        } catch {}
      }
    }
  }

  const loop = async () => {
    while (!stopped) { await pass(); await Bun.sleep(pollMs) }
  }
  loop()
  return { stop() { stopped = true } }
}
```

Add to `packages/claude-code/src/index.ts`:
```ts
export { importTranscript, type ImportResult } from './importer'
export { startTailer } from './tailer'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/claude-code`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code && git commit -m "Add transcript importer with byte offsets and polling tailer"
```

---

### Task 11: CLI — serve / install / import

**Files:**
- Create: `packages/cli/src/index.ts`, `packages/cli/src/install.ts`
- Test: `packages/cli/test/install.test.ts`

**Interfaces:**
- Consumes: `startServer`+`loadConfig` (server), `startTailer`+`importTranscript` (claude-code).
- Produces:
```ts
// install.ts
export function installHooks(claudeDir: string, hookCommand: string): { settingsPath: string; added: string[] }
// merges into <claudeDir>/settings.json: for each of SessionStart, SessionEnd, PreToolUse, PostToolUse,
// Notification, Stop, SubagentStop adds {"hooks":[{"type":"command","command":hookCommand}]} (with
// "matcher":"*" for PreToolUse/PostToolUse) unless an entry with the same command already exists.
// Preserves all unrelated settings. Creates file/dir if missing. Returns which hook names were added.
```
- CLI commands: `0rrery serve` (start server + tailer over `~/.claude/projects`), `0rrery install`, `0rrery import <path>`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/install.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../src/install'

test('creates settings.json with all seven hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  const { settingsPath, added } = installHooks(dir, 'bun /x/hook.ts')
  expect(added).toHaveLength(7)
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(s.hooks.PreToolUse[0]).toEqual({ matcher: '*', hooks: [{ type: 'command', command: 'bun /x/hook.ts' }] })
  expect(s.hooks.SessionStart[0]).toEqual({ hooks: [{ type: 'command', command: 'bun /x/hook.ts' }] })
})

test('is idempotent and preserves unrelated settings', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-hook' }] }] },
  }))
  installHooks(dir, 'bun /x/hook.ts')
  const { added } = installHooks(dir, 'bun /x/hook.ts')  // second run
  expect(added).toHaveLength(0)
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  expect(s.model).toBe('opus')
  expect(s.hooks.PreToolUse).toHaveLength(2)  // other-hook entry + ours, no duplicates
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli`
Expected: FAIL — cannot resolve `../src/install`.

- [ ] **Step 3: Implement**

First give `@0rrery/server` a single import point. Create `packages/server/src/server-exports.ts`:
```ts
export { startServer } from './server'
export { loadConfig, type Config } from './config'
```
and change `"module"` in `packages/server/package.json` to `"src/server-exports.ts"`.

`packages/cli/src/install.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'] as const
const NEEDS_MATCHER = new Set(['PreToolUse', 'PostToolUse'])

export function installHooks(claudeDir: string, hookCommand: string): { settingsPath: string; added: string[] } {
  mkdirSync(claudeDir, { recursive: true })
  const settingsPath = join(claudeDir, 'settings.json')
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
  settings.hooks ??= {}
  const added: string[] = []
  for (const event of HOOK_EVENTS) {
    const entries: any[] = (settings.hooks[event] ??= [])
    const already = entries.some(e => e?.hooks?.some((h: any) => h?.command === hookCommand))
    if (already) continue
    const entry: any = { hooks: [{ type: 'command', command: hookCommand }] }
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*'
    entries.push(entry)
    added.push(event)
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return { settingsPath, added }
}
```

`packages/cli/src/index.ts`:
```ts
#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'
import { startTailer, importTranscript } from '@0rrery/claude-code'
import { installHooks } from './install'

const [cmd, arg] = process.argv.slice(2)
const url = process.env.ORRERY_URL ?? 'http://localhost:7317'

switch (cmd) {
  case 'serve': {
    const config = loadConfig()
    const srv = startServer(config)
    const projectsDir = join(process.env.ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude'), 'projects')
    const tailer = startTailer(projectsDir, srv.url)
    console.log(`0rrery serving on ${srv.url} (db: ${config.dbPath})`)
    console.log(`tailing ${projectsDir}`)
    process.on('SIGINT', () => { tailer.stop(); srv.stop(); process.exit(0) })
    break
  }
  case 'install': {
    const hookPath = resolve(import.meta.dir, '../../claude-code/src/hook.ts')
    const claudeDir = process.env.ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude')
    const { settingsPath, added } = installHooks(claudeDir, `bun ${hookPath}`)
    console.log(added.length ? `installed hooks (${added.join(', ')}) in ${settingsPath}` : `hooks already installed in ${settingsPath}`)
    break
  }
  case 'import': {
    if (!arg) { console.error('usage: 0rrery import <transcript.jsonl>'); process.exit(1) }
    const r = await importTranscript(resolve(arg), url)
    console.log(r.emitted ? `imported ${r.ops} ops from ${arg}` : `parse ok (${r.ops} ops) but server unreachable at ${url}`)
    process.exit(r.emitted ? 0 : 1)
    break
  }
  default:
    console.log('usage: 0rrery <serve|install|import <path>>')
    process.exit(cmd ? 1 : 0)
}
```

- [ ] **Step 4: Run tests + smoke the CLI**

Run: `bun test packages/cli`
Expected: 2 pass.

Run: `ORRERY_DB=':memory:' bun packages/cli/src/index.ts serve & sleep 1 && curl -s localhost:7317/api/stats && kill %1`
Expected: `{"sessions":0,"activeSessions":0,"spans":0,"events":0}` (dashboard not built yet is fine).

- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/server && git commit -m "Add 0rrery CLI: serve, install, import"
```

---

### Task 12: Dashboard scaffold + API client + Sessions view

Dashboard components stay thin; all logic that can be pure (formatting, tree building) lives in testable modules. Component-level rendering is verified by `vite build` + manual smoke, not DOM tests.

**Files:**
- Create: `packages/dashboard/index.html`, `packages/dashboard/vite.config.ts`, `packages/dashboard/src/main.tsx`, `packages/dashboard/src/App.tsx`, `packages/dashboard/src/api.ts`, `packages/dashboard/src/format.ts`, `packages/dashboard/src/theme.css`, `packages/dashboard/src/views/SessionsView.tsx`
- Test: `packages/dashboard/test/format.test.ts`

**Interfaces:**
- Consumes: server query API shapes (`SessionRow`, `SessionDetail` JSON).
- Produces:
```ts
// api.ts
export async function fetchSessions(params?: { project?: string; status?: string }): Promise<SessionRow[]>
export async function fetchSession(id: string): Promise<SessionDetail>
export function liveSocket(session: string, onOps: (ops: unknown[]) => void): WebSocket
// format.ts
export function fmtDuration(ms: number): string      // 950 → '950ms', 65_000 → '1m 5s', 3500 → '3.5s'
export function fmtTime(ts: number): string          // locale time HH:MM:SS
export function fmtTokens(n: number): string         // 1234 → '1.2k', 999 → '999'
// App.tsx: hash routing — '#/' Sessions, '#/session/<id>' detail (Task 13), '#/live' (Task 14)
```

- [ ] **Step 1: Write the failing test**

`packages/dashboard/test/format.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { fmtDuration, fmtTokens } from '../src/format'

test('fmtDuration', () => {
  expect(fmtDuration(950)).toBe('950ms')
  expect(fmtDuration(3500)).toBe('3.5s')
  expect(fmtDuration(65_000)).toBe('1m 5s')
})

test('fmtTokens', () => {
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(1234)).toBe('1.2k')
  expect(fmtTokens(2_500_000)).toBe('2.5M')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard`
Expected: FAIL — cannot resolve `../src/format`.

- [ ] **Step 3: Implement pure modules**

`packages/dashboard/src/format.ts`:
```ts
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false })
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
```

`packages/dashboard/src/api.ts`:
```ts
import type { SessionRow } from '@0rrery/schema'
import type { SessionDetail } from './types'

const base = ''  // same origin; vite dev proxies /api

export async function fetchSessions(params: { project?: string; status?: string } = {}): Promise<SessionRow[]> {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][])
  const res = await fetch(`${base}/api/sessions?${q}`)
  if (!res.ok) throw new Error(`sessions: ${res.status}`)
  return res.json()
}

export async function fetchSession(id: string): Promise<SessionDetail> {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`session ${id}: ${res.status}`)
  return res.json()
}

export function liveSocket(session: string, onOps: (ops: unknown[]) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/live?session=${encodeURIComponent(session)}`)
  ws.onmessage = e => { try { onOps(JSON.parse(e.data)) } catch {} }
  return ws
}
```

`packages/dashboard/src/types.ts`:
```ts
import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'
export type SessionDetail = { session: SessionRow; spans: SpanRow[]; events: EventRow[] }
export type { SessionRow, SpanRow, EventRow }
```
(Add `"@0rrery/schema": "workspace:*"` to dashboard `dependencies` — types only, zod is not bundled because only `import type` is used.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/dashboard`
Expected: 2 pass.

- [ ] **Step 5: App shell + Sessions view**

`packages/dashboard/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>0rrery</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`packages/dashboard/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:7317', ws: true },
    },
  },
})
```

`packages/dashboard/src/main.tsx`:
```tsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './theme.css'

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
```

`packages/dashboard/src/App.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { SessionsView } from './views/SessionsView'

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

export function App() {
  const hash = useHashRoute()
  const sessionMatch = hash.match(/^#\/session\/(.+)$/)

  let view = <SessionsView />
  // Task 13 adds: if (sessionMatch) view = <SessionDetailView id={decodeURIComponent(sessionMatch[1])} />
  // Task 14 adds: if (hash === '#/live') view = <LiveView />

  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">0rrery</span>
        <a href="#/" className={hash === '#/' ? 'active' : ''}>Sessions</a>
        <a href="#/live" className={hash === '#/live' ? 'active' : ''}>Live</a>
      </nav>
      <main>{view}</main>
    </div>
  )
}
```

`packages/dashboard/src/views/SessionsView.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { fetchSessions } from '../api'
import { fmtTime, fmtDuration } from '../format'
import type { SessionRow } from '../types'

export function SessionsView() {
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    fetchSessions(status ? { status } : {}).then(setSessions).catch(e => setError(String(e)))
  }, [status])

  if (error) return <p className="error">{error}</p>
  return (
    <section>
      <header className="viewhead">
        <h1>Sessions</h1>
        <select value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">all</option>
          <option value="active">active</option>
          <option value="ended">ended</option>
        </select>
      </header>
      <table>
        <thead><tr><th>Session</th><th>Project</th><th>Source</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead>
        <tbody>
          {sessions.map(s => (
            <tr key={s.id}>
              <td><a href={`#/session/${encodeURIComponent(s.id)}`}>{s.id.slice(0, 8)}</a></td>
              <td>{s.project ?? '—'}</td>
              <td>{s.source}</td>
              <td><span className={`badge ${s.status}`}>{s.status}</span></td>
              <td>{fmtTime(s.started_at)}</td>
              <td>{fmtDuration(s.last_event_at - s.started_at)}</td>
            </tr>
          ))}
          {sessions.length === 0 && <tr><td colSpan={6} className="empty">No sessions yet. Run `0rrery install`, then use Claude Code.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
```

`packages/dashboard/src/theme.css`:
```css
:root {
  --bg: #0b0e14; --panel: #11151f; --line: #1e2533; --fg: #d8dee9; --dim: #6b7489;
  --accent: #7aa2f7; --ok: #9ece6a; --err: #f7768e; --run: #e0af68;
  font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px;
}
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--fg); }
.app { max-width: 1200px; margin: 0 auto; padding: 0 16px; }
.topnav { display: flex; gap: 16px; align-items: baseline; padding: 14px 0; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; color: var(--accent); letter-spacing: 1px; }
.topnav a { color: var(--dim); text-decoration: none; }
.topnav a.active, .topnav a:hover { color: var(--fg); }
main { padding: 20px 0; }
.viewhead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
h1 { font-size: 16px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--dim); font-weight: 500; }
td a { color: var(--accent); text-decoration: none; }
.badge { padding: 1px 7px; border-radius: 8px; font-size: 11px; }
.badge.active { background: color-mix(in srgb, var(--run) 20%, transparent); color: var(--run); }
.badge.ended { background: color-mix(in srgb, var(--dim) 20%, transparent); color: var(--dim); }
.empty, .error { color: var(--dim); padding: 18px 10px; }
.error { color: var(--err); }
select { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; }
```

- [ ] **Step 6: Verify build**

Run: `cd packages/dashboard && bun install && bun run build && cd ../..`
Expected: `dist/` produced, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard && git commit -m "Add dashboard scaffold, API client, Sessions view"
```

---

### Task 13: Session detail view — trace waterfall

**Files:**
- Create: `packages/dashboard/src/tree.ts`, `packages/dashboard/src/views/SessionDetailView.tsx`
- Modify: `packages/dashboard/src/App.tsx` (route), `packages/dashboard/src/theme.css` (append styles)
- Test: `packages/dashboard/test/tree.test.ts`

**Interfaces:**
- Consumes: `SessionDetail`, `SpanRow` shapes; `fmtDuration`/`fmtTokens`.
- Produces:
```ts
// tree.ts
export type SpanNode = { span: SpanRow; children: SpanNode[]; depth: number }
export function buildSpanTree(spans: SpanRow[]): SpanNode[]  // roots ordered by started_at; unknown parent → root
export function tokenRollup(spans: SpanRow[]): { input: number; output: number }  // sums llm span attrs
```

- [ ] **Step 1: Write the failing test**

`packages/dashboard/test/tree.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { buildSpanTree, tokenRollup } from '../src/tree'
import type { SpanRow } from '../src/types'

const row = (id: string, parent: string | null, kind = 'tool', attrs = '{}'): SpanRow => ({
  id, session_id: 's', parent_id: parent, kind: kind as SpanRow['kind'], name: id,
  started_at: Number(id.replace(/\D/g, '')) || 0, ended_at: null, status: 'ok', attrs,
})

test('builds tree, orphan parents become roots', () => {
  const tree = buildSpanTree([row('a1', null), row('b2', 'a1'), row('c3', 'a1'), row('d4', 'missing')])
  expect(tree.map(n => n.span.id)).toEqual(['a1', 'd4'])
  expect(tree[0].children.map(n => n.span.id)).toEqual(['b2', 'c3'])
  expect(tree[0].children[0].depth).toBe(1)
})

test('tokenRollup sums llm spans only', () => {
  const spans = [
    row('l1', null, 'llm', JSON.stringify({ input_tokens: 100, output_tokens: 10 })),
    row('l2', null, 'llm', JSON.stringify({ input_tokens: 50, output_tokens: 5 })),
    row('t3', null, 'tool', JSON.stringify({ input_tokens: 999 })),
  ]
  expect(tokenRollup(spans)).toEqual({ input: 150, output: 15 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/dashboard/test/tree.test.ts`
Expected: FAIL — cannot resolve `../src/tree`.

- [ ] **Step 3: Implement**

`packages/dashboard/src/tree.ts`:
```ts
import type { SpanRow } from './types'

export type SpanNode = { span: SpanRow; children: SpanNode[]; depth: number }

export function buildSpanTree(spans: SpanRow[]): SpanNode[] {
  const nodes = new Map<string, SpanNode>()
  for (const span of spans) nodes.set(span.id, { span, children: [], depth: 0 })
  const roots: SpanNode[] = []
  for (const node of nodes.values()) {
    const parent = node.span.parent_id ? nodes.get(node.span.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const setDepth = (list: SpanNode[], depth: number) => {
    for (const n of list) { n.depth = depth; setDepth(n.children, depth + 1) }
  }
  setDepth(roots, 0)
  const byStart = (a: SpanNode, b: SpanNode) => a.span.started_at - b.span.started_at
  const sortAll = (list: SpanNode[]) => { list.sort(byStart); list.forEach(n => sortAll(n.children)) }
  sortAll(roots)
  return roots
}

export function tokenRollup(spans: SpanRow[]): { input: number; output: number } {
  let input = 0, output = 0
  for (const s of spans) {
    if (s.kind !== 'llm') continue
    try {
      const a = JSON.parse(s.attrs)
      input += a.input_tokens ?? 0
      output += a.output_tokens ?? 0
    } catch {}
  }
  return { input, output }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/dashboard`
Expected: all pass.

- [ ] **Step 5: The view**

`packages/dashboard/src/views/SessionDetailView.tsx`:
```tsx
import { useEffect, useMemo, useState } from 'react'
import { fetchSession, liveSocket } from '../api'
import { buildSpanTree, tokenRollup, type SpanNode } from '../tree'
import { fmtDuration, fmtTime, fmtTokens } from '../format'
import type { SessionDetail, EventRow } from '../types'

function WaterfallRow({ node, t0, total }: { node: SpanNode; t0: number; total: number }) {
  const [open, setOpen] = useState(false)
  const s = node.span
  const end = s.ended_at ?? t0 + total
  const left = total ? ((s.started_at - t0) / total) * 100 : 0
  const width = total ? Math.max(0.5, ((end - s.started_at) / total) * 100) : 100
  return (
    <>
      <div className="wf-row" onClick={() => setOpen(!open)}>
        <span className="wf-name" style={{ paddingLeft: node.depth * 16 }}>
          <span className={`kind kind-${s.kind}`}>{s.kind}</span> {s.name}
        </span>
        <span className="wf-track">
          <span className={`wf-bar st-${s.status}`} style={{ left: `${left}%`, width: `${width}%` }} />
        </span>
        <span className="wf-dur">{s.ended_at ? fmtDuration(s.ended_at - s.started_at) : 'running'}</span>
      </div>
      {open && <pre className="attrs">{JSON.stringify(JSON.parse(s.attrs), null, 2)}</pre>}
      {node.children.map(c => <WaterfallRow key={c.span.id} node={c} t0={t0} total={total} />)}
    </>
  )
}

export function SessionDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'trace' | 'events'>('trace')

  useEffect(() => {
    let ws: WebSocket | null = null
    const load = () => fetchSession(id).then(d => {
      setDetail(d)
      if (d.session.status === 'active' && !ws) ws = liveSocket(id, () => load())
    }).catch(e => setError(String(e)))
    load()
    return () => ws?.close()
  }, [id])

  const tree = useMemo(() => detail ? buildSpanTree(detail.spans) : [], [detail])
  if (error) return <p className="error">{error}</p>
  if (!detail) return <p className="empty">loading…</p>

  const { session, spans, events } = detail
  const t0 = session.started_at
  const total = Math.max(1, session.last_event_at - t0)
  const tokens = tokenRollup(spans)

  return (
    <section>
      <header className="viewhead">
        <h1><a href="#/">Sessions</a> / {session.id.slice(0, 8)}</h1>
        <div className="rollup">
          <span className={`badge ${session.status}`}>{session.status}</span>
          <span>{session.project ?? ''}</span>
          <span>{fmtDuration(total)}</span>
          <span>{fmtTokens(tokens.input)} in / {fmtTokens(tokens.output)} out</span>
        </div>
      </header>
      <div className="tabs">
        <button className={tab === 'trace' ? 'active' : ''} onClick={() => setTab('trace')}>Trace ({spans.length})</button>
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events ({events.length})</button>
      </div>
      {tab === 'trace' && (
        <div className="waterfall">
          {tree.map(n => <WaterfallRow key={n.span.id} node={n} t0={t0} total={total} />)}
          {tree.length === 0 && <p className="empty">No spans recorded.</p>}
        </div>
      )}
      {tab === 'events' && (
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Detail</th></tr></thead>
          <tbody>
            {events.map((e: EventRow) => (
              <tr key={e.id}>
                <td>{fmtTime(e.ts)}</td>
                <td>{e.type}</td>
                <td className="attrs-cell">{(() => { try { return JSON.parse(e.attrs).preview ?? JSON.parse(e.attrs).message ?? '' } catch { return '' } })()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
```

In `App.tsx`, add the import and replace the view selection:
```tsx
import { SessionDetailView } from './views/SessionDetailView'
// inside App():
let view = <SessionsView />
if (sessionMatch) view = <SessionDetailView id={decodeURIComponent(sessionMatch[1])} />
```

Append to `theme.css`:
```css
.tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.tabs button { background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 4px 12px; cursor: pointer; }
.tabs button.active { color: var(--fg); border-color: var(--accent); }
.waterfall { border: 1px solid var(--line); border-radius: 6px; }
.wf-row { display: grid; grid-template-columns: 320px 1fr 90px; align-items: center; gap: 10px; padding: 5px 10px; border-bottom: 1px solid var(--line); cursor: pointer; }
.wf-row:hover { background: var(--panel); }
.wf-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind { font-size: 10px; padding: 0 5px; border-radius: 3px; margin-right: 4px; background: var(--line); color: var(--dim); }
.kind-llm { color: var(--accent); } .kind-agent { color: var(--ok); } .kind-tool { color: var(--run); }
.wf-track { position: relative; height: 14px; background: var(--panel); border-radius: 3px; overflow: hidden; }
.wf-bar { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; background: var(--accent); min-width: 2px; }
.wf-bar.st-error { background: var(--err); }
.wf-bar.st-running { background: var(--run); }
.wf-dur { text-align: right; color: var(--dim); }
.attrs { background: var(--panel); padding: 10px 14px; font-size: 11px; overflow-x: auto; border-bottom: 1px solid var(--line); }
.attrs-cell { color: var(--dim); max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rollup { display: flex; gap: 14px; color: var(--dim); align-items: baseline; }
h1 a { color: var(--dim); text-decoration: none; }
```

- [ ] **Step 6: Verify build**

Run: `cd packages/dashboard && bun run build && cd ../..`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard && git commit -m "Add session detail view: trace waterfall, events tab, token rollup"
```

---

### Task 14: Live view

**Files:**
- Create: `packages/dashboard/src/views/LiveView.tsx`
- Modify: `packages/dashboard/src/App.tsx` (route), `packages/dashboard/src/theme.css` (append)

**Interfaces:**
- Consumes: `fetchSessions`, `liveSocket` (firehose `*`), `fmtTime`.

- [ ] **Step 1: Implement**

`packages/dashboard/src/views/LiveView.tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { fetchSessions, liveSocket } from '../api'
import { fmtTime } from '../format'
import type { SessionRow } from '../types'

type FeedItem = { key: string; ts: number; sessionId: string; label: string }

function opToFeedItem(op: any, i: number): FeedItem | null {
  const base = { key: `${op.id ?? op.sessionId}:${i}:${op.ts}`, ts: op.ts, sessionId: op.sessionId ?? '' }
  switch (op.op) {
    case 'session.start': return { ...base, label: `session started (${op.project ?? op.sessionId})` }
    case 'session.end': return { ...base, label: 'session ended' }
    case 'span.start': return { ...base, label: `▶ ${op.kind}: ${op.name}` }
    case 'span.end': return { ...base, sessionId: '', label: `■ span ${op.status}` }
    case 'event': return { ...base, label: op.type }
    default: return null
  }
}

export function LiveView() {
  const [active, setActive] = useState<SessionRow[]>([])
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const refresh = () => fetchSessions({ status: 'active' }).then(setActive).catch(() => {})
    refresh()
    const ws = liveSocket('*', ops => {
      if (pausedRef.current) return
      const items = ops.map(opToFeedItem).filter(Boolean) as FeedItem[]
      setFeed(prev => [...items.reverse(), ...prev].slice(0, 500))
      if (ops.some((o: any) => o.op === 'session.start' || o.op === 'session.end')) refresh()
    })
    return () => ws.close()
  }, [])

  return (
    <section>
      <header className="viewhead">
        <h1>Live</h1>
        <button className="pause" onClick={() => setPaused(!paused)}>{paused ? 'resume' : 'pause'}</button>
      </header>
      <h2 className="subhead">Active sessions ({active.length})</h2>
      <div className="chips">
        {active.map(s => <a key={s.id} className="chip" href={`#/session/${encodeURIComponent(s.id)}`}>{s.project ?? s.id.slice(0, 8)}</a>)}
        {active.length === 0 && <span className="empty">none</span>}
      </div>
      <h2 className="subhead">Feed</h2>
      <div className="feed">
        {feed.map(f => (
          <div key={f.key} className="feed-row">
            <span className="feed-ts">{fmtTime(f.ts)}</span>
            <span className="feed-sid">{f.sessionId.slice(0, 8)}</span>
            <span>{f.label}</span>
          </div>
        ))}
        {feed.length === 0 && <p className="empty">Waiting for events…</p>}
      </div>
    </section>
  )
}
```

In `App.tsx`, add the import and the route:
```tsx
import { LiveView } from './views/LiveView'
// inside App():
if (hash === '#/live') view = <LiveView />
```

Append to `theme.css`:
```css
.subhead { font-size: 12px; color: var(--dim); margin: 14px 0 8px; text-transform: uppercase; letter-spacing: 1px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; }
.chip { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 3px 12px; color: var(--accent); text-decoration: none; }
.feed { border: 1px solid var(--line); border-radius: 6px; max-height: 60vh; overflow-y: auto; }
.feed-row { display: grid; grid-template-columns: 80px 90px 1fr; gap: 10px; padding: 4px 10px; border-bottom: 1px solid var(--line); }
.feed-ts, .feed-sid { color: var(--dim); }
.pause { background: var(--panel); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 3px 10px; cursor: pointer; }
```

- [ ] **Step 2: Verify build**

Run: `cd packages/dashboard && bun run build && cd ../..`
Expected: builds clean.

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard && git commit -m "Add live view: active sessions and real-time feed"
```

---

### Task 15: End-to-end smoke + handoff

**Files:**
- Create: `test/e2e.test.ts` (repo root)
- Modify: `README.md` (usage section already written in Task 1 — verify it is accurate, fix if not)

**Interfaces:**
- Consumes: everything.

- [ ] **Step 1: Write the e2e test**

`test/e2e.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'
import { importTranscript } from '@0rrery/claude-code'

test('fixture transcript → import → query shows full trace', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))

  const fixture = new URL('../packages/claude-code/fixtures/session.jsonl', import.meta.url).pathname
  const r = await importTranscript(fixture, srv.url)
  expect(r.emitted).toBe(true)
  expect(r.ops).toBeGreaterThan(0)

  const sessions = await (await fetch(`${srv.url}/api/sessions`)).json()
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ id: 'fix1', project: 'myproj', source: 'claude-code' })

  const detail = await (await fetch(`${srv.url}/api/sessions/fix1`)).json()
  const kinds = detail.spans.map((s: any) => s.kind).sort()
  expect(kinds).toEqual(['llm', 'tool'])
  expect(detail.events.map((e: any) => e.type).sort()).toEqual(['message.assistant', 'message.user'])
  srv.stop()
})
```

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: all tests across all packages pass.

- [ ] **Step 3: Manual smoke (live path)**

```bash
bun run build
bun packages/cli/src/index.ts serve &
sleep 1
curl -s -X POST localhost:7317/api/ingest -d '[{"op":"session.start","sessionId":"smoke","source":"api","project":"smoke-test","ts":'"$(date +%s%3N)"'}]'
curl -s localhost:7317/api/sessions | head -c 200
kill %1
```
Expected: ingest returns `{"accepted":1,...}`; sessions list contains `smoke`; opening http://localhost:7317 during the run shows the dashboard.

- [ ] **Step 4: Commit + handoff**

```bash
git add -A && git commit -m "Add end-to-end smoke test"
```

Write the handoff paragraph (what changed, what is verified, what is next, what is risky) as the final report. Known follow-ups deliberately out of scope: topology view, OTel export, hosted mode, `bun build --compile` binary, cost (USD) computation, Notification→permission.requested refinement (needs real hook payload samples).
