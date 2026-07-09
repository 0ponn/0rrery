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

// Executable entry: sh/JS polyglot header. The kernel runs the file under
// /bin/sh, which checks for bun and execs it (or fails with a clear message);
// bun reads the same two lines as string statements with trailing comments.
// A plain `#!/usr/bin/env bun` shebang dies before any code runs when Bun is
// missing, and npm does not enforce engines.bun at install time.
const launcher = [
  '#!/bin/sh',
  `':' //; command -v bun >/dev/null 2>&1 || { echo "0rrery runs on Bun (>= 1.1), and bun was not found on your PATH." >&2; echo "Install it from https://bun.sh then re-run this command." >&2; exit 1; }`,
  `':' //; exec bun "$0" "$@"`,
  '',
].join('\n')
const entry = join(out, 'index.js')
const js = readFileSync(entry, 'utf8')
writeFileSync(entry, launcher + js.replace(/^#![^\n]*\n/, ''))
chmodSync(entry, 0o755)

cpSync(join(root, 'packages/dashboard/dist'), join(out, 'public'), { recursive: true })
cpSync(join(root, 'README.md'), join(out, 'README.md'))
cpSync(join(root, 'packages/cli/skill'), join(out, 'skill'), { recursive: true })

writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: '0rrery',
  version: '0.1.2',
  description: 'Trace-first, local-first observability for AI agent workflows',
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/0ponn/0rrery' },
  bin: { '0rrery': './index.js' },
  engines: { bun: '>=1.1' },
  files: ['index.js', 'public', 'skill', 'README.md'],
}, null, 2) + '\n')

console.log(`staged ${out}`)
