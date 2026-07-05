# Fleet View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Live tab becomes an ops board: one card per live session with current activity, pending permissions, idle/stuck signals, and cost — feed demoted below.

**Architecture:** `fleetView(db, opts)` in the insights layer (read-only, per-session subqueries over ~10 concurrent sessions), served at `GET /api/fleet`, consumed by a reorganized LiveView with WS-triggered throttled refetch + client-side ticking timers. One row added to the agent skill's cheat sheet.

**Tech Stack:** Existing: TypeScript, bun:sqlite, React, `bun test`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-fleet-view-design.md`. Read it first.
- Read-only; no schema/ingest changes. Thresholds are named constants: `STUCK_PERMISSION_MS = 120_000`, `STUCK_TOOL_MS = 600_000`.
- Pending-permission matching: `permission.requested` events whose `span_id` has NO `permission.resolved` event. Tool name from the joined span's name (fallback `'?'`).
- `current` = newest OPEN span of kind tool/mcp/agent (llm ignored); `stuck` from tool/mcp only.
- `est_cost` null-honest (per-model estCost, unknown excluded).
- Sort: sessions with pending permissions first, then `last_event_at` desc. Ended sessions excluded.
- Server exports via `packages/server/src/server-exports.ts`. Skill body stays ≤ ~100 lines.
- `bun test` FROM THE REPO ROOT + `bunx tsc --noEmit` green before every commit; paste actual tails. Root currently 147.

---

### Task 1: fleetView + endpoint + skill row

**Files:**
- Modify: `packages/server/src/insights.ts` (append), `packages/server/src/server-exports.ts`, `packages/server/src/server.ts` (route), `packages/cli/skill/SKILL.md` (one table row)
- Test: `packages/server/test/insights.test.ts` (append), `test/e2e.test.ts` (append)

**Interfaces:**
- Consumes: `estCost` (already imported in insights.ts); D1 constant in insights.test.ts.
- Produces (Task 2 renders this): `fleetView(db, opts: { now: number; staleAfterMs: number }): FleetCard[]` with
```ts
export type FleetCard = {
  id: string; project: string | null
  started_at: number; last_event_at: number; idle_ms: number
  effective: 'active' | 'stale'
  current: { kind: string; name: string; running_ms: number } | null
  pending_permissions: Array<{ tool: string; waiting_ms: number }>
  tokens_in: number; tokens_out: number; est_cost: number | null
  stuck: boolean
}
```
and `GET /api/fleet` returning `FleetCard[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/test/insights.test.ts`:
```ts
import { fleetView } from '../src/insights'

const NOW = D1 + 1_000_000
function fleetSeeded(mut: any[] = []) {
  const store = new Store(':memory:')
  store.applyOps([
    // fA: active, open tool span 30s, unresolved permission 30s
    { op: 'session.start', sessionId: 'fA', source: 'claude-code', project: 'alpha', ts: NOW - 60_000 },
    { op: 'span.start', id: 'tool:fa1', sessionId: 'fA', parentId: null, kind: 'tool', name: 'Bash', ts: NOW - 30_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:fa1', sessionId: 'fA', spanId: 'tool:fa1', type: 'permission.requested', ts: NOW - 30_000, attrs: {} },
    // fB: active, permission resolved, span closed, llm tokens, more recent than fA
    { op: 'session.start', sessionId: 'fB', source: 'claude-code', project: 'beta', ts: NOW - 50_000 },
    { op: 'span.start', id: 'tool:fb1', sessionId: 'fB', parentId: null, kind: 'tool', name: 'Read', ts: NOW - 40_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:fb1', sessionId: 'fB', spanId: 'tool:fb1', type: 'permission.requested', ts: NOW - 40_000, attrs: {} },
    { op: 'event', id: 'evt:perm:res:fb1', sessionId: 'fB', spanId: 'tool:fb1', type: 'permission.resolved', ts: NOW - 39_000, attrs: { outcome: 'allowed' } },
    { op: 'span.end', id: 'tool:fb1', ts: NOW - 38_000, status: 'ok' },
    { op: 'span.start', id: 'llm:fb2', sessionId: 'fB', parentId: null, kind: 'llm', name: 'claude-sonnet-5', ts: NOW - 20_000, attrs: { input_tokens: 100, output_tokens: 200 } },
    { op: 'span.end', id: 'llm:fb2', ts: NOW - 19_000, status: 'ok' },
    // fC: ended — excluded
    { op: 'session.start', sessionId: 'fC', source: 'claude-code', project: 'gamma', ts: NOW - 100_000 },
    { op: 'session.end', sessionId: 'fC', ts: NOW - 90_000 },
    ...mut,
  ])
  return store
}
const FOPTS = { now: NOW, staleAfterMs: 300_000 }

test('fleetView: pending permission included, resolved excluded, sorted first', () => {
  const cards = fleetView(fleetSeeded().db, FOPTS)
  expect(cards.map(c => c.id)).toEqual(['fA', 'fB'])  // fA has pending perms despite fB being fresher; fC ended
  expect(cards[0].pending_permissions).toEqual([{ tool: 'Bash', waiting_ms: 30_000 }])
  expect(cards[1].pending_permissions).toEqual([])
})

test('fleetView: current is newest open tool span, null when none open', () => {
  const cards = fleetView(fleetSeeded().db, FOPTS)
  expect(cards[0].current).toEqual({ kind: 'tool', name: 'Bash', running_ms: 30_000 })
  expect(cards[1].current).toBeNull()
})

test('fleetView: tokens and null-honest cost', () => {
  const fb = fleetView(fleetSeeded().db, FOPTS).find(c => c.id === 'fB')!
  expect(fb).toMatchObject({ tokens_in: 100, tokens_out: 200 })
  expect(fb.est_cost).toBeCloseTo(100 / 1e6 * 3 + 200 / 1e6 * 15)
  expect(fb.idle_ms).toBe(19_000)
})

test('fleetView: stuck on old pending permission and old open tool', () => {
  const oldPerm = fleetSeeded([
    { op: 'session.start', sessionId: 'fD', source: 'claude-code', project: 'delta', ts: NOW - 400_000 },
    { op: 'span.start', id: 'tool:fd1', sessionId: 'fD', parentId: null, kind: 'tool', name: 'Write', ts: NOW - 130_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:fd1', sessionId: 'fD', spanId: 'tool:fd1', type: 'permission.requested', ts: NOW - 130_000, attrs: {} },
  ])
  expect(fleetView(oldPerm.db, FOPTS).find(c => c.id === 'fD')!.stuck).toBe(true)
  const oldTool = fleetSeeded([
    { op: 'session.start', sessionId: 'fE', source: 'claude-code', project: 'eps', ts: NOW - 800_000 },
    { op: 'span.start', id: 'mcp:fe1', sessionId: 'fE', parentId: null, kind: 'mcp', name: 'mcp__x__y', ts: NOW - 700_000, attrs: {} },
  ])
  expect(fleetView(oldTool.db, FOPTS).find(c => c.id === 'fE')!.stuck).toBe(true)
  expect(fleetView(fleetSeeded().db, FOPTS).every(c => !c.stuck)).toBe(true)  // 30s pending isn't stuck
})

test('fleetView: effective stale past the cutoff', () => {
  const cards = fleetView(fleetSeeded().db, { now: NOW, staleAfterMs: 10_000 })
  expect(cards.find(c => c.id === 'fA')!.effective).toBe('stale')   // last event 30s ago > 10s cutoff
  expect(cards.find(c => c.id === 'fB')!.effective).toBe('active')  // wait: fB last event 19s ago > 10s too
})
```
STOP on that last test: fB's last event is 19s before NOW, also past a 10s cutoff — both are stale. Assert instead:
```ts
  expect(cards.every(c => c.effective === 'stale')).toBe(true)
  const fresh = fleetView(fleetSeeded().db, { now: NOW, staleAfterMs: 25_000 })
  expect(fresh.find(c => c.id === 'fB')!.effective).toBe('active')
  expect(fresh.find(c => c.id === 'fA')!.effective).toBe('stale')
```
(Use this corrected version verbatim; the plan surfaces the trap deliberately.)

Append to `test/e2e.test.ts`:
```ts
test('fleet endpoint reports a live session with pending permission', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), '0rrery-e2e-fleet-'))
  const srv = startServer(loadConfig({ port: 0, dbPath: ':memory:', dashboardDist: null, dataDir }))
  const now = Date.now()
  const post = (ops: any[]) => fetch(`${srv.url}/api/ingest`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }),
  })
  await post([
    { op: 'session.start', sessionId: 'live1', source: 'api', project: 'demo', ts: now - 10_000 },
    { op: 'span.start', id: 'tool:lv1', sessionId: 'live1', parentId: null, kind: 'tool', name: 'Bash', ts: now - 5_000, attrs: {} },
    { op: 'event', id: 'evt:perm:req:lv1', sessionId: 'live1', spanId: 'tool:lv1', type: 'permission.requested', ts: now - 5_000, attrs: {} },
  ])
  const fleet = await fetch(`${srv.url}/api/fleet`).then(r => r.json()) as any[]
  const card = fleet.find(c => c.id === 'live1')!
  expect(card.project).toBe('demo')
  expect(card.current.name).toBe('Bash')
  expect(card.pending_permissions).toHaveLength(1)
  expect(card.pending_permissions[0].tool).toBe('Bash')
  expect(card.stuck).toBe(false)
  srv.stop()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/server/test/insights.test.ts test/e2e.test.ts`
Expected: FAIL — `fleetView` not exported; e2e `/api/fleet` 404s.

- [ ] **Step 3: Implement**

Append to `packages/server/src/insights.ts`:
```ts
const STUCK_PERMISSION_MS = 120_000
const STUCK_TOOL_MS = 600_000

export type FleetCard = {
  id: string; project: string | null
  started_at: number; last_event_at: number; idle_ms: number
  effective: 'active' | 'stale'
  current: { kind: string; name: string; running_ms: number } | null
  pending_permissions: Array<{ tool: string; waiting_ms: number }>
  tokens_in: number; tokens_out: number; est_cost: number | null
  stuck: boolean
}

export function fleetView(db: Database, opts: { now: number; staleAfterMs: number }): FleetCard[] {
  const sessions = db.query(`SELECT * FROM sessions WHERE status = 'active' ORDER BY last_event_at DESC`).all() as any[]
  const cards = sessions.map(s => {
    const open = db.query(`SELECT kind, name, started_at FROM spans
      WHERE session_id = ? AND ended_at IS NULL AND kind IN ('tool', 'mcp', 'agent')
      ORDER BY started_at DESC LIMIT 1`).get(s.id) as any
    const pend = db.query(`SELECT COALESCE(sp.name, '?') tool, e.ts ts FROM events e
      LEFT JOIN spans sp ON sp.id = e.span_id
      WHERE e.session_id = ? AND e.type = 'permission.requested'
        AND NOT EXISTS (SELECT 1 FROM events r WHERE r.span_id = e.span_id AND r.type = 'permission.resolved')
      ORDER BY e.ts`).all(s.id) as any[]
    const models = db.query(`SELECT name model,
        SUM(COALESCE(json_extract(attrs, '$.input_tokens'), 0)) tin,
        SUM(COALESCE(json_extract(attrs, '$.output_tokens'), 0)) tout
      FROM spans WHERE session_id = ? AND kind = 'llm' GROUP BY name`).all(s.id) as any[]
    const costs = models.map(m => estCost(m.model, m.tin, m.tout)).filter((c): c is number => c !== null)
    const current = open ? { kind: open.kind, name: open.name, running_ms: opts.now - open.started_at } : null
    const pending_permissions = pend.map(p => ({ tool: p.tool, waiting_ms: opts.now - p.ts }))
    const stuck = pending_permissions.some(p => p.waiting_ms > STUCK_PERMISSION_MS)
      || (current !== null && (current.kind === 'tool' || current.kind === 'mcp') && current.running_ms > STUCK_TOOL_MS)
    return {
      id: s.id, project: s.project, started_at: s.started_at, last_event_at: s.last_event_at,
      idle_ms: opts.now - s.last_event_at,
      effective: (s.last_event_at >= opts.now - opts.staleAfterMs ? 'active' : 'stale') as 'active' | 'stale',
      current, pending_permissions,
      tokens_in: models.reduce((a, m) => a + m.tin, 0), tokens_out: models.reduce((a, m) => a + m.tout, 0),
      est_cost: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
      stuck,
    }
  })
  return cards.sort((a, b) =>
    (b.pending_permissions.length ? 1 : 0) - (a.pending_permissions.length ? 1 : 0) || b.last_event_at - a.last_event_at)
}
```

Export `fleetView` + `type FleetCard` from `server-exports.ts`. Route in `server.ts` (near the other GET routes, inside the try/catch; import `fleetView` from `./insights`):
```ts
        if (path === '/api/fleet' && req.method === 'GET') return json(fleetView(store.db, qopts))
```

Add to the SKILL.md endpoint table (after the footprint row):
```markdown
| `GET /api/fleet` | live sessions right now: current activity, pending permissions, idle time, stuck flags (no params) |
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/server/test/insights.test.ts test/e2e.test.ts`, root `bun test`, `bunx tsc --noEmit`.
Expected: root 153 pass / 0 fail (147 + 5 unit + 1 e2e).

- [ ] **Step 5: Commit**

```bash
git add packages/server packages/cli/skill test/e2e.test.ts && git commit -m "Add fleet view query and endpoint"
```

---

### Task 2: LiveView ops board + live rollout

**Files:**
- Modify: `packages/dashboard/src/views/LiveView.tsx` (full replacement below), `packages/dashboard/src/api.ts` (one helper), `packages/dashboard/src/types.ts` (FleetCard mirror), `packages/dashboard/src/theme.css` (append)
- Test: none new (no dashboard harness); verification = build + tsc + browser evidence + rollout.

**Interfaces:**
- Consumes: `GET /api/fleet` (Task 1); existing `liveSocket`, `fmtTime`/`fmtDuration`/`fmtTokens`.
- Produces: the reorganized `#/live` view.

- [ ] **Step 1: Types + API helper**

`packages/dashboard/src/types.ts` — append (a mirror of the server type; the e2e test is the contract):
```ts
export type FleetCard = {
  id: string; project: string | null
  started_at: number; last_event_at: number; idle_ms: number
  effective: 'active' | 'stale'
  current: { kind: string; name: string; running_ms: number } | null
  pending_permissions: Array<{ tool: string; waiting_ms: number }>
  tokens_in: number; tokens_out: number; est_cost: number | null
  stuck: boolean
}
```
`packages/dashboard/src/api.ts` — append:
```ts
export const fetchFleet = (): Promise<FleetCard[]> => fetch('/api/fleet').then(r => r.json())
```
(import the type from `./types`.)

- [ ] **Step 2: Replace LiveView.tsx**

Full new content (preserves the existing feed logic verbatim — `opToFeedItem` and the feed JSX are unchanged from the current file):
```tsx
import { useEffect, useRef, useState } from 'react'
import { fetchFleet, liveSocket } from '../api'
import { fmtTime, fmtDuration, fmtTokens } from '../format'
import type { FleetCard } from '../types'

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

function Card({ c, extra }: { c: FleetCard; extra: number }) {
  const idle = c.idle_ms + extra
  return (
    <a className={`fleet-card${c.stuck ? ' stuck' : ''}`} href={`#/session/${encodeURIComponent(c.id)}`}>
      <header>
        <strong>{c.project ?? c.id.slice(0, 8)}</strong>
        <span className={`badge ${c.effective}`}>{c.stuck ? 'stuck' : c.effective}</span>
      </header>
      <div className="fleet-now">
        {c.current
          ? <>▶ {c.current.name} · {fmtDuration(c.current.running_ms + extra)}</>
          : <>idle {fmtDuration(idle)}</>}
      </div>
      {c.pending_permissions.map((p, i) => (
        <div key={i} className="perm-banner">⏳ {p.tool} awaiting approval {fmtDuration(p.waiting_ms + extra)}</div>
      ))}
      <footer className="fleet-foot">
        {fmtTokens(c.tokens_in)} in / {fmtTokens(c.tokens_out)} out
        {c.est_cost !== null && <> · ${c.est_cost.toFixed(2)} est.</>}
      </footer>
    </a>
  )
}

export function LiveView() {
  const [fleet, setFleet] = useState<FleetCard[] | null>(null)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [paused, setPaused] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const [, tick] = useState(0)
  const fetchedAt = useRef(Date.now())
  const lastFetch = useRef(0)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      const now = Date.now()
      if (now - lastFetch.current < 1000) return
      lastFetch.current = now
      fetchFleet().then(cards => {
        if (cancelled) return
        setFleet(cards)
        fetchedAt.current = Date.now()
        setDisconnected(false)
      }).catch(() => { if (!cancelled) setDisconnected(true) })
    }
    refresh()
    const poll = setInterval(refresh, 5000)
    const timers = setInterval(() => tick(t => t + 1), 1000)
    const ws = liveSocket('*', ops => {
      refresh()
      if (pausedRef.current) return
      const items = ops.map(opToFeedItem).filter(Boolean) as FeedItem[]
      setFeed(prev => [...items.reverse(), ...prev].slice(0, 500))
    })
    return () => { cancelled = true; clearInterval(poll); clearInterval(timers); ws.close() }
  }, [])

  const extra = Date.now() - fetchedAt.current

  return (
    <section>
      <header className="viewhead">
        <h1>Live</h1>
        {disconnected && <span className="empty">disconnected — retrying</span>}
        <button className="pause" onClick={() => setPaused(!paused)}>{paused ? 'resume' : 'pause'}</button>
      </header>
      <div className="fleet-grid">
        {(fleet ?? []).map(c => <Card key={c.id} c={c} extra={extra} />)}
        {fleet !== null && fleet.length === 0 && <p className="empty">no live sessions</p>}
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
(Note: `fetchSessions` and the chips block are intentionally gone — the cards replace them. Remove the now-unused `SessionRow` import.)

- [ ] **Step 3: CSS**

Append to `packages/dashboard/src/theme.css`:
```css
.fleet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; margin: 12px 0 20px; }
.fleet-card { display: block; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--fg); text-decoration: none; }
.fleet-card:hover { border-color: var(--accent); }
.fleet-card.stuck { border-color: var(--err); }
.fleet-card header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.fleet-now { color: var(--dim); font-size: 0.9em; margin-bottom: 4px; }
.perm-banner { color: var(--run); font-size: 0.85em; margin: 2px 0; }
.fleet-card.stuck .perm-banner { color: var(--err); }
.fleet-foot { color: var(--dim); font-size: 0.8em; margin-top: 6px; }
.badge.stale { background: color-mix(in srgb, var(--dim) 20%, transparent); }
```
(`.badge.active` exists; verify `.badge.stale` doesn't already — if it does, skip that line.)

- [ ] **Step 4: Build + verify**

Run: `bun run build`, `bunx tsc --noEmit`, root `bun test` (expect 153 pass / 0 fail — unchanged from Task 1).

- [ ] **Step 5: Live rollout**

```bash
bun run build:pkg && cp -r dist-pkg/. /home/mlayug/node_modules/0rrery/
systemctl --user restart 0rrery && sleep 6 && systemctl --user is-active 0rrery
```
Then in the browser, open `http://localhost:7317/#/live` and verify WITH YOUR EYES (screenshots):
1. Cards render for the currently-live sessions (this box usually has several; the building session itself must appear).
2. Timers tick: two screenshots ~4s apart show running/idle values advancing without a fetch.
3. Pending-permission path — inject a synthetic one and watch it surface:
```bash
curl -s -X POST localhost:7317/api/ingest -H 'Content-Type: application/json' -d "[
  {\"op\":\"session.start\",\"sessionId\":\"fleet-demo\",\"source\":\"api\",\"project\":\"fleet-demo\",\"ts\":$(date +%s%3N)},
  {\"op\":\"span.start\",\"id\":\"tool:fleetdemo1\",\"sessionId\":\"fleet-demo\",\"parentId\":null,\"kind\":\"tool\",\"name\":\"Bash\",\"ts\":$(date +%s%3N),\"attrs\":{}},
  {\"op\":\"event\",\"id\":\"evt:perm:req:fleetdemo1\",\"sessionId\":\"fleet-demo\",\"spanId\":\"tool:fleetdemo1\",\"type\":\"permission.requested\",\"ts\":$(date +%s%3N),\"attrs\":{}}]"
```
Expect: within ~5s the fleet-demo card appears FIRST (pending sort), amber banner "⏳ Bash awaiting approval …" counting up. Screenshot it. Then clean up so it doesn't linger as a stale card:
```bash
curl -s -X POST localhost:7317/api/ingest -H 'Content-Type: application/json' -d "[
  {\"op\":\"event\",\"id\":\"evt:perm:res:fleetdemo1\",\"sessionId\":\"fleet-demo\",\"spanId\":\"tool:fleetdemo1\",\"type\":\"permission.resolved\",\"ts\":$(date +%s%3N),\"attrs\":{\"outcome\":\"allowed\"}},
  {\"op\":\"span.end\",\"id\":\"tool:fleetdemo1\",\"ts\":$(date +%s%3N),\"status\":\"ok\"},
  {\"op\":\"session.end\",\"sessionId\":\"fleet-demo\",\"ts\":$(date +%s%3N)}]"
```
Verify the card drops off (session ended). Report all OBSERVED, screenshots included.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard && git commit -m "Turn Live tab into the fleet ops board"
```

---

## Out of scope (per spec)

Notifications, acting on permissions from the dashboard, historical playback, sparklines, threshold config.
