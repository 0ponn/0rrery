import { useEffect, useRef, useState } from 'react'
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
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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
        {span.kind === 'llm' && parsed && (parsed.input_tokens || parsed.output_tokens) && <>
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
