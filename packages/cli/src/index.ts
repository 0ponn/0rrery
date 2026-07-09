#!/usr/bin/env bun
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'
import { startTailer, importSession, mapHookEvent, emitOps, type HookInput } from '@0rrery/claude-code'
import { startCodexTailer, codexParser, newCodexState } from '@0rrery/codex'
import { installHooks } from './install'
import { importAll } from './sweep'
import { runService, resolveBin } from './service'
import { installSkill, skillSourceDir } from './skill'

const [cmd, arg] = process.argv.slice(2)
const url = process.env.ORRERY_URL ?? 'http://localhost:7317'
const claudeDir = () => process.env.ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude')
const codexDir = () => process.env.ORRERY_CODEX_DIR ?? join(homedir(), '.codex', 'sessions')

function sniffHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(400)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function runInstall(): boolean {
  if (!existsSync(claudeDir())) {
    console.warn(`${claudeDir()} not found — Claude Code not present, skipping hooks`)
    return false
  }
  const { settingsPath, added, removed } = installHooks(claudeDir(), [...resolveBin(), 'hook'].join(' '))
  const parts = []
  if (added.length) parts.push(`installed hooks (${added.join(', ')})`)
  if (removed) parts.push(`replaced ${removed} legacy entr${removed === 1 ? 'y' : 'ies'}`)
  console.log(parts.length ? `${parts.join(', ')} in ${settingsPath}` : `hooks already installed in ${settingsPath}`)
  return true
}

switch (cmd) {
  case 'serve': {
    const config = loadConfig()
    const srv = startServer(config)
    const projectsDir = join(claudeDir(), 'projects')
    const tailer = startTailer(projectsDir, srv.url, 2000, join(config.dataDir, 'tailer-offsets.json'))
    const cx = existsSync(codexDir())
      ? startCodexTailer(codexDir(), srv.url, 2000, join(config.dataDir, 'codex-offsets.json'))
      : null
    console.log(`0rrery serving on ${srv.url} (db: ${config.dbPath})`)
    console.log(`tailing ${projectsDir}`)
    if (cx) console.log(`tailing ${codexDir()} (codex)`)
    process.on('SIGINT', () => { tailer.stop(); cx?.stop(); srv.stop(); process.exit(0) })
    break
  }
  case 'hook': {
    try {
      const input = JSON.parse(await Bun.stdin.text()) as HookInput
      await emitOps(url, mapHookEvent(input))
    } catch {}
    process.exit(0)
    break
  }
  case 'install': {
    try {
      runInstall()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    break
  }
  case 'import': {
    if (!arg) { console.error('usage: 0rrery import <transcript.jsonl | --all>'); process.exit(1) }
    if (arg === '--all') {
      const projectsDir = join(claudeDir(), 'projects')
      const cxRoot = existsSync(codexDir()) ? codexDir() : undefined
      const r = await importAll(projectsDir, url, cxRoot)
      console.log(r.total ? `imported ${r.ok}/${r.total} transcript(s)` : `no transcripts found under ${projectsDir}`)
      process.exit(r.failed && !r.ok ? 1 : 0)
      break
    }
    let r
    try {
      const path = resolve(arg)
      const isCodex = /"type"\s*:\s*"session_meta"/.test(sniffHead(path))
      r = isCodex
        ? await importSession(path, url, { finalize: true, parser: codexParser, newState: newCodexState })
        : await importSession(path, url, { finalize: true })
    } catch (err) {
      console.error(`0rrery import: cannot read ${arg}: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
    console.log(r.emitted ? `imported ${r.ops} ops from ${r.files} file(s)` : `parse ok (${r.ops} ops) but server unreachable at ${url}`)
    process.exit(r.emitted ? 0 : 1)
    break
  }
  case 'service': {
    process.exit(runService(arg ?? '') ? 0 : 1)
    break
  }
  case 'init': {
    const KNOWN_INIT_FLAGS = new Set(['--no-hooks', '--no-service', '--no-import', '--no-skill'])
    const argv = process.argv.slice(3)
    const flags = new Set(argv)
    for (const f of argv) if (!KNOWN_INIT_FLAGS.has(f)) console.warn(`unknown flag: ${f}`)
    let failed = false
    if (!flags.has('--no-hooks')) {
      console.log('› hooks')
      try { runInstall() } catch (err) { console.error(err instanceof Error ? err.message : String(err)); failed = true }
    }
    if (!flags.has('--no-skill')) {
      console.log('› skill')
      const src = skillSourceDir()
      if (!existsSync(claudeDir())) console.log(`  ${claudeDir()} not found — skipping skill`)
      else if (!src) console.log('  skill assets not found — skipping')
      else console.log(`  installed ${installSkill(claudeDir(), src)}`)
    }
    if (!flags.has('--no-service')) {
      console.log('› service')
      if (!runService('install')) console.log('  (service setup failed or unsupported — run `0rrery serve` manually)')
    }
    if (!flags.has('--no-import')) {
      console.log('› importing history')
      const projectsDir = join(claudeDir(), 'projects')
      const cxRoot = existsSync(codexDir()) ? codexDir() : undefined
      if (existsSync(projectsDir) || cxRoot) {
        for (let i = 0; i < 30; i++) {
          if (await fetch(`${url}/api/sessions`).then(x => x.ok).catch(() => false)) break
          await Bun.sleep(200)
        }
        const r = await importAll(projectsDir, url, cxRoot)
        console.log(r.total ? `  imported ${r.ok}/${r.total} transcript(s)` : '  no transcripts found')
      } else {
        console.log(`  ${projectsDir} not found — nothing to import`)
      }
    }
    console.log(`0rrery ready — dashboard at ${url}`)
    process.exit(failed ? 1 : 0)
    break
  }
  default:
    console.log('usage: 0rrery <serve|init|install|hook|import <path|--all>|service <install|uninstall|status>>')
    process.exit(cmd ? 1 : 0)
}
