#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'
import { startTailer, importSession, mapHookEvent, emitOps, type HookInput } from '@0rrery/claude-code'
import { installHooks } from './install'
import { importAll } from './sweep'
import { runService } from './service'

const [cmd, arg] = process.argv.slice(2)
const url = process.env.ORRERY_URL ?? 'http://localhost:7317'
const claudeDir = () => process.env.ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude')

function runInstall(): boolean {
  if (!existsSync(claudeDir())) {
    console.warn(`${claudeDir()} not found — Claude Code not present, skipping hooks`)
    return false
  }
  const { settingsPath, added, removed } = installHooks(claudeDir(), '0rrery hook')
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
    console.log(`0rrery serving on ${srv.url} (db: ${config.dbPath})`)
    console.log(`tailing ${projectsDir}`)
    process.on('SIGINT', () => { tailer.stop(); srv.stop(); process.exit(0) })
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
      const r = await importAll(projectsDir, url)
      console.log(r.total ? `imported ${r.ok}/${r.total} transcript(s)` : `no transcripts found under ${projectsDir}`)
      process.exit(r.failed && !r.ok ? 1 : 0)
      break
    }
    let r
    try {
      r = await importSession(resolve(arg), url, { finalize: true })
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
  default:
    console.log('usage: 0rrery <serve|init|install|hook|import <path|--all>|service <install|uninstall|status>>')
    process.exit(cmd ? 1 : 0)
}
