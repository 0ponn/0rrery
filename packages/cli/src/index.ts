#!/usr/bin/env bun
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { startServer, loadConfig } from '@0rrery/server'
import { startTailer, importTranscript } from '@0rrery/claude-code'
import { installHooks } from './install'

const [cmd, arg] = process.argv.slice(2)
const url = process.env.ORRERY_URL ?? 'http://localhost:7317'

switch (cmd) {
  case 'serve': {
    const config = loadConfig()
    const srv = startServer(config)
    const projectsDir = join(process.env.ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude'), 'projects')
    const tailer = startTailer(projectsDir, srv.url)
    console.log(`0rrery serving on ${srv.url} (db: ${config.dbPath})`)
    console.log(`tailing ${projectsDir}`)
    process.on('SIGINT', () => { tailer.stop(); srv.stop(); process.exit(0) })
    break
  }
  case 'install': {
    const hookPath = resolve(import.meta.dir, '../../claude-code/src/hook.ts')
    const claudeDir = process.env.ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude')
    const { settingsPath, added } = installHooks(claudeDir, `bun ${hookPath}`)
    console.log(added.length ? `installed hooks (${added.join(', ')}) in ${settingsPath}` : `hooks already installed in ${settingsPath}`)
    break
  }
  case 'import': {
    if (!arg) { console.error('usage: 0rrery import <transcript.jsonl>'); process.exit(1) }
    const r = await importTranscript(resolve(arg), url)
    console.log(r.emitted ? `imported ${r.ops} ops from ${arg}` : `parse ok (${r.ops} ops) but server unreachable at ${url}`)
    process.exit(r.emitted ? 0 : 1)
    break
  }
  default:
    console.log('usage: 0rrery <serve|install|import <path>>')
    process.exit(cmd ? 1 : 0)
}
