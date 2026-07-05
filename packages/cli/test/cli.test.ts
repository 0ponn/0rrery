import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { importAll } from '../src/sweep'

const cli = resolve(import.meta.dir, '../src/index.ts')

test('hook subcommand is fail-open on garbage stdin and dead server', async () => {
  const p = Bun.spawn(['bun', cli, 'hook'], {
    stdin: new Blob(['not json']),
    env: { ...process.env, ORRERY_URL: 'http://127.0.0.1:1' },
  })
  expect(await p.exited).toBe(0)
})

test('importAll finds transcripts and reports failures against a dead server', async () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-sweep-'))
  mkdirSync(join(dir, 'proj-a'), { recursive: true })
  copyFileSync(resolve(import.meta.dir, '../../claude-code/fixtures/fix1.jsonl'), join(dir, 'proj-a', 'fix1.jsonl'))
  const r = await importAll(dir, 'http://127.0.0.1:1')
  expect(r.total).toBe(1)
  expect(r.ok).toBe(0)
  expect(r.failed).toBe(1)
})

test('importAll on an empty dir is a clean no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-sweep-'))
  const r = await importAll(dir, 'http://127.0.0.1:1')
  expect(r).toEqual({ ok: 0, failed: 0, total: 0 })
})

test('install writes an absolute, resolvable hook command', () => {
  const dir = mkdtempSync(join(tmpdir(), '0rrery-cli-'))
  const r = Bun.spawnSync(['bun', cli, 'install'], { env: { ...process.env, ORRERY_CLAUDE_DIR: dir } })
  expect(r.exitCode).toBe(0)
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  const cmd = s.hooks.PreToolUse.flatMap((e: any) => e.hooks)[0].command
  expect(cmd.endsWith(' hook')).toBe(true)
  const exe = cmd.slice(0, -' hook'.length).split(' ')[0]
  expect(exe.startsWith('/')).toBe(true)
  expect(existsSync(exe)).toBe(true)
})
