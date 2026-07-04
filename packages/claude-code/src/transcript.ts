import type { IngestOp } from '@0rrery/schema'

export type TranscriptState = { sessionStarted: boolean }
export function newTranscriptState(): TranscriptState { return { sessionStarted: false } }

type Line = {
  type?: string; sessionId?: string; cwd?: string; gitBranch?: string; timestamp?: string
  uuid?: string; isSidechain?: boolean
  message?: { id?: string; model?: string; role?: string; content?: unknown; usage?: Record<string, number> }
}

export function parseTranscriptLine(raw: string, state: TranscriptState): IngestOp[] {
  let line: Line
  try { line = JSON.parse(raw) } catch { return [] }
  const ops: IngestOp[] = []
  const ts = line.timestamp ? Date.parse(line.timestamp) : Date.now()
  const sid = line.sessionId
  if (!sid) return []

  if (!state.sessionStarted && line.cwd) {
    state.sessionStarted = true
    ops.push({
      op: 'session.start', sessionId: sid, source: 'claude-code',
      project: line.cwd.split('/').pop(), cwd: line.cwd, gitBranch: line.gitBranch, ts,
    })
  }

  const side = line.isSidechain ? { sidechain: true } : {}

  if (line.type === 'user' && typeof line.message?.content === 'string') {
    ops.push({
      op: 'event', id: `evt:msg:${line.uuid}`, sessionId: sid, type: 'message.user', ts,
      attrs: { preview: line.message.content.slice(0, 200), ...side },
    })
  }

  if (line.type === 'assistant' && line.message?.id) {
    const m = line.message
    const u = m.usage ?? {}
    ops.push({
      op: 'span.start', id: `llm:${m.id}`, sessionId: sid, parentId: null, kind: 'llm',
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
        ops.push({
          op: 'span.start', id: `tool:${block.id}`, sessionId: sid, parentId: `llm:${m.id}`,
          kind: 'tool', name: block.name ?? '(tool)', ts, attrs: { input: block.input ?? null, ...side },
        })
      } else if (block?.type === 'text' && block.text?.trim()) {
        ops.push({
          op: 'event', id: `evt:msg:${m.id}:${i}`, sessionId: sid, type: 'message.assistant', ts,
          attrs: { preview: block.text.slice(0, 200), ...side },
        })
      }
    })
  }

  return ops
}
