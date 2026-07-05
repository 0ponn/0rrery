import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'

const root = resolve(import.meta.dir, '..')

test('init --no-service installs hooks and imports history', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), '0rrery-init-'))
  mkdirSync(join(claudeDir, 'projects', 'proj-a'), { recursive: true })
  copyFileSync(join(root, 'packages/claude-code/fixtures/fix1.jsonl'), join(claudeDir, 'projects', 'proj-a', 'fix1.jsonl'))
  const scratch = mkdtempSync(join(tmpdir(), '0rrery-init-data-'))
  const srv = startServer(loadConfig({ port: 7413, dataDir: scratch, dbPath: join(scratch, 't.db'), dashboardDist: null }))
  try {
    // Bun.spawnSync would block this process's event loop entirely (verified: timers
    // don't fire during a spawnSync wait), starving the in-process server this test
    // just started and deadlocking the child's readiness-wait fetch. Use async spawn
    // so the server can keep servicing requests while we wait for the child to exit.
    const proc = Bun.spawn(['bun', 'packages/cli/src/index.ts', 'init', '--no-service'], {
      cwd: root,
      env: { ...process.env, ORRERY_CLAUDE_DIR: claudeDir, ORRERY_URL: 'http://127.0.0.1:7413' },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
    expect(settings.hooks.PreToolUse.some((e: any) => e.hooks.some((h: any) => h.command.endsWith(' hook') && h.command.includes('0rrery')))).toBe(true)
    expect(existsSync(join(claudeDir, 'skills', '0rrery', 'SKILL.md'))).toBe(true)
    const sessions = await fetch('http://127.0.0.1:7413/api/sessions').then(x => x.json()) as any[]
    expect(sessions.some(s => s.id === 'fix1')).toBe(true)
  } finally {
    srv.stop()
  }
}, 30000)
