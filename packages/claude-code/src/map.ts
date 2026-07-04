import type { IngestOp } from '@0rrery/schema'

export type HookInput = {
  hook_event_name: string; session_id: string; cwd?: string; transcript_path?: string
  tool_name?: string; tool_input?: unknown; tool_response?: unknown; tool_use_id?: string
  message?: string; [k: string]: unknown
}

function toolSpanId(input: HookInput, now: number): string {
  return input.tool_use_id ? `tool:${input.tool_use_id}` : `tool:${input.session_id}:${input.tool_name}:${now}`
}

export function mapHookEvent(input: HookInput, now: number = Date.now()): IngestOp[] {
  const sid = input.session_id
  switch (input.hook_event_name) {
    case 'SessionStart':
      return [{ op: 'session.start', sessionId: sid, source: 'claude-code', project: input.cwd?.split('/').pop(), cwd: input.cwd, ts: now }]
    case 'SessionEnd':
      return [{ op: 'session.end', sessionId: sid, ts: now }]
    case 'PreToolUse':
      return [{ op: 'span.start', id: toolSpanId(input, now), sessionId: sid, parentId: null, kind: 'tool', name: input.tool_name ?? '(tool)', ts: now, attrs: { input: input.tool_input ?? null } }]
    case 'PostToolUse': {
      const r = input.tool_response as { is_error?: boolean } | undefined
      return [{ op: 'span.end', id: toolSpanId(input, now), ts: now, status: r?.is_error ? 'error' : 'ok' }]
    }
    case 'Notification':
      return [{ op: 'event', id: `evt:${sid}:notification:${now}`, sessionId: sid, type: 'notification', ts: now, attrs: { message: input.message ?? '' } }]
    case 'Stop':
      return [{ op: 'event', id: `evt:${sid}:stop:${now}`, sessionId: sid, type: 'turn.stop', ts: now, attrs: {} }]
    case 'SubagentStop':
      return [{ op: 'event', id: `evt:${sid}:substop:${now}`, sessionId: sid, type: 'agent.subagent_stop', ts: now, attrs: {} }]
    default:
      return []
  }
}
