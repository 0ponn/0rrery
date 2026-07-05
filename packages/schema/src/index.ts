import { z } from 'zod'

export type SpanKind = 'agent' | 'tool' | 'llm' | 'mcp' | 'custom'

const attrs = z.record(z.unknown()).optional()
const ts = z.number().int().nonnegative()

const SessionStartSchema = z.object({
  op: z.literal('session.start'), sessionId: z.string().min(1),
  source: z.enum(['claude-code', 'api']), project: z.string().optional(),
  cwd: z.string().optional(), gitBranch: z.string().optional(), ts, meta: attrs,
}).strict()
const SessionEndSchema = z.object({ op: z.literal('session.end'), sessionId: z.string().min(1), ts }).strict()
const SpanStartSchema = z.object({
  op: z.literal('span.start'), id: z.string().min(1), sessionId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  kind: z.enum(['agent', 'tool', 'llm', 'mcp', 'custom']),
  name: z.string().min(1), ts, attrs,
}).strict()
const SpanEndSchema = z.object({
  op: z.literal('span.end'), id: z.string().min(1), ts, status: z.enum(['ok', 'error']), attrs,
}).strict()
const EventSchema = z.object({
  op: z.literal('event'), id: z.string().min(1), sessionId: z.string().min(1),
  spanId: z.string().nullable().optional(), type: z.string().min(1), ts, attrs,
}).strict()

export const IngestOpSchema = z.discriminatedUnion('op', [
  SessionStartSchema, SessionEndSchema, SpanStartSchema, SpanEndSchema, EventSchema,
])

export type SessionStartOp = z.infer<typeof SessionStartSchema>
export type SessionEndOp = z.infer<typeof SessionEndSchema>
export type SpanStartOp = z.infer<typeof SpanStartSchema>
export type SpanEndOp = z.infer<typeof SpanEndSchema>
export type EventOp = z.infer<typeof EventSchema>
export type IngestOp = z.infer<typeof IngestOpSchema>

export type Rejected = { index: number; error: string; raw: unknown }

export function parseOps(input: unknown): { ok: IngestOp[]; rejected: Rejected[] } {
  if (!Array.isArray(input)) return { ok: [], rejected: [{ index: 0, error: 'body must be a JSON array', raw: input }] }
  const ok: IngestOp[] = []
  const rejected: Rejected[] = []
  input.forEach((raw, index) => {
    const r = IngestOpSchema.safeParse(raw)
    if (r.success) ok.push(r.data)
    else rejected.push({ index, error: r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), raw })
  })
  return { ok, rejected }
}

export type SessionRow = { id: string; source: string; project: string | null; cwd: string | null; git_branch: string | null; started_at: number; last_event_at: number; status: 'active' | 'ended'; meta: string }
export type SpanRow = { id: string; session_id: string; parent_id: string | null; kind: SpanKind; name: string; started_at: number; ended_at: number | null; status: 'running' | 'ok' | 'error'; attrs: string }
export type EventRow = { id: string; session_id: string; span_id: string | null; ts: number; type: string; attrs: string }

export { mcpParts, isMcpTool, displayKind } from './names'
