import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'
export type EffectiveStatus = 'active' | 'stale' | 'ended'
export type ApiSession = SessionRow & { effectiveStatus: EffectiveStatus }
export type SessionDetail = { session: ApiSession; spans: SpanRow[]; events: EventRow[] }
export type { SessionRow, SpanRow, EventRow }

export type FleetCard = {
  id: string; project: string | null
  started_at: number; last_event_at: number; idle_ms: number
  effective: 'active' | 'stale'
  current: { kind: string; name: string; running_ms: number } | null
  pending_permissions: Array<{ tool: string; waiting_ms: number }>
  tokens_in: number; tokens_out: number; est_cost: number | null
  stuck: boolean
}
