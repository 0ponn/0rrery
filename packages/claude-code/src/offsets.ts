import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { newTranscriptState, type TranscriptState } from './transcript'

export type FileState = { offset: number; state: TranscriptState }

const VERSION = 1

export function reviveState(json: unknown): TranscriptState {
  const fresh = newTranscriptState()
  if (typeof json !== 'object' || json === null) return fresh
  const j = json as Record<string, unknown>
  return {
    sessionStarted: typeof j.sessionStarted === 'boolean' ? j.sessionStarted : fresh.sessionStarted,
    agentStarted: typeof j.agentStarted === 'boolean' ? j.agentStarted : fresh.agentStarted,
    agentNamed: typeof j.agentNamed === 'boolean' ? j.agentNamed : fresh.agentNamed,
    agentId: typeof j.agentId === 'string' ? j.agentId : fresh.agentId,
    agentFirstTs: typeof j.agentFirstTs === 'number' ? j.agentFirstTs : fresh.agentFirstTs,
    agentToolUseIds: Array.isArray(j.agentToolUseIds) ? new Set(j.agentToolUseIds.filter(x => typeof x === 'string')) : fresh.agentToolUseIds,
  }
}

export function loadOffsets(path: string): Map<string, FileState> {
  const out = new Map<string, FileState>()
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return out }  // missing file: silent
  try {
    const snap = JSON.parse(raw)
    if (snap?.version !== VERSION || typeof snap.files !== 'object' || snap.files === null) return out
    for (const [file, entry] of Object.entries(snap.files as Record<string, any>)) {
      if (!existsSync(file)) continue  // prune dead files
      const offset = typeof entry?.offset === 'number' && entry.offset >= 0 ? entry.offset : 0
      out.set(file, { offset, state: reviveState(entry?.state) })
    }
  } catch (e) {
    console.error('0rrery: tailer offsets snapshot corrupt, starting fresh', e)
    return new Map()
  }
  return out
}

export function saveOffsets(path: string, files: Map<string, FileState>): void {
  try {
    const filesJson: Record<string, unknown> = {}
    for (const [file, { offset, state }] of files) {
      filesJson[file] = { offset, state: { ...state, agentToolUseIds: [...state.agentToolUseIds] } }
    }
    writeFileSync(path + '.tmp', JSON.stringify({ version: VERSION, files: filesJson }))
    renameSync(path + '.tmp', path)
  } catch (e) {
    console.error('0rrery: failed to save tailer offsets', e)
  }
}
