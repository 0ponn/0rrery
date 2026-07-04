import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks } from '../src/install'

test('creates settings.json with all seven hooks', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  const { settingsPath, added } = installHooks(dir, 'bun /x/hook.ts')
  expect(added).toHaveLength(7)
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
