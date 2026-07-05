import { test, expect } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { systemdUnit, launchdPlist, servicePath } from '../src/service'

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
