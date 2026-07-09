import type { IngestOp } from '@0rrery/schema'
import { isMcpTool } from '@0rrery/schema'

export type CodexState = {
  sessionId: string | null; project: string | null; model: string | null
  openTurnId: string | null; turnIn: number; turnOut: number
}

export function newCodexState(): CodexState {
  return { sessionId: null, project: null, model: null, openTurnId: null, turnIn: 0, turnOut: 0 }
}

export function reviveCodexState(json: unknown): CodexState {
  const fresh = newCodexState()
  if (typeof json !== 'object' || json === null) return fresh
  const j = json as any
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // any malformed field resets the whole state (parser correctness over partial recovery)
  if (j.sessionId !== null && typeof j.sessionId !== 'string') return fresh
  return {
    sessionId: str(j.sessionId), project: str(j.project), model: str(j.model),
    openTurnId: str(j.openTurnId), turnIn: num(j.turnIn), turnOut: num(j.turnOut),
  }
}

const preview = (s: string) => s.slice(0, 200)

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => c?.text ?? '').join('').trim()
}

export function parseCodexLine(raw: string, state: CodexState): IngestOp[] {
  let line: any
  try { line = JSON.parse(raw) } catch { return [] }
  if (typeof line !== 'object' || line === null) return []
  const ts = Date.parse(line.timestamp) || Date.now()
  const p = line.payload
  if (typeof p !== 'object' || p === null) return []

  if (line.type === 'session_meta') {
    state.sessionId = typeof p.session_id === 'string' ? p.session_id : null
    if (!state.sessionId) return []
    state.project = typeof p.cwd === 'string' ? p.cwd.split('/').pop() ?? null : null
    state.model = typeof p.model_provider === 'string' ? p.model_provider : null
    return [{
      op: 'session.start', sessionId: state.sessionId, source: 'codex', ts,
      project: state.project ?? undefined,
      meta: { model_provider: p.model_provider, cli_version: p.cli_version, originator: p.originator },
    }]
  }

  const sid = state.sessionId
  if (!sid) return []  // pre-meta lines dropped
  const ops: IngestOp[] = []

  const closeTurn = (endTs: number) => {
    if (!state.openTurnId) return
    ops.push({ op: 'span.end', id: `llm:${state.openTurnId}`, ts: endTs, status: 'ok' })
    state.openTurnId = null
    state.turnIn = 0
    state.turnOut = 0
  }

  if (line.type === 'turn_context') {
    closeTurn(ts)
    const turnId = typeof p.turn_id === 'string' ? p.turn_id : null
    if (typeof p.model === 'string') state.model = p.model
    if (turnId) {
      state.openTurnId = turnId
      ops.push({
        op: 'span.start', id: `llm:${turnId}`, sessionId: sid, parentId: null,
        kind: 'llm', name: state.model ?? '(model)', ts, attrs: {},
      })
      ops.push({ op: 'event', id: `evt:turn:${turnId}`, sessionId: sid, type: 'turn.context', ts, attrs: {} })
    }
    return ops
  }

  if (line.type === 'event_msg') {
    if (p.type === 'task_complete') {
      closeTurn(ts)
      ops.push({ op: 'event', id: `evt:stop:${sid}:${ts}`, sessionId: sid, type: 'turn.stop', ts, attrs: {} })
      return ops
    }
    if (p.type === 'token_count' && p.info && typeof p.info === 'object' && state.openTurnId) {
      const u = p.info.last_token_usage
      if (u && typeof u === 'object') {
        state.turnIn += u.input_tokens ?? 0
        state.turnOut += u.output_tokens ?? 0
        ops.push({
          op: 'span.start', id: `llm:${state.openTurnId}`, sessionId: sid, parentId: null,
          kind: 'llm', name: state.model ?? '(model)', ts,
          attrs: { input_tokens: state.turnIn, output_tokens: state.turnOut },
        })
      }
      return ops
    }
    return []  // user_message/agent_message duplicates, task_started, rate-limit-only counts
  }

  if (line.type === 'response_item') {
    if (p.type === 'function_call' && typeof p.call_id === 'string') {
      let input: unknown = p.arguments
      try { input = JSON.parse(p.arguments) } catch {}
      const name = typeof p.name === 'string' ? p.name : '(tool)'
      return [{
        op: 'span.start', id: `tool:${p.call_id}`, sessionId: sid,
        parentId: state.openTurnId ? `llm:${state.openTurnId}` : null,
        kind: isMcpTool(name) ? 'mcp' : 'tool', name, ts, attrs: { input },
      }]
    }
    if (p.type === 'function_call_output' && typeof p.call_id === 'string') {
      const out = typeof p.output === 'string' ? p.output : ''
      const status = /exited with code [1-9]/.test(out) ? 'error' : 'ok'
      return [{ op: 'span.end', id: `tool:${p.call_id}`, ts, status, attrs: {} }]
    }
    if (p.type === 'web_search_call' && typeof p.id === 'string') {
      return [
        {
          op: 'span.start', id: `tool:${p.id}`, sessionId: sid,
          parentId: state.openTurnId ? `llm:${state.openTurnId}` : null,
          kind: 'tool', name: 'web_search', ts, attrs: { input: { query: p.action?.query ?? '' } },
        },
        { op: 'span.end', id: `tool:${p.id}`, ts, status: 'ok', attrs: {} },
      ]
    }
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = messageText(p.content)
      if (!text) return []
      return [{
        op: 'event', id: `evt:msg:${sid}:${ts}:${p.role}`, sessionId: sid,
        type: p.role === 'user' ? 'message.user' : 'message.assistant', ts,
        attrs: { preview: preview(text) },
      }]
    }
    return []  // reasoning, developer/system messages, everything else
  }

  return []  // unknown top-level types
}
