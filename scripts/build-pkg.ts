#!/usr/bin/env bun
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const out = join(root, 'dist-pkg')

function run(argv: string[], cwd: string) {
  const r = Bun.spawnSync(argv, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) { console.error(`build-pkg: ${argv.join(' ')} failed`); process.exit(1) }
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

run(['bun', 'run', 'build'], root)  // dashboard vite build
run(['bun', 'build', 'packages/cli/src/index.ts', '--target', 'bun', '--outfile', join(out, 'index.js')], root)

// ensure executable entry with shebang
const entry = join(out, 'index.js')
const js = readFileSync(entry, 'utf8')
if (!js.startsWith('#!')) writeFileSync(entry, '#!/usr/bin/env bun\n' + js)
chmodSync(entry, 0o755)

cpSync(join(root, 'packages/dashboard/dist'), join(out, 'public'), { recursive: true })
cpSync(join(root, 'README.md'), join(out, 'README.md'))

writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: '0rrery',
  version: '0.1.0',
  description: 'Trace-first, local-first observability for AI agent workflows',
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/0ponn/0rrery' },
  bin: { '0rrery': './index.js' },
  engines: { bun: '>=1.1' },
  files: ['index.js', 'public', 'README.md'],
}, null, 2) + '\n')

console.log(`staged ${out}`)
