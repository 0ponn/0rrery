import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'
export type EffectiveStatus = 'active' | 'stale' | 'ended'
export type ApiSession = SessionRow & { effectiveStatus: EffectiveStatus }
export type SessionDetail = { session: ApiSession; spans: SpanRow[]; events: EventRow[] }
export type { SessionRow, SpanRow, EventRow }
