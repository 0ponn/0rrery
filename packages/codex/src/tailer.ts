import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importTranscript, loadOffsets, saveOffsets, type FileState } from '@0rrery/claude-code'
import { newCodexState, reviveCodexState, codexParser, type CodexState } from './codex'

export function startCodexTailer(rootDir: string, url: string, pollMs = 2000, offsetsPath?: string) {
  const files: Map<string, FileState<CodexState>> = offsetsPath ? loadOffsets(offsetsPath, reviveCodexState) : new Map()
  let stopped = false

  const pass = async () => {
    let dirty = false
    let entries: string[] = []
    try {
      entries = (readdirSync(rootDir, { recursive: true }) as string[]).filter(e => e.endsWith('.jsonl'))
    } catch { return }
    for (const rel of entries) {
      const path = join(rootDir, String(rel))
      try {
        let fs = files.get(path)
        if (!fs) { fs = { offset: 0, state: newCodexState() }; files.set(path, fs) }
        const size = statSync(path).size
        if (size < fs.offset) { fs.offset = 0; fs.state = newCodexState(); dirty = true }
        if (size > fs.offset) {
          const r = await importTranscript(path, url, fs.offset, fs.state, false, codexParser)
          if (r.bytesRead !== fs.offset) { fs.offset = r.bytesRead; dirty = true }
        }
      } catch {}
    }
    if (dirty && offsetsPath) saveOffsets(offsetsPath, files)
  }

  const loop = async () => { while (!stopped) { await pass(); await Bun.sleep(pollMs) } }
  loop()
  return { stop() { stopped = true } }
}
