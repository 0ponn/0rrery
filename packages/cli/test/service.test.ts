import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemdUnit, launchdPlist, servicePath, runService, resolveBin } from '../src/service'

test('systemd unit content', () => {
  const u = systemdUnit('/home/dev/.bun/bin/0rrery serve')
  expect(u).toBe(`[Unit]
Description=0rrery - trace-first observability for AI agent workflows

[Service]
ExecStart=/home/dev/.bun/bin/0rrery serve
Restart=on-failure

[Install]
WantedBy=default.target
`)
})

test('launchd plist content', () => {
  const p = launchdPlist(['/Users/dev/.bun/bin/0rrery', 'serve'])
  expect(p).toContain('<key>Label</key><string>com.0pon.0rrery</string>')
  expect(p).toContain('    <string>/Users/dev/.bun/bin/0rrery</string>\n    <string>serve</string>')
  expect(p).toContain('<key>RunAtLoad</key><true/>')
  expect(p).toContain('<key>KeepAlive</key><true/>')
  expect(p.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
})

test('launchd plist XML-escapes args', () => {
  const p = launchdPlist(['/Users/a&b/.bun/bin/0rrery', 'serve'])
  expect(p).toContain('<string>/Users/a&amp;b/.bun/bin/0rrery</string>')
  expect(p).not.toContain('a&b')
})

test('service paths per platform', () => {
  expect(servicePath('linux')).toBe(join(homedir(), '.config/systemd/user/0rrery.service'))
  expect(servicePath('darwin')).toBe(join(homedir(), 'Library/LaunchAgents/com.0pon.0rrery.plist'))
  expect(servicePath('win32')).toBeNull()
})

test('darwin re-install unloads the existing agent first', () => {
  const claude = mkdtempSync(join(tmpdir(), '0rrery-svc-'))
  const file = join(claude, 'com.0pon.0rrery.plist')
  writeFileSync(file, 'old')
  const calls: string[][] = []
  const exec = (argv: string[]) => { calls.push(argv); return true }
  runService('install', 'darwin', exec, file)
  expect(calls[0].slice(0, 2)).toEqual(['launchctl', 'unload'])
  expect(calls[calls.length - 1].slice(0, 2)).toEqual(['launchctl', 'load'])

  const fresh = join(claude, 'none.plist')
  const calls2: string[][] = []
  runService('install', 'darwin', a => { calls2.push(a); return true }, fresh)
  expect(calls2.some(a => a[1] === 'unload')).toBe(false)
})

test('uninstall attempts stop/disable even when the unit file was hand-deleted', () => {
  const claude = mkdtempSync(join(tmpdir(), '0rrery-svc-'))
  const file = join(claude, 'gone.service')  // never written
  const calls: string[][] = []
  const exec = (argv: string[]) => { calls.push(argv); return true }
  const ok = runService('uninstall', 'linux', exec, file)
  expect(ok).toBe(true)
  expect(calls).toEqual([['systemctl', '--user', 'disable', '--now', '0rrery']])
})

test('uninstall on a live unit still removes the file and reports the result', () => {
  const claude = mkdtempSync(join(tmpdir(), '0rrery-svc-'))
  const file = join(claude, '0rrery.service')
  writeFileSync(file, 'unit')
  const ok = runService('uninstall', 'linux', () => true, file)
  expect(ok).toBe(true)
  expect(existsSync(file)).toBe(false)
})

test('status prints the dashboard URL after the passthrough call', () => {
  const logs: unknown[][] = []
  const origLog = console.log
  console.log = (...a: unknown[]) => { logs.push(a) }
  try {
    runService('status', 'linux', () => true, join(tmpdir(), 'unused.service'))
  } finally {
    console.log = origLog
  }
  expect(logs.some(l => l.join(' ').includes('dashboard: http://localhost:7317'))).toBe(true)
})

test('status honors ORRERY_PORT for the printed dashboard URL', () => {
  const logs: unknown[][] = []
  const origLog = console.log
  console.log = (...a: unknown[]) => { logs.push(a) }
  process.env.ORRERY_PORT = '9999'
  try {
    runService('status', 'linux', () => true, join(tmpdir(), 'unused.service'))
  } finally {
    console.log = origLog
    delete process.env.ORRERY_PORT
  }
  expect(logs.some(l => l.join(' ').includes('dashboard: http://localhost:9999'))).toBe(true)
})

test('resolveBin always names the interpreter absolutely (no shebang/PATH reliance)', () => {
  const bin = resolveBin()
  expect(bin.length).toBe(2)
  expect(bin[0].startsWith('/')).toBe(true)
  expect(bin[0]).toBe(process.execPath)
  expect(bin[1].startsWith('/')).toBe(true)
})
