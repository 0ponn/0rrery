import { openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { parseTranscriptLine, newTranscriptState, type TranscriptState } from './transcript'
import { emitOps } from './emit'

export type ImportResult = { ops: number; emitted: boolean; bytesRead: number }

export async function importTranscript(
  path: string, url: string, fromByte = 0, state: TranscriptState = newTranscriptState(),
): Promise<ImportResult> {
  const fd = openSync(path, 'r')
  let text!: string
  try {
    const size = fstatSync(fd).size
    if (size <= fromByte) return { ops: 0, emitted: true, bytesRead: fromByte }
    const buf = Buffer.alloc(size - fromByte)
    readSync(fd, buf, 0, buf.length, fromByte)
    text = buf.toString('utf8')
  } finally {
    closeSync(fd)
  }

  // consume only complete lines; leave a trailing partial for the next pass
  const lastNewline = text.lastIndexOf('\n')
  if (lastNewline === -1) return { ops: 0, emitted: true, bytesRead: fromByte }
  const complete = text.slice(0, lastNewline)
  const consumedBytes = Buffer.byteLength(text.slice(0, lastNewline + 1))

  const ops = complete.split('\n').filter(Boolean).flatMap(l => parseTranscriptLine(l, state))
  const emitted = await emitOps(url, ops, 5000)
  return { ops: ops.length, emitted, bytesRead: fromByte + consumedBytes }
}
