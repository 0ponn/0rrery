import { test, expect } from 'bun:test'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

test('npm pack artifact installs globally and serves the dashboard', async () => {
  let r = Bun.spawnSync(['bun', 'scripts/build-pkg.ts'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  expect(r.exitCode).toBe(0)

  const packDest = mkdtempSync(join(tmpdir(), '0rrery-pack-'))
  r = Bun.spawnSync(['npm', 'pack', '--pack-destination', packDest], { cwd: join(root, 'dist-pkg') })
  expect(r.exitCode).toBe(0)
  const tarball = join(packDest, '0rrery-0.1.0.tgz')
  expect(existsSync(tarball)).toBe(true)

  const prefix = mkdtempSync(join(tmpdir(), '0rrery-prefix-'))
  // Stop bun's upward package.json walk at the prefix: without this, bun install -g
  // records the tarball in the nearest ancestor package.json (the user's real global
  // manifest when tmpdir lives under $HOME), which flakes reruns with DependencyLoop.
  writeFileSync(join(prefix, 'package.json'), '{}\n')
  r = Bun.spawnSync(['bun', 'install', '-g', tarball], { cwd: prefix, env: { ...process.env, BUN_INSTALL: prefix, HOME: prefix } })
  expect(r.exitCode).toBe(0)
  const bin = join(prefix, 'bin', '0rrery')
  expect(existsSync(bin)).toBe(true)
  const { realpathSync } = await import('node:fs')
  const pkgDir = join(realpathSync(bin), '..')
  expect(existsSync(join(pkgDir, 'skill', 'SKILL.md'))).toBe(true)

  const scratch = mkdtempSync(join(tmpdir(), '0rrery-data-'))
  const proc = Bun.spawn([bin, 'serve'], {
    cwd: prefix,
    env: {
      ...process.env, BUN_INSTALL: prefix, HOME: prefix,
      ORRERY_PORT: '7411', ORRERY_DATA_DIR: scratch, ORRERY_DB: join(scratch, 't.db'), ORRERY_CLAUDE_DIR: scratch,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  try {
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      await Bun.sleep(100)
      up = await fetch('http://127.0.0.1:7411/api/sessions').then(x => x.ok).catch(() => false)
    }
    expect(up).toBe(true)
    const home = await fetch('http://127.0.0.1:7411/')
    expect(home.status).toBe(200)
    expect(await home.text()).toContain('<div id=')
  } finally {
    proc.kill()
    await proc.exited
  }
}, 120000)
