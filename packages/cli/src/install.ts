import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop', 'PermissionRequest', 'PermissionDenied'] as const
const NEEDS_MATCHER = new Set(['PreToolUse', 'PostToolUse'])

export function installHooks(claudeDir: string, hookCommand: string): { settingsPath: string; added: string[] } {
  mkdirSync(claudeDir, { recursive: true })
  const settingsPath = join(claudeDir, 'settings.json')
  let settings: any = {}
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    } catch {
      throw new Error(`0rrery install: ${settingsPath} is not valid JSON — fix or remove it, then re-run`)
    }
  }
  settings.hooks ??= {}
  const added: string[] = []
  for (const event of HOOK_EVENTS) {
    const entries: any[] = (settings.hooks[event] ??= [])
    const already = entries.some(e => e?.hooks?.some((h: any) => h?.command === hookCommand))
    if (already) continue
    const entry: any = { hooks: [{ type: 'command', command: hookCommand }] }
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*'
    entries.push(entry)
    added.push(event)
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  return { settingsPath, added }
}
