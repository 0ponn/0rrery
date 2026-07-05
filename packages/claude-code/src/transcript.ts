import type { IngestOp } from '@0rrery/schema'
import { isMcpTool } from '@0rrery/schema'

export type TranscriptState = {
  sessionStarted: boolean
  agentStarted: boolean
  agentNamed: boolean
  agentId: string | null
  agentFirstTs: number | null
  agentToolUseIds: Set<string>
}
export function newTranscriptState(): TranscriptState {
  return { sessionStarted: false, agentStarted: false, agentNamed: false, agentId: null, agentFirstTs: null, agentToolUseIds: new Set() }
}

type Line = {
  type?: string; sessionId?: string; cwd?: string; gitBranch?: string; timestamp?: string
  uuid?: string; isSidechain?: boolean; agentId?: string; attributionAgent?: string
  subtype?: string; compactMetadata?: Record<string, unknown>; isCompactSummary?: boolean
  message?: { id?: string; model?: string; role?: string; content?: unknown; usage?: Record<string, number> }
}

export function parseTranscriptLine(raw: string, state: TranscriptState): IngestOp[] {
  let line: Line
  try { line = JSON.parse(raw) } catch { return [] }
  const ops: IngestOp[] = []
  const parsed = line.timestamp ? Date.parse(line.timestamp) : NaN
  const ts = Number.isNaN(parsed) ? Date.now() : parsed
  const sid = line.sessionId
  if (!sid) return []

  const agentId = line.agentId ?? state.agentId

  if (line.agentId) {
    state.agentId = line.agentId
    state.agentFirstTs ??= ts
    // emit once unnamed, then once more on first name
    if (!state.agentStarted || (!state.agentNamed && line.attributionAgent)) {
      state.agentStarted = true
      if (line.attributionAgent) state.agentNamed = true
      ops.push({
        op: 'span.start', id: `agent:${line.agentId}`, sessionId: sid, parentId: null, kind: 'agent',
        name: line.attributionAgent || '(unknown)', ts: state.agentFirstTs, attrs: {},
      })
    }
  } else if (!state.agentId && !state.sessionStarted && line.cwd) {
    state.sessionStarted = true
    ops.push({
      op: 'session.start', sessionId: sid, source: 'claude-code',
      project: line.cwd.split('/').pop(), cwd: line.cwd, gitBranch: line.gitBranch, ts,
    })
  }

  const side = line.isSidechain ? { sidechain: true } : {}
  const agentAttr = agentId ? { agentId } : {}

  if (line.type === 'user' && typeof line.message?.content === 'string') {
    ops.push({
      op: 'event', id: `evt:msg:${line.uuid}`, sessionId: sid,
      type: line.isCompactSummary ? 'session.compact_summary' : 'message.user', ts,
      attrs: { preview: line.message.content.slice(0, 200), ...side, ...agentAttr },
    })
  }

  if (line.type === 'user' && Array.isArray(line.message?.content)) {
    for (const block of line.message.content as any[]) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue
      if (!state.agentToolUseIds.has(block.tool_use_id)) continue
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      const m = text.match(/agentId: (a[0-9a-f]{6,})/)
      if (m) {
        ops.push({
          op: 'span.start', id: `agent:${m[1]}`, sessionId: sid, parentId: `tool:${block.tool_use_id}`,
          kind: 'agent', name: '(unknown)', ts, attrs: {},
        })
      }
    }
  }

  if (line.type === 'assistant' && line.message?.id) {
    const m = line.message
    const u = m.usage ?? {}
    ops.push({
      op: 'span.start', id: `llm:${m.id}`, sessionId: sid, parentId: agentId ? `agent:${agentId}` : null, kind: 'llm',
      name: m.model ?? '(model)', ts,
      attrs: {
        input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, ...side,
      },
    })
    ops.push({ op: 'span.end', id: `llm:${m.id}`, ts, status: 'ok' })
    const content = Array.isArray(m.content) ? m.content : []
    content.forEach((block: any, i: number) => {
      if (block?.type === 'tool_use') {
        if (block.name === 'Agent' || block.name === 'Task') state.agentToolUseIds.add(block.id)
        ops.push({
          op: 'span.start', id: `tool:${block.id}`, sessionId: sid, parentId: `llm:${m.id}`,
          kind: isMcpTool(block.name ?? '') ? 'mcp' : 'tool', name: block.name ?? '(tool)', ts, attrs: { input: block.input ?? null, ...side },
        })
      } else if (block?.type === 'text' && block.text?.trim()) {
        ops.push({
          op: 'event', id: `evt:msg:${m.id}:${i}`, sessionId: sid, type: 'message.assistant', ts,
          attrs: { preview: block.text.slice(0, 200), ...side, ...agentAttr },
        })
      }
    })
  }

  if (line.type === 'system' && line.subtype === 'compact_boundary') {
    const md = (line.compactMetadata ?? {}) as Record<string, unknown>
    ops.push({
      op: 'event', id: `evt:compact:${line.uuid ?? `${sid}:${ts}`}`, sessionId: sid, type: 'session.compact', ts,
      attrs: { trigger: md.trigger ?? '', preTokens: md.preTokens ?? 0, durationMs: md.durationMs ?? 0 },
    })
  }

  return ops
}
