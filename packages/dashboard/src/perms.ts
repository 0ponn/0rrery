import type { EventRow, SpanRow } from './types'

export type PermStatus = 'allowed' | 'denied' | 'pending'

function isDeniedOutcome(attrs: string): boolean {
  try { return JSON.parse(attrs).outcome === 'denied' } catch { return false }
}

export function permissionStatus(events: EventRow[], spans: SpanRow[]): Map<string, PermStatus> {
  const ended = new Set(spans.filter(s => s.ended_at != null).map(s => s.id))
  const denied = new Set(
    events.filter(e => e.type === 'permission.resolved' && e.span_id && isDeniedOutcome(e.attrs)).map(e => e.span_id as string),
  )
  const out = new Map<string, PermStatus>()
  for (const e of events) {
    if (e.type !== 'permission.requested' || !e.span_id) continue
    out.set(e.span_id, denied.has(e.span_id) ? 'denied' : ended.has(e.span_id) ? 'allowed' : 'pending')
  }
  return out
}

export function eventDetail(attrs: string): string {
  let a: Record<string, unknown>
  try { a = JSON.parse(attrs) } catch { return '' }
  if (typeof a.preview === 'string' && a.preview) return a.preview
  if (typeof a.message === 'string' && a.message) return a.message
  if (typeof a.reason === 'string' && a.reason) return `${a.tool ?? ''}: ${a.reason}`
  if (typeof a.outcome === 'string' && a.outcome) return `${a.tool ?? ''}: ${a.outcome}`
  if (typeof a.trigger === 'string' && a.trigger) return `${a.trigger} compact at ${a.preTokens ?? '?'} tokens`
  return ''
}
