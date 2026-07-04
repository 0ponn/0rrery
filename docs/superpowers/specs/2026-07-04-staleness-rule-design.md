# 0rrery Active-Status Staleness Rule Design

Date: 2026-07-04
Status: approved pending user spec review
Parent specs: `2026-07-04-0rrery-rebuild-design.md`, `2026-07-04-trace-depth-design.md` (closes their "active-status staleness rule" debt item).

## Summary

Sessions whose end was never observed (backfilled history, crashed sessions) stop reading as `active` forever. Staleness is derived at read time from `last_event_at`; nothing is written, nothing is swept, and a resumed session becomes effectively active again purely by its `last_event_at` moving.

## Decisions

| Decision | Choice |
|---|---|
| Mechanism | Read-time derivation only; stored `status` remains the raw fact (hook-observed end vs no-end-seen). No sweeper, no migration. |
| Cutoff | `staleAfterMs` in Config, default `1_800_000` (30 min), env `ORRERY_STALE_MS` (integer-validated like `ORRERY_PORT`), overrides win. |
| Presentation | Derived `effectiveStatus: 'active' \| 'stale' \| 'ended'` stamped on session objects at the API response boundary; DB row shape and `@0rrery/schema` types unchanged. |

## Semantics

For a session row with stored `status` and `last_event_at`, given `now` and `staleAfterMs`:

- `ended` → effective `ended`.
- `active` and `last_event_at >= now - staleAfterMs` → effective `active`.
- `active` and `last_event_at < now - staleAfterMs` → effective `stale`.

## Changes

**Config** (`packages/server/src/config.ts`): `staleAfterMs: number`, default `1_800_000`, env `ORRERY_STALE_MS` accepted only when a non-negative integer, overrides take precedence.

**Queries** (`packages/server/src/queries.ts`): `listSessions(db, f, opts)` and `getStats(db, opts)` take `opts: { now: number; staleAfterMs: number }` (explicit, injectable clock — tests never depend on wall time).
- `SessionFilter.status` gains `'stale'`. SQL translation: `active` → `status = 'active' AND last_event_at >= ?cutoff`; `stale` → `status = 'active' AND last_event_at < ?cutoff`; `ended` → `status = 'ended'`.
- `getStats` returns `{ sessions, activeSessions, staleSessions, spans, events }` where `activeSessions` is effective-active and `staleSessions` counts effective-stale.

**Server** (`packages/server/src/server.ts`): passes `{ now: Date.now(), staleAfterMs: config.staleAfterMs }` into queries; stamps `effectiveStatus` onto every session object in `/api/sessions` and the `session` of `/api/sessions/:id` via one shared helper. The `status` query param accepts `stale` (already unvalidated pass-through; the SQL translation handles it).

**Dashboard**:
- `types.ts`: session objects from the API carry `effectiveStatus: 'active' | 'stale' | 'ended'` (extend the API-layer type, not the schema row type).
- Badges render `effectiveStatus`; `theme.css` gains `.badge.stale` (dim amber, distinct from `active`).
- Sessions filter dropdown gains `stale`.
- Session detail opens its live WebSocket only when `effectiveStatus === 'active'`.
- Live view needs no change (its `status=active` fetch now returns effective-active from the server).

## Testing

- Queries: injected `now` — a fixture with one hook-ended, one recent-active, one old-active session asserts all three filters and both stat counts. No wall-clock dependence.
- Config: `ORRERY_STALE_MS` default/env/override/garbage cases (copy the `ORRERY_PORT` test pattern incl. try/finally hygiene).
- Server integration: `/api/sessions?status=stale` returns only the old-active session; every returned session carries the correct `effectiveStatus`.
- Dashboard: pure logic only (badge class selection if extracted); rendering verified by `vite build`.

## Out of scope

UI control for the cutoff, per-source staleness values, write-time sweeping or migration of historical rows, retention interaction (sweep already keys on `last_event_at` independently).
