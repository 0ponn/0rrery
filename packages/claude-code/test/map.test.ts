import { test, expect } from 'bun:test'
import { mapHookEvent } from '../src/map'

test('SessionStart → session.start', () => {
  const ops = mapHookEvent({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/home/x/proj' }, 500)
  expect(ops).toEqual([{ op: 'session.start', sessionId: 's1', source: 'claude-code', project: 'proj', cwd: '/home/x/proj', ts: 500 }])
})

test('PreToolUse/PostToolUse pair to one span via tool_use_id', () => {
  const pre = mapHookEvent({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' } }, 500)
  expect(pre).toEqual([{ op: 'span.start', id: 'tool:tu1', sessionId: 's1', parentId: null, kind: 'tool', name: 'Bash', ts: 500, attrs: { input: { command: 'ls' } } }])
  const post = mapHookEvent({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'tu1', tool_response: { ok: true } }, 600)
  expect(post).toEqual([{ op: 'span.end', id: 'tool:tu1', ts: 600, status: 'ok' }])
})

test('Notification → event; SessionEnd → session.end; unknown → []', () => {
  expect(mapHookEvent({ hook_event_name: 'Notification', session_id: 's1', message: 'needs permission' }, 5)[0])
    .toMatchObject({ op: 'event', type: 'notification', attrs: { message: 'needs permission' } })
  expect(mapHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1' }, 9)).toEqual([{ op: 'session.end', sessionId: 's1', ts: 9 }])
  expect(mapHookEvent({ hook_event_name: 'SomethingNew', session_id: 's1' }, 9)).toEqual([])
})

test('Stop and SubagentStop map to events', () => {
  expect(mapHookEvent({ hook_event_name: 'Stop', session_id: 's1' }, 7)[0]).toMatchObject({ op: 'event', type: 'turn.stop' })
  expect(mapHookEvent({ hook_event_name: 'SubagentStop', session_id: 's1' }, 8)[0]).toMatchObject({ op: 'event', type: 'agent.subagent_stop' })
})
