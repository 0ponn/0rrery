# 0rrery Trace View v2 Design (0PO-471 + 0PO-472)

Date: 2026-07-05
Status: approved pending user spec review
Parent: `2026-07-04-0rrery-rebuild-design.md` (the v1 trace tab), `docs/dogfood-findings-2026-07-05.md` (both P1s). Combined deliberately: both tickets rework the same component.

## Summary

The session-detail trace becomes usable at real scale and inspectable at real depth: fixed-height-row virtualization (a pure, dependency-free hook shared by the Trace and Events tabs), throttled live updates, and a right-side span detail panel (user-approved layout) exposing the attrs, timing, and events that until now only the DB could see.

## Decisions (user-approved 2026-07-05)

- **Panel layout:** right side panel (~360px), waterfall stays visible; not inline-expand (variable row heights would fight virtualization), not bottom drawer.
- **No dependencies:** hand-rolled windowing; rows are already fixed-height, so the math is trivial.
- **No new endpoints:** the session-detail response already carries every span attr and event.

## Components

### 1. `visibleRange` + `useVirtualRows` — `packages/dashboard/src/virtual.ts`

Pure function (unit-tested without DOM):
```ts
export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 20):
  { start: number; end: number; padTop: number; padBottom: number }
```
Clamped to `[0, total]`; `padTop/padBottom` are spacer heights in px. Hook `useVirtualRows(total, rowH)` returns `{ containerProps, start, end, padTop, padBottom }` — a fixed-height (`70vh`) `overflow-y: auto` container tracking `scrollTop` via a passive scroll listener into state.

Applied to BOTH the Trace waterfall rows and the Events list (same freeze pathology). Row height pinned as a constant matching the CSS (single source: export `ROW_H` from virtual.ts, used in the stylesheet via inline row style or a CSS var).

### 2. Live-update throttle — `SessionDetailView.tsx`

WS-triggered refetches throttled to ≤1 per 2s (same pattern as the fleet board: `lastFetch` ref guard + the socket callback calling `refresh()`), replacing any per-batch full refetch. Selected-span identity survives refetches (selection is by span id, re-resolved against the fresh array; if the span vanished, panel closes).

### 3. Span detail panel — `packages/dashboard/src/views/SpanPanel.tsx`

`<SpanPanel span={SpanRow} events={EventRow[]} onClose onSelectParent />` rendered beside the waterfall when a row is clicked (row gets `.selected` highlight):

- Header: name, kind badge, status badge, ×.
- Timing: started (fmtTime), duration (fmtDuration; "running" when no ended_at).
- LLM spans: input/output/cache token attrs called out.
- Attrs: pretty-printed JSON (`JSON.stringify(parsed, null, 2)` in a `<pre>`); if serialized attrs > 2,048 chars, render collapsed with byte count + "show" toggle.
- Events: this span's events (type, fmtTime, outcome attrs) — where `permission.resolved {outcome: denied}` becomes visible.
- Parent: when `parent_id` resolves to a loaded span, a link that re-selects it.
- Esc closes (document keydown while open, cleaned up).

Layout: the trace tab becomes a flex row — virtualized waterfall (flex 1) + panel (fixed 360px) when open. Malformed attrs JSON renders the raw string rather than throwing.

## Error handling

- Running spans (no ended_at): duration renders "running"; panel still opens.
- Attrs `{}` → "no attrs" placeholder; malformed → raw string fallback.
- Span removed by a refetch while selected → panel closes silently.
- Scroll state preserved across throttled refetches (list length may grow; padBottom absorbs it).

## Testing

- Unit (`packages/dashboard/test/virtual.test.ts` — first dashboard test file, pure logic only): visibleRange at top/middle/bottom, clamping on short lists, overscan, padTop/padBottom sum consistency (`padTop + rendered*rowH + padBottom === total*rowH`).
- Root suite + tsc + `bun run build` green.
- Live rollout (the point): `0rrery import` THIS session's transcript (the largest this box has produced), open its trace — no freeze, smooth scroll (screenshots at top/middle/bottom), row count in DOM ≤ ~80 (verify via devtools/JS probe), click a denied span → panel shows `denied: true` and the permission events, Esc closes. Events tab scrolls the same session without wedging. Perf: initial render of the trace tab < 1s observed.

## Out of scope

Collapse-by-turn/tree folding, search within trace, span-to-span diff, time-axis ruler, panel for Insights sprawl nodes.
