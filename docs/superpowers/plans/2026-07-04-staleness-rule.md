# Active-Status Staleness Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions whose end was never observed stop reading as `active` forever — staleness is derived at read time from `last_event_at`, with zero data mutation.

**Architecture:** `staleAfterMs` joins Config (env `ORRERY_STALE_MS`); `listSessions`/`getStats` take an injectable `{ now, staleAfterMs }` and translate status filters into effective SQL (`stale` = stored-active but old); the server stamps a derived `effectiveStatus` onto session responses; the dashboard renders it (badges, filter option, live-socket gate).

**Tech Stack:** Existing: Bun 1.3.x, TypeScript, bun:sqlite, React/Vite, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-staleness-rule-design.md`. Read it first.
- Semantics exactly: `ended` → `ended`; `active` with `last_event_at >= now - staleAfterMs` → `active`; `active` with `last_event_at < now - staleAfterMs` → `stale`.
- Default `staleAfterMs` = `1_800_000`; env `ORRERY_STALE_MS` accepted only when a non-negative integer; overrides win.
- Stored `status` and `@0rrery/schema` row types unchanged. `effectiveStatus` exists only on API responses and dashboard types.
- Query functions take `opts: { now: number; staleAfterMs: number }` — tests inject `now`, never wall-clock.
- `bun test` FROM THE REPO ROOT (currently 88 pass) + `bunx tsc --noEmit` green before every commit; paste the actual root tail in reports, never a subset count.
- Commit per task, imperative messages.

---

### Task 1: Config + query semantics

**Files:**
- Modify: `packages/server/src/config.ts`, `packages/server/src/queries.ts:4-15,27-35`
- Test: `packages/server/test/config.test.ts` (append), `packages/server/test/queries.test.ts` (append)

**Interfaces:**
- Consumes: existing `Config`/`loadConfig`, `listSessions`, `getStats`.
- Produces (Task 2 relies on these exactly):
```ts
// config.ts
export type Config = { /* existing fields */; staleAfterMs: number }
// default 1_800_000; env ORRERY_STALE_MS only when Number.isInteger(v) && v >= 0; overrides win

// queries.ts
export type QueryOpts = { now: number; staleAfterMs: number }
export type SessionFilter = { project?: string; status?: 'active' | 'ended' | 'stale'; limit?: number; offset?: number }
export function listSessions(db: Database, f: SessionFilter | undefined, opts: QueryOpts): SessionRow[]
export function getStats(db: Database, opts: QueryOpts): { sessions: number; activeSessions: number; staleSessions: number; spans: number; events: number }
// getSessionDetail unchanged
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/config.test.ts`:
```ts
test('staleAfterMs: default, env, garbage, override', () => {
  delete process.env.ORRERY_STALE_MS
  expect(loadConfig().staleAfterMs).toBe(1_800_000)
  process.env.ORRERY_STALE_MS = '60000'
  try {
    expect(loadConfig().staleAfterMs).toBe(60000)
    expect(loadConfig({ staleAfterMs: 5 }).staleAfterMs).toBe(5)
  } finally { delete process.env.ORRERY_STALE_MS }
  process.env.ORRERY_STALE_MS = 'abc'
  try { expect(loadConfig().staleAfterMs).toBe(1_800_000) } finally { delete process.env.ORRERY_STALE_MS }
  process.env.ORRERY_STALE_MS = '-5'
  try { expect(loadConfig().staleAfterMs).toBe(1_800_000) } finally { delete process.env.ORRERY_STALE_MS }
})
```

Append to `packages/server/test/queries.test.ts` (note: existing tests in this file call `listSessions(store.db)` / `listSessions(store.db, {...})` / `getStats(store.db)` — UPDATE every existing call site to pass `OPTS` below as the new last argument; that is part of this task, list each changed line in your report):
```ts
const OPTS = { now: 10_000_000, staleAfterMs: 1_000_000 }

function staleSeeded() {
  const store = new Store(':memory:')
  store.applyOps([
    { op: 'session.start', sessionId: 'fresh', source: 'api', ts: 9_500_000 },              // active, recent
    { op: 'session.start', sessionId: 'old', source: 'api', ts: 1_000 },                     // active, stale
    { op: 'session.start', sessionId: 'done', source: 'api', ts: 9_600_000 },
    { op: 'session.end', sessionId: 'done', ts: 9_700_000 },                                  // ended, recent
  ])
  return store
}

test('status filters use effective semantics', () => {
  const store = staleSeeded()
  expect(listSessions(store.db, { status: 'active' }, OPTS).map(s => s.id)).toEqual(['fresh'])
  expect(listSessions(store.db, { status: 'stale' }, OPTS).map(s => s.id)).toEqual(['old'])
  expect(listSessions(store.db, { status: 'ended' }, OPTS).map(s => s.id)).toEqual(['done'])
  expect(listSessions(store.db, undefined, OPTS)).toHaveLength(3)  // no filter: everything
  store.close()
})

test('cutoff boundary: exactly at cutoff is active', () => {
  const store = new Store(':memory:')
  store.applyOps([{ op: 'session.start', sessionId: 'edge', source: 'api', ts: 9_000_000 }])  // == now - staleAfterMs
  expect(listSessions(store.db, { status: 'active' }, OPTS).map(s => s.id)).toEqual(['edge'])
  expect(listSessions(store.db, { status: 'stale' }, OPTS)).toHaveLength(0)
  store.close()
})

test('getStats splits active and stale', () => {
  const store = staleSeeded()
  expect(getStats(store.db, OPTS)).toEqual({ sessions: 3, activeSessions: 1, staleSessions: 1, spans: 0, events: 0 })
  store.close()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/config.test.ts packages/server/test/queries.test.ts`
Expected: FAIL — `staleAfterMs` undefined; queries reject the third argument / wrong filter results (tsc will also flag arity — that is the RED signal for queries).

- [ ] **Step 3: Implement**

`packages/server/src/config.ts` — add to the `Config` type: `staleAfterMs: number`, and inside `loadConfig` (mirror the port pattern):
```ts
  const envStale = Number(process.env.ORRERY_STALE_MS)
  // in the returned object:
    staleAfterMs: overrides.staleAfterMs ?? (process.env.ORRERY_STALE_MS && Number.isInteger(envStale) && envStale >= 0 ? envStale : 1_800_000),
```

`packages/server/src/queries.ts` — replace `SessionFilter`, `listSessions`, `getStats`:
```ts
export type QueryOpts = { now: number; staleAfterMs: number }
export type SessionFilter = { project?: string; status?: 'active' | 'ended' | 'stale'; limit?: number; offset?: number }

export function listSessions(db: Database, f: SessionFilter = {}, opts: QueryOpts): SessionRow[] {
  const cutoff = opts.now - opts.staleAfterMs
  const where: string[] = []
  const params: (string | number)[] = []
  if (f.project) { where.push('project = ?'); params.push(f.project) }
  if (f.status === 'active') { where.push("status = 'active' AND last_event_at >= ?"); params.push(cutoff) }
  else if (f.status === 'stale') { where.push("status = 'active' AND last_event_at < ?"); params.push(cutoff) }
  else if (f.status === 'ended') { where.push("status = 'ended'") }
  const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY last_event_at DESC LIMIT ? OFFSET ?`
  params.push(f.limit ?? 50, f.offset ?? 0)
  return db.query(sql).all(...params) as SessionRow[]
}

export function getStats(db: Database, opts: QueryOpts) {
  const cutoff = opts.now - opts.staleAfterMs
  const one = (sql: string, ...p: (string | number)[]) => (db.query(sql).get(...p) as { c: number }).c
  return {
    sessions: one('SELECT COUNT(*) c FROM sessions'),
    activeSessions: one("SELECT COUNT(*) c FROM sessions WHERE status = 'active' AND last_event_at >= ?", cutoff),
    staleSessions: one("SELECT COUNT(*) c FROM sessions WHERE status = 'active' AND last_event_at < ?", cutoff),
    spans: one('SELECT COUNT(*) c FROM spans'),
    events: one('SELECT COUNT(*) c FROM events'),
  }
}
```
NOTE: this breaks `server.ts` compilation (call sites lack `opts`). Update the three call sites minimally so the suite compiles — `const qopts = { now: Date.now(), staleAfterMs: config.staleAfterMs }` near the top of the fetch handler, passed to `listSessions(store.db, f, qopts)` and `getStats(store.db, qopts)`. (Task 2 owns `effectiveStatus`; do NOT add it here.) Also update the existing `server.test.ts` stats assertion if it pins the old stats shape (it checks `stats.sessions` only — verify, adjust only if needed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test` from the repo root (expect 92 pass / 0 fail — 88 + 4 new: one config, three queries) and `bunx tsc --noEmit`.
Expected: all green; paste the root tail.

- [ ] **Step 5: Commit**

```bash
git add packages/server && git commit -m "Derive session staleness at query time"
```

---

### Task 2: effectiveStatus stamping + dashboard

**Files:**
- Modify: `packages/server/src/server.ts:57-73`, `packages/dashboard/src/types.ts`, `packages/dashboard/src/views/SessionsView.tsx`, `packages/dashboard/src/views/SessionDetailView.tsx`, `packages/dashboard/src/theme.css` (append)
- Test: `packages/server/test/server.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `QueryOpts`, `'stale'` filter, stats shape.
- Produces: API session objects carry `effectiveStatus: 'active' | 'stale' | 'ended'`; dashboard type `ApiSession = SessionRow & { effectiveStatus: 'active' | 'stale' | 'ended' }`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/server.test.ts`:
```ts
test('sessions carry effectiveStatus; stale filter works end-to-end', async () => {
  const srv = boot()
  const now = Date.now()
  await fetch(`${srv.url}/api/ingest`, { method: 'POST', body: JSON.stringify([
    { op: 'session.start', sessionId: 'live1', source: 'api', ts: now },
    { op: 'session.start', sessionId: 'old1', source: 'api', ts: now - 90 * 86400_000 + 86400_000 },  // old but inside retention
  ]) })
  const all = await (await fetch(`${srv.url}/api/sessions`)).json()
  const byId = Object.fromEntries(all.map((s: any) => [s.id, s.effectiveStatus]))
  expect(byId.live1).toBe('active')
  expect(byId.old1).toBe('stale')
  const stale = await (await fetch(`${srv.url}/api/sessions?status=stale`)).json()
  expect(stale.map((s: any) => s.id)).toEqual(['old1'])
  const detail = await (await fetch(`${srv.url}/api/sessions/old1`)).json()
  expect(detail.session.effectiveStatus).toBe('stale')
  const stats = await (await fetch(`${srv.url}/api/stats`)).json()
  expect(stats.activeSessions).toBe(1)
  expect(stats.staleSessions).toBe(1)
  srv.stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/server.test.ts`
Expected: FAIL — `effectiveStatus` undefined on responses.

- [ ] **Step 3: Implement server stamping**

In `packages/server/src/server.ts`, add one helper near `json` (top of file):
```ts
const effectiveStatus = (s: { status: string; last_event_at: number }, now: number, staleAfterMs: number) =>
  s.status === 'ended' ? 'ended' : s.last_event_at >= now - staleAfterMs ? 'active' : 'stale'
```
And in the routes (using the `qopts` from Task 1 — compute it per-request so `now` is fresh):
```ts
        if (path === '/api/sessions' && req.method === 'GET') {
          const f: SessionFilter = {
            project: url.searchParams.get('project') ?? undefined,
            status: (url.searchParams.get('status') as SessionFilter['status']) ?? undefined,
            limit: numParam(url.searchParams.get('limit')),
            offset: numParam(url.searchParams.get('offset')),
          }
          return json(listSessions(store.db, f, qopts).map(s => ({ ...s, effectiveStatus: effectiveStatus(s, qopts.now, config.staleAfterMs) })))
        }

        const m = path.match(/^\/api\/sessions\/([^/]+)$/)
        if (m && req.method === 'GET') {
          const detail = getSessionDetail(store.db, decodeURIComponent(m[1]))
          return detail
            ? json({ ...detail, session: { ...detail.session, effectiveStatus: effectiveStatus(detail.session, qopts.now, config.staleAfterMs) } })
            : json({ error: 'not found' }, 404)
        }
```
(`qopts` must be computed inside the fetch handler per request: `const qopts = { now: Date.now(), staleAfterMs: config.staleAfterMs }` — if Task 1 placed it outside the handler, move it inside.)

- [ ] **Step 4: Dashboard**

`packages/dashboard/src/types.ts`:
```ts
import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'
export type EffectiveStatus = 'active' | 'stale' | 'ended'
export type ApiSession = SessionRow & { effectiveStatus: EffectiveStatus }
export type SessionDetail = { session: ApiSession; spans: SpanRow[]; events: EventRow[] }
export type { SessionRow, SpanRow, EventRow }
```

`packages/dashboard/src/api.ts`: change `fetchSessions` return type to `Promise<ApiSession[]>` (import from './types' instead of '@0rrery/schema').

`packages/dashboard/src/views/SessionsView.tsx`:
- state type becomes `ApiSession[]` (adjust import).
- badge cell: `<span className={`badge ${s.effectiveStatus}`}>{s.effectiveStatus}</span>`.
- filter dropdown gains `<option value="stale">stale</option>`.

`packages/dashboard/src/views/SessionDetailView.tsx`:
- badge: `<span className={`badge ${session.effectiveStatus}`}>{session.effectiveStatus}</span>`.
- live-socket gate: `if (d.session.effectiveStatus === 'active' && !ws) ws = liveSocket(id, () => load())`.

Append to `packages/dashboard/src/theme.css`:
```css
.badge.stale { background: color-mix(in srgb, var(--run) 12%, transparent); color: color-mix(in srgb, var(--run) 60%, var(--dim)); }
```

- [ ] **Step 5: Verify**

Run: `bun test` from repo root (expect 93 pass / 0 fail), `bunx tsc --noEmit`, `cd packages/dashboard && bun run build && cd ../..`
Expected: all green; paste the root tail.

- [ ] **Step 6: Commit**

```bash
git add packages/server packages/dashboard && git commit -m "Stamp and render effective session status"
```

- [ ] **Step 7: Rollout + live verification**

```bash
systemctl --user restart 0rrery && sleep 8
curl -s localhost:7317/api/stats
curl -s 'localhost:7317/api/sessions?status=active' | python3 -c "import json,sys; d=json.load(sys.stdin); print('effectively active:', [s['id'][:8] for s in d])"
```
Expected: `staleSessions` ≈ 112 (the historical backfill), `activeSessions` = the genuinely live session(s) — this dev session should be the only effectively-active one. Report observed numbers.

---

## Out of scope (per spec)

UI cutoff control, per-source staleness, write-time sweeping/migration, retention interaction.
