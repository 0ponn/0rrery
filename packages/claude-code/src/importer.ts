import { openSync, readSync, fstatSync, closeSync } from 'node:fs'
import type { IngestOp } from '@0rrery/schema'
import { parseTranscriptLine, newTranscriptState, type TranscriptState } from './transcript'
import { emitOps } from './emit'

export type ImportResult = { ops: number; emitted: boolean; bytesRead: number }

export async function importTranscript(
  path: string, url: string, fromByte = 0, state: TranscriptState = newTranscriptState(), finalize = false,
): Promise<ImportResult> {
  const fd = openSync(path, 'r')
  let text!: string
  try {
    const size = fstatSync(fd).size
    if (size <= fromByte) return { ops: 0, emitted: true, bytesRead: fromByte }
    const buf = Buffer.alloc(size - fromByte)
    const n = readSync(fd, buf, 0, buf.length, fromByte)
    text = buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }

  // consume only complete lines; leave a trailing partial for the next pass
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { ops: 0, emitted: true, bytesRead: fromByte }
  const complete = text.slice(0, lastNewline)
  const consumedBytes = Buffer.byteLength(text.slice(0, lastNewline + 1))

  // parsing mutates state; snapshot so a failed emit can be retried cleanly
  const sessionStartedBefore = state.sessionStarted
  const ops = complete.split('\n').filter(Boolean).flatMap(l => parseTranscriptLine(l, state))
  if (finalize && ops.length > 0) {
    const sessionId = (ops.find(o => 'sessionId' in o) as { sessionId: string } | undefined)?.sessionId
    if (sessionId) {
      const maxTs = Math.max(...ops.map(o => o.ts))
      ops.push({ op: 'session.end', sessionId, ts: maxTs } satisfies IngestOp)
    }
  }
  const emitted = await emitOps(url, ops, 5000)
  if (!emitted) {
    state.sessionStarted = sessionStartedBefore
    return { ops: ops.length, emitted: false, bytesRead: fromByte }
  }
  return { ops: ops.length, emitted, bytesRead: fromByte + consumedBytes }
}
