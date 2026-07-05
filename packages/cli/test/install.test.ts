import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../src/install'

test('creates settings.json with all seven hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  const { settingsPath, added } = installHooks(dir, 'bun /x/hook.ts')
  expect(added).toHaveLength(9)
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
  expect(s.hooks.PreToolUse[0]).toEqual({ matcher: '*', hooks: [{ type: 'command', command: 'bun /x/hook.ts' }] })
  expect(s.hooks.SessionStart[0]).toEqual({ hooks: [{ type: 'command', command: 'bun /x/hook.ts' }] })
})

test('is idempotent and preserves unrelated settings', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    model: 'opus',
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-hook' }] }] },
  }))
  installHooks(dir, 'bun /x/hook.ts')
  const { added } = installHooks(dir, 'bun /x/hook.ts')  // second run
  expect(added).toHaveLength(0)
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  expect(s.model).toBe('opus')
  expect(s.hooks.PreToolUse).toHaveLength(2)  // other-hook entry + ours, no duplicates
})

test('corrupt settings.json produces a clean error', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  writeFileSync(join(dir, 'settings.json'), '{ not json')
  expect(() => installHooks(dir, 'bun /x/hook.ts')).toThrow(/not valid JSON/)
})

test('re-running install on a v1 settings file adds only the two new permission hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  const V1_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']
  const hooks: any = {}
  for (const e of V1_EVENTS) hooks[e] = [{ ...(e.endsWith('ToolUse') ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: 'bun /x/hook.ts' }] }]
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks }))
  const { added } = installHooks(dir, 'bun /x/hook.ts')
  expect(added.sort()).toEqual(['PermissionDenied', 'PermissionRequest'])
})

test('replaces legacy 0rrery hook entries instead of stacking', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  installHooks(dir, 'bun /home/dev/Documents/0pon/commercial/0rrery/packages/claude-code/src/hook.ts')
  const { removed } = installHooks(dir, '0rrery hook')
  expect(removed).toBeGreaterThan(0)
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  for (const entries of Object.values(s.hooks) as any[]) {
    const ours = entries.flatMap((e: any) => e.hooks ?? []).filter((h: any) => h.command.includes('0rrery'))
    expect(ours).toHaveLength(1)
    expect(ours[0].command).toBe('0rrery hook')
  }
})

test('leaves non-0rrery hooks alone and re-run removes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'rtk notify' }] }] } }))
  installHooks(dir, '0rrery hook')
  const again = installHooks(dir, '0rrery hook')
  expect(again.removed).toBe(0)
  expect(again.added).toHaveLength(0)
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  expect(s.hooks.Stop.some((e: any) => e.hooks.some((h: any) => h.command === 'rtk notify'))).toBe(true)
})
