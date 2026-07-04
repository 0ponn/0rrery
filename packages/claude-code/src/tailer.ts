import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { importTranscript } from './importer'
import { newTranscriptState, type TranscriptState } from './transcript'

type FileState = { offset: number; state: TranscriptState }

export function startTailer(projectsDir: string, url: string, pollMs = 2000) {
  const files = new Map<string, FileState>()
  let stopped = false

  async function pass() {
    let dirs: string[] = []
    try { dirs = readdirSync(projectsDir) } catch { return }
    for (const d of dirs) {
      const dir = join(projectsDir, d)
      let entries: string[] = []
      try { entries = readdirSync(dir).filter(f => f.endsWith('.jsonl')) } catch { continue }
      for (const f of entries) {
        const path = join(dir, f)
        let fs = files.get(path)
        if (!fs) { fs = { offset: 0, state: newTranscriptState() }; files.set(path, fs) }
        try {
          if (statSync(path).size > fs.offset) {
            const r = await importTranscript(path, url, fs.offset, fs.state)
            fs.offset = r.bytesRead
          }
        } catch {}
      }
    }
  }

  const loop = async () => {
    while (!stopped) { await pass(); await Bun.sleep(pollMs) }
  }
  loop()
  return { stop() { stopped = true } }
}
