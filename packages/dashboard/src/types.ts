import type { SessionRow, SpanRow, EventRow } from '@0rrery/schema'
export type SessionDetail = { session: SessionRow; spans: SpanRow[]; events: EventRow[] }
export type { SessionRow, SpanRow, EventRow }
