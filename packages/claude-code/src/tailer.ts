import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importTranscript } from './importer'
import { newTranscriptState } from './transcript'
import { loadOffsets, saveOffsets, type FileState } from './offsets'

export function startTailer(projectsDir: string, url: string, pollMs = 2000, offsetsPath?: string) {
  const files: Map<string, FileState> = offsetsPath ? loadOffsets(offsetsPath) : new Map()
  let stopped = false
  let dirty = false

  async function scanFile(path: string) {
    let fs = files.get(path)
    if (!fs) { fs = { offset: 0, state: newTranscriptState() }; files.set(path, fs) }
    try {
      const size = statSync(path).size
      if (size < fs.offset) {
        // truncated/rotated: start over on this file
        fs.offset = 0
        fs.state = newTranscriptState()
      }
      if (size > fs.offset) {
        const r = await importTranscript(path, url, fs.offset, fs.state)
        if (r.bytesRead !== fs.offset) dirty = true
        fs.offset = r.bytesRead
      }
    } catch {}
  }

  async function pass() {
    let dirs: string[] = []
    try { dirs = readdirSync(projectsDir) } catch { return }
    for (const d of dirs) {
      const dir = join(projectsDir, d)
      let entries: import('node:fs').Dirent[] = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          await scanFile(join(dir, e.name))
        } else if (e.isDirectory()) {
          const subDir = join(dir, e.name, 'subagents')
          let subs: string[] = []
          try { subs = readdirSync(subDir).filter(f => f.endsWith('.jsonl')) } catch { continue }
          for (const f of subs) await scanFile(join(subDir, f))
        }
      }
    }
    if (dirty && offsetsPath) {
      saveOffsets(offsetsPath, files)
      dirty = false
    }
  }

  const loop = async () => {
    while (!stopped) { await pass(); await Bun.sleep(pollMs) }
  }
  loop()
  return { stop() { stopped = true } }
}
