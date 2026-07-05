# 0rrery Fleet View Design (durable-value arc 3/3)

Date: 2026-07-05
Status: approved pending user spec review
Parent: `2026-07-05-insights-design.md` (query-layer + skill-readiness patterns), `2026-07-05-agent-skill-design.md` (the cheat sheet this extends).

## Summary

The Live tab becomes an ops board for concurrent sessions: one card per live session showing what it is doing right now, whether it is waiting on a permission (the actionable signal), how idle it is, and what it has cost — with the existing event feed demoted to a panel below. One new read-only query function + endpoint; the agent skill learns "what's running right now."

## Decisions (user-approved 2026-07-05)

- **Placement:** evolve the Live tab; no new top-level tab.
- **Actionable core:** pending permissions surface first (sort + amber banner), stuck flags escalate (red).
- **Thresholds (constants, not config):** `STUCK_PERMISSION_MS = 120_000` (pending permission older than 2 min), `STUCK_TOOL_MS = 600_000` (open tool/mcp span older than 10 min).

## Components

### 1. `fleetView(db, opts)` — `packages/server/src/insights.ts`

`opts = { now: number; staleAfterMs: number }` (the existing QueryOpts shape). Covers sessions with `status = 'active'` (both effective-active and effective-stale; ended excluded). Returns, sorted by (has pending permissions desc, last_event_at desc):

```ts
export type FleetCard = {
  id: string; project: string | null
  started_at: number; last_event_at: number; idle_ms: number          // now - last_event_at
  effective: 'active' | 'stale'                                        // same cutoff math as effectiveStatus
  current: { kind: string; name: string; running_ms: number } | null   // newest OPEN tool/mcp/agent span (ended_at null), else null
  pending_permissions: Array<{ tool: string; waiting_ms: number }>     // permission.requested events whose span_id has no permission.resolved event
  tokens_in: number; tokens_out: number; est_cost: number | null       // session llm totals, null-honest per prices.ts
  stuck: boolean                                                       // any pending permission > STUCK_PERMISSION_MS, or current open tool/mcp span > STUCK_TOOL_MS
}
```

Notes: pending-permission matching is by `span_id` across `permission.requested` / `permission.resolved` events (both hook-emitted; transcript denials also emit resolved — already the same ID space). `current` picks the newest open span of kind tool/mcp/agent; open llm spans are ignored (transcript llm spans open+close at the same ts). All SQL parameterized; per-session subqueries acceptable (fleet is bounded by concurrent sessions, ~10).

**Amended 2026-07-05 (Task 1 review, live-DB probe):** two of this section's assumptions fail against real data. (a) `permission.resolved` is only ever emitted for DENIALS — no code path emits an "allowed" resolution — so requested-minus-resolved marks every approved permission in history as forever-pending (observed: 52/52, 92% of cards stuck). Pending is therefore derived read-time as: `permission.requested` with no `permission.resolved` for the span, whose span has NOT ended (`ended_at IS NULL` or span row absent), and whose request is younger than `PENDING_WINDOW_MS = 1_800_000`. Known accepted ambiguity: an approved tool STILL RUNNING shows as pending until its span closes — bounded by tool runtime, self-clearing, and indistinguishable without an upstream "allowed" emitter (rejected: only fixes future data and adds an event per tool call). (b) Nothing marks crashed/abandoned sessions ended, so `status = 'active'` covers 113 sessions on this box (oldest 45.9 days). Fleet is bounded by `FLEET_HORIZON_MS = 3_600_000`: only sessions with `last_event_at` inside the last hour appear — an ops board shows the last hour, not the graveyard (Sessions list still shows everything).

### 2. API — `GET /api/fleet`

No params (fleet is "now" by definition). Uses the request's `qopts`. Returns `FleetCard[]` verbatim. Inside the existing try/catch. Exported through `server-exports.ts`.

### 3. LiveView reorg — `packages/dashboard/src/views/LiveView.tsx`

- **Board (top):** card grid (`repeat(auto-fill, minmax(280px, 1fr))`). Card: project (fallback session id prefix) + effective badge; the current-activity line (`{name} · {running_ms}` ticking, or `idle {idle_ms}` ticking); pending-permission banner per entry — amber `⏳ {tool} awaiting approval {waiting_ms}`; card border red + "stuck" badge when `stuck`; tokens + est $ (or tokens only) footer; whole card links to `#/session/{id}`. Empty fleet → "no live sessions".
- **Feed (below):** the existing feed panel and pause button, unchanged, under a "Feed" heading.
- **Updates:** refetch `/api/fleet` when the existing live WebSocket delivers any message, throttled to ≤1 fetch/s; plus a 5s interval fallback (also covers socket-down). Timers (`running_ms`/`idle_ms`/`waiting_ms`) tick client-side each second from the last fetch's base values.

### 4. Skill cheat sheet — `packages/cli/skill/SKILL.md`

One row added to the endpoint table: `GET /api/fleet` | live sessions right now: current activity, pending permissions, idle time, stuck flags. (No new worked example — the table row suffices; skill body stays ≤ ~100 lines.)

## Error handling

- `/api/fleet` on an empty DB → `[]`, 200.
- Fetch failure in the board → keep last cards, show a small "disconnected" note (the feed's socket handling already exists; don't duplicate its logic).
- Sessions with no spans/events at all → card with `current: null`, zero tokens, no permissions (COALESCE guards like sessionSummary).

## Testing

- Unit (`packages/server/test/insights.test.ts`): resolved permission excluded / unresolved included with correct `waiting_ms`; `current` picks newest open span and ignores closed + llm; sort order (pending-perms session first); stuck both ways (old pending permission; old open tool); ended session excluded; effective active vs stale cutoff.
- E2E: `/api/fleet` returns the fixture session (imported fixture sessions are `ended` after finalize — seed one active session via a direct ingest POST in the test) with shape asserted.
- Live rollout: deploy via the established propagation, restart, open `#/live` in the browser with real concurrent sessions running — verify cards render, the current-activity line ticks, and this session's own card shows activity. Screenshot evidence; observed only.

## Out of scope

Notifications/sounds on pending permissions, acting on permissions from the dashboard (read-only remains), historical fleet playback, per-card sparklines, config for stuck thresholds.
