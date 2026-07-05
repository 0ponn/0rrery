import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { systemdUnit, launchdPlist, servicePath, runService } from '../src/service'

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
