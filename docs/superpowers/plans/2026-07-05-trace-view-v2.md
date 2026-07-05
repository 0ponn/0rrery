# Trace View v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The session trace survives 4,000-span active sessions (fixed-height virtualization + throttled live updates) and every span becomes inspectable (right-side detail panel).

**Architecture:** Pure `visibleRange` math + a thin `useVirtualRows` hook in a new `virtual.ts`; the recursive waterfall flattens to a windowed list (a `flattenTree` helper — the tree already carries depth); the inline attrs expander is deleted in favor of `SpanPanel`, which also restores fixed row heights. Events tab converts from `<table>` to the same virtualized row pattern.

**Tech Stack:** Existing: React, TypeScript, `bun test` (pure functions only — no DOM testing), no new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-05-trace-view-v2-design.md`. Read it first.
- NO new dependencies. No new endpoints. `ROW_H = 24` is the single row-height source (math + inline row style both use it).
- Selection is by span id, re-resolved per render; span vanishes → panel closes.
- Live refetch throttle: ≤1 per 2s WITH a trailing call (never drop the final state — the fleet unit's dropped-trailing-refresh minor, fixed here from birth).
- Attrs > 2,048 serialized chars render collapsed behind a show toggle. Malformed attrs JSON → raw string, never a throw.
- Every fetch helper touched has `r.ok` handling (standing rule; `fetchSession` already does — don't regress it).
- `bun test` FROM THE REPO ROOT + `bunx tsc --noEmit` + `bun run build` green before every commit; paste actual tails. Root currently 159.

---

### Task 1: virtualization math + tree flatten

**Files:**
- Create: `packages/dashboard/src/virtual.ts`
- Modify: `packages/dashboard/src/tree.ts` (append `flattenTree`)
- Test: `packages/dashboard/test/virtual.test.ts` (new — first dashboard test file; pure logic only, no DOM/React imports in tests)

**Interfaces:**
- Consumes: `buildSpanTree`, `type SpanNode` from `../src/tree` (existing: `{ span: SpanRow; depth: number; children: SpanNode[] }`).
- Produces (Task 2 renders with these):
  - `export const ROW_H = 24`
  - `visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 20): { start: number; end: number; padTop: number; padBottom: number }`
  - `useVirtualRows(total: number, rowH = ROW_H): { onScroll: (e: React.UIEvent<HTMLDivElement>) => void; start: number; end: number; padTop: number; padBottom: number }`
  - `flattenTree(nodes: SpanNode[]): SpanNode[]` (DFS order, depth preserved)

- [ ] **Step 1: Write the failing tests**

Create `packages/dashboard/test/virtual.test.ts`:
```ts
import { test, expect } from 'bun:test'
import { visibleRange, ROW_H } from '../src/virtual'
import { buildSpanTree, flattenTree } from '../src/tree'
import type { SpanRow } from '../src/types'

test('visibleRange at the top renders from row 0 with overscan below', () => {
  const r = visibleRange(0, 600, 24, 4000)
  expect(r.start).toBe(0)
  expect(r.end).toBe(Math.ceil(600 / 24) + 20)
  expect(r.padTop).toBe(0)
})

test('visibleRange mid-scroll windows around the viewport', () => {
  const r = visibleRange(48_000, 600, 24, 4000)
  expect(r.start).toBe(2000 - 20)
  expect(r.end).toBe(Math.ceil((48_000 + 600) / 24) + 20)
  expect(r.padTop).toBe(r.start * 24)
})

test('visibleRange clamps on short lists and at the bottom', () => {
  const short = visibleRange(0, 600, 24, 10)
  expect(short).toMatchObject({ start: 0, end: 10, padTop: 0, padBottom: 0 })
  const bottom = visibleRange(4000 * 24 - 600, 600, 24, 4000)
  expect(bottom.end).toBe(4000)
  expect(bottom.padBottom).toBe(0)
})

test('pad invariant: spacers plus rendered rows always sum to full height', () => {
  for (const st of [0, 999, 47_997, 95_400]) {
    const r = visibleRange(st, 613, 24, 4000)
    expect(r.padTop + (r.end - r.start) * 24 + r.padBottom).toBe(4000 * 24)
  }
})

test('flattenTree preserves DFS order and depth', () => {
  const mk = (id: string, parent: string | null): SpanRow => ({
    id, session_id: 's', parent_id: parent, kind: 'tool', name: id,
    started_at: 1, ended_at: 2, status: 'ok', attrs: '{}',
  } as SpanRow)
  const tree = buildSpanTree([mk('a', null), mk('b', 'a'), mk('c', 'b'), mk('d', null)])
  const flat = flattenTree(tree)
  expect(flat.map(n => n.span.id)).toEqual(['a', 'b', 'c', 'd'])
  expect(flat.map(n => n.depth)).toEqual([0, 1, 2, 0])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/dashboard/test/virtual.test.ts`
Expected: FAIL — `../src/virtual` does not exist; `flattenTree` not exported.

- [ ] **Step 3: Implement**

Create `packages/dashboard/src/virtual.ts`:
```ts
import { useState } from 'react'

export const ROW_H = 24

export function visibleRange(scrollTop: number, viewportH: number, rowH: number, total: number, overscan = 20) {
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + overscan)
  return { start, end, padTop: start * rowH, padBottom: (total - end) * rowH }
}

export function useVirtualRows(total: number, rowH = ROW_H) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(800)
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    setScrollTop(el.scrollTop)
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight)
  }
  return { onScroll, ...visibleRange(scrollTop, viewportH, rowH, total) }
}
```

Append to `packages/dashboard/src/tree.ts`:
```ts
export function flattenTree(nodes: SpanNode[]): SpanNode[] {
  const out: SpanNode[] = []
  const walk = (n: SpanNode) => {
    out.push(n)
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/dashboard/test/virtual.test.ts`, root `bun test`, `bunx tsc --noEmit`.
Expected: root 164 pass / 0 fail (159 + 5).

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard && git commit -m "Add virtualization math and tree flatten"
```

---

### Task 2: SpanPanel + virtualized SessionDetailView + rollout

**Files:**
- Create: `packages/dashboard/src/views/SpanPanel.tsx`
- Modify: `packages/dashboard/src/views/SessionDetailView.tsx` (full replacement below), `packages/dashboard/src/theme.css` (append)
- Test: none new (browser + rollout verification; Task 1 covers the logic)

**Interfaces:**
- Consumes: `ROW_H`, `useVirtualRows` from `../virtual` (post-fix contract: the hook ALSO returns `ref` — every virtualized container must set BOTH `ref={v.ref}` and `onScroll={v.onScroll}`, or tall monitors under-render until first scroll); `flattenTree` from `../tree`; everything SessionDetailView already imports.
- Produces: the shipped trace view.

- [ ] **Step 1: Create `packages/dashboard/src/views/SpanPanel.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { fmtDuration, fmtTime, fmtTokens } from '../format'
import { displayKind } from '@0rrery/schema/src/names'
import type { SpanRow, EventRow } from '../types'

function prettyAttrs(attrs: string): string {
  try { return JSON.stringify(JSON.parse(attrs), null, 2) } catch { return attrs }
}

function eventOutcome(attrs: string): string {
  try {
    const a = JSON.parse(attrs)
    return a.outcome ? ` · ${a.outcome}` : ''
  } catch { return '' }
}

export function SpanPanel({ span, events, parent, onClose, onSelectParent }: {
  span: SpanRow; events: EventRow[]; parent: SpanRow | null
  onClose: () => void; onSelectParent: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  useEffect(() => setExpanded(false), [span.id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  let parsed: any = null
  try { parsed = JSON.parse(span.attrs) } catch {}
  const text = prettyAttrs(span.attrs)
  const big = text.length > 2048

  return (
    <aside className="span-panel">
      <header>
        <span className={`kind kind-${displayKind(span.kind, span.name)}`}>{displayKind(span.kind, span.name)}</span>
        <strong className="panel-name">{span.name}</strong>
        <span className={`badge st-${span.status}`}>{span.status}</span>
        <button className="close" onClick={onClose}>×</button>
      </header>
      <dl className="panel-meta">
        <dt>started</dt><dd>{fmtTime(span.started_at)}</dd>
        <dt>duration</dt><dd>{span.ended_at ? fmtDuration(span.ended_at - span.started_at) : 'running'}</dd>
        {span.kind === 'llm' && parsed && <>
          <dt>tokens</dt>
          <dd>{fmtTokens(parsed.input_tokens ?? 0)} in / {fmtTokens(parsed.output_tokens ?? 0)} out
            {parsed.cache_read_input_tokens ? ` · ${fmtTokens(parsed.cache_read_input_tokens)} cached` : ''}</dd>
        </>}
        {parent && <>
          <dt>parent</dt>
          <dd><a className="parent-link" onClick={() => onSelectParent(parent.id)}>{parent.name}</a></dd>
        </>}
      </dl>
      <h3>attrs</h3>
      {text === '{}'
        ? <p className="empty">no attrs</p>
        : big && !expanded
          ? <button className="pause" onClick={() => setExpanded(true)}>show {text.length.toLocaleString()} chars</button>
          : <pre className="attrs">{text}</pre>}
      {events.length > 0 && <>
        <h3>events</h3>
        {events.map(e => (
          <div key={e.id} className="panel-event">
            <span className="feed-ts">{fmtTime(e.ts)}</span> {e.type}{eventOutcome(e.attrs)}
          </div>
        ))}
      </>}
    </aside>
  )
}
```

- [ ] **Step 2: Replace `SessionDetailView.tsx`**

Full new content (header/tabs/topology unchanged from current; the trace tab, events tab, WaterfallRow, and the load effect are reworked):
```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchSession, liveSocket } from '../api'
import { buildSpanTree, flattenTree, tokenRollup, type SpanNode } from '../tree'
import { fmtDuration, fmtTime, fmtTokens } from '../format'
import { permissionStatus, eventDetail, type PermStatus } from '../perms'
import { displayKind } from '@0rrery/schema/src/names'
import { ROW_H, useVirtualRows } from '../virtual'
import { TopologyTab } from './TopologyTab'
import { SpanPanel } from './SpanPanel'
import type { SessionDetail, EventRow, SpanRow } from '../types'

function WaterfallRow({ node, t0, total, perms, selected, onSelect }: {
  node: SpanNode; t0: number; total: number; perms: Map<string, PermStatus>
  selected: boolean; onSelect: (id: string) => void
}) {
  const s = node.span
  const end = s.ended_at ?? t0 + total
  const left = total ? ((s.started_at - t0) / total) * 100 : 0
  const width = total ? Math.max(0.5, ((end - s.started_at) / total) * 100) : 100
  return (
    <div className={`wf-row${selected ? ' selected' : ''}`} style={{ height: ROW_H }} onClick={() => onSelect(s.id)}>
      <span className="wf-name" style={{ paddingLeft: node.depth * 16 }}>
        <span className={`kind kind-${displayKind(s.kind, s.name)}`}>{displayKind(s.kind, s.name)}</span> {s.name}
        {perms.has(s.id) && <span className={`perm-badge ${perms.get(s.id)}`}>{perms.get(s.id)}</span>}
      </span>
      <span className="wf-track">
        <span className={`wf-bar st-${s.status}`} style={{ left: `${left}%`, width: `${width}%` }} />
      </span>
      <span className="wf-dur">{s.ended_at ? fmtDuration(s.ended_at - s.started_at) : 'running'}</span>
    </div>
  )
}

function EventsList({ events }: { events: EventRow[] }) {
  const v = useVirtualRows(events.length)
  return (
    <div className="feed vlist" ref={v.ref} onScroll={v.onScroll}>
      <div style={{ height: v.padTop }} />
      {events.slice(v.start, v.end).map(e => (
        <div key={e.id} className="feed-row" style={{ height: ROW_H }}>
          <span className="feed-ts">{fmtTime(e.ts)}</span>
          <span className="feed-sid">{e.type}</span>
          <span className="ev-detail">{eventDetail(e.attrs)}</span>
        </div>
      ))}
      <div style={{ height: v.padBottom }} />
      {events.length === 0 && <p className="empty">No events.</p>}
    </div>
  )
}

export function SessionDetailView({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'trace' | 'events' | 'topology'>('trace')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const lastFetch = useRef(0)
  const trailing = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let ws: WebSocket | null = null
    let cancelled = false
    let recheck: ReturnType<typeof setTimeout> | null = null
    const load = () => {
      const now = Date.now()
      if (now - lastFetch.current < 2000) {
        if (!trailing.current) trailing.current = setTimeout(() => { trailing.current = null; load() }, 2000 - (now - lastFetch.current))
        return
      }
      lastFetch.current = now
      fetchSession(id).then(d => {
        if (cancelled) return
        setError('')
        setDetail(d)
        if (d.session.effectiveStatus === 'active' && !ws) ws = liveSocket(id, () => load())
        else if (d.session.effectiveStatus === 'stale' && !ws) recheck = setTimeout(load, 30_000)
      }).catch(e => {
        if (cancelled) return
        setError(String(e))
      })
    }
    load()
    return () => {
      cancelled = true
      ws?.close()
      if (recheck) clearTimeout(recheck)
      if (trailing.current) { clearTimeout(trailing.current); trailing.current = null }
    }
  }, [id])

  const tree = useMemo(() => detail ? buildSpanTree(detail.spans) : [], [detail])
  const flat = useMemo(() => flattenTree(tree), [tree])
  const perms = useMemo(() => detail ? permissionStatus(detail.events, detail.spans) : new Map<string, PermStatus>(), [detail])
  const v = useVirtualRows(flat.length)

  if (error) return <p className="error">{error}</p>
  if (!detail) return <p className="empty">loading…</p>

  const { session, spans, events } = detail
  const t0 = session.started_at
  const total = Math.max(1, session.last_event_at - t0)
  const tokens = tokenRollup(spans)
  const selected: SpanRow | null = selectedId ? spans.find(s => s.id === selectedId) ?? null : null
  const parent: SpanRow | null = selected?.parent_id ? spans.find(s => s.id === selected.parent_id) ?? null : null

  return (
    <section>
      <header className="viewhead">
        <h1><a href="#/">Sessions</a> / {session.id.slice(0, 8)}</h1>
        <div className="rollup">
          <span className={`badge ${session.effectiveStatus}`}>{session.effectiveStatus}</span>
          <span>{session.project ?? ''}</span>
          <span>{fmtDuration(total)}</span>
          <span>{fmtTokens(tokens.input)} in / {fmtTokens(tokens.output)} out</span>
        </div>
      </header>
      <div className="tabs">
        <button className={tab === 'trace' ? 'active' : ''} onClick={() => setTab('trace')}>Trace ({spans.length})</button>
        <button className={tab === 'events' ? 'active' : ''} onClick={() => setTab('events')}>Events ({events.length})</button>
        <button className={tab === 'topology' ? 'active' : ''} onClick={() => setTab('topology')}>Topology</button>
      </div>
      {tab === 'trace' && (
        <div className="trace-split">
          <div className="waterfall vlist" ref={v.ref} onScroll={v.onScroll}>
            <div style={{ height: v.padTop }} />
            {flat.slice(v.start, v.end).map(n => (
              <WaterfallRow key={n.span.id} node={n} t0={t0} total={total} perms={perms}
                selected={n.span.id === selectedId} onSelect={setSelectedId} />
            ))}
            <div style={{ height: v.padBottom }} />
            {flat.length === 0 && <p className="empty">No spans recorded.</p>}
          </div>
          {selected && (
            <SpanPanel span={selected} events={events.filter(e => e.span_id === selected.id)}
              parent={parent} onClose={() => setSelectedId(null)} onSelectParent={setSelectedId} />
          )}
        </div>
      )}
      {tab === 'events' && <EventsList events={events} />}
      {tab === 'topology' && <TopologyTab spans={spans} />}
    </section>
  )
}
```
Notes: the old inline `open`/`prettyAttrs` row expander is deleted (the panel replaces it — this is what restores fixed row heights); a selected span that disappears on refetch yields `selected = null`, which unrenders the panel with no effect needed. Verify `EventRow` has `span_id` in types.ts (it mirrors the DB column) — if the field is named differently, match it and say so.

- [ ] **Step 3: CSS**

Append to `packages/dashboard/src/theme.css`:
```css
.vlist { height: 70vh; overflow-y: auto; }
.trace-split { display: flex; gap: 10px; align-items: flex-start; }
.trace-split .waterfall { flex: 1; min-width: 0; }
.wf-row { cursor: pointer; }
.wf-row.selected { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.span-panel { width: 360px; flex-shrink: 0; max-height: 70vh; overflow-y: auto; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.span-panel header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 8px; }
.span-panel .panel-name { overflow-wrap: anywhere; }
.span-panel .close { margin-left: auto; background: none; border: none; color: var(--dim); cursor: pointer; font-size: 1.1em; }
.panel-meta { display: grid; grid-template-columns: 80px 1fr; gap: 2px 8px; font-size: 0.9em; }
.panel-meta dt { color: var(--dim); }
.panel-event { font-size: 0.85em; color: var(--dim); margin: 2px 0; }
.parent-link { color: var(--accent); cursor: pointer; }
.ev-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```
Check the existing `.wf-row` rule: if it declares its own height/padding that conflicts with the 24px inline height, reconcile there (the inline `height: ROW_H` must be the truth).

- [ ] **Step 4: Build + verify**

Run: `bun run build`, `bunx tsc --noEmit`, root `bun test` (expect 164 pass / 0 fail — unchanged from Task 1).

- [ ] **Step 5: Live rollout**

```bash
bun run build:pkg && cp -r dist-pkg/. /home/mlayug/node_modules/0rrery/
systemctl --user restart 0rrery && sleep 6 && systemctl --user is-active 0rrery
# stress corpus: THIS build session's transcript (largest on the box)
/home/mlayug/.bun/bin/0rrery import ~/.claude/projects/-home-mlayug-Documents-0pon-commercial-0rrery/f56f7822-2b63-4860-a522-0e03202916a5.jsonl
```
Browser verification (screenshots, observed):
1. Open `#/session/f56f7822-2b63-4860-a522-0e03202916a5`, Trace tab: renders without freezing; note load-to-paint feel and confirm < 1s.
2. DOM probe via the browser JS tool: `document.querySelectorAll('.wf-row').length` ≤ 80.
3. Scroll to middle and bottom — smooth, rows correct (screenshot each); pad invariant visually holds (scrollbar proportional).
4. Click a Bash span → panel: name, duration, `input.command` visible in attrs; big-attrs spans show the collapsed toggle. Esc closes.
5. Open `#/session/caa90c18-1749-4883-b393-e4c152237a45` (the imported denial session), click the denied Bash span → panel attrs show `"denied": true` and the events section shows `permission.resolved · denied`.
6. Events tab on the giant session: scrolls without wedging, DOM row probe ≤ 80.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard && git commit -m "Virtualize trace and events views, add span detail panel"
```

---

## Out of scope (per spec)

Collapse-by-turn, trace search, time-axis ruler, sprawl-node panels.
