import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function systemdUnit(execStart: string): string {
  return `[Unit]
Description=0rrery - trace-first observability for AI agent workflows

[Service]
ExecStart=${execStart}
Restart=on-failure

[Install]
WantedBy=default.target
`
}

const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

export function launchdPlist(args: string[]): string {
  const items = args.map(a => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.0pon.0rrery</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`
}

export function servicePath(platform: string = process.platform): string | null {
  if (platform === 'linux') return join(homedir(), '.config/systemd/user/0rrery.service')
  if (platform === 'darwin') return join(homedir(), 'Library/LaunchAgents/com.0pon.0rrery.plist')
  return null
}

export function resolveBin(): string[] {
  const onPath = Bun.which('0rrery')
  const entry = onPath ? realpathSync(onPath) : Bun.main
  return [process.execPath, entry]
}

function run(argv: string[]): boolean {
  const r = Bun.spawnSync(argv, { stdout: 'inherit', stderr: 'inherit' })
  return r.exitCode === 0
}

export function runService(
  sub: string,
  platform: string = process.platform,
  exec: (argv: string[]) => boolean = run,
  file: string | null = servicePath(platform),
): boolean {
  if (!file) {
    console.error('0rrery service: unsupported platform (linux and macOS only)')
    return false
  }
  const linux = platform === 'linux'
  if (sub === 'install') {
    const bin = resolveBin()
    if (!linux && existsSync(file)) exec(['launchctl', 'unload', '-w', file])
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, linux ? systemdUnit([...bin, 'serve'].join(' ')) : launchdPlist([...bin, 'serve']))
    const ok = linux
      ? exec(['systemctl', '--user', 'daemon-reload']) && exec(['systemctl', '--user', 'enable', '--now', '0rrery'])
      : exec(['launchctl', 'load', '-w', file])
    console.log(ok ? `service installed and started (${file})` : `wrote ${file} but starting failed — check the output above`)
    return ok
  }
  if (sub === 'uninstall') {
    if (!existsSync(file)) { console.log('no service installed'); return true }
    const ok = linux
      ? exec(['systemctl', '--user', 'disable', '--now', '0rrery'])
      : exec(['launchctl', 'unload', '-w', file])
    rmSync(file, { force: true })
    if (linux) exec(['systemctl', '--user', 'daemon-reload'])
    console.log(ok ? 'service stopped and removed' : `removed ${file}; stopping reported an error above`)
    return ok
  }
  if (sub === 'status') {
    return linux ? exec(['systemctl', '--user', 'status', '0rrery', '--no-pager']) : exec(['launchctl', 'list', 'com.0pon.0rrery'])
  }
  console.error('usage: 0rrery service <install|uninstall|status>')
  return false
}
