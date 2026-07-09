import { openSync, readSync, fstatSync, closeSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import type { IngestOp } from '@0rrery/schema'
import { parseTranscriptLine, newTranscriptState, type TranscriptState } from './transcript'
import { emitOps } from './emit'

export type ImportResult = { ops: number; emitted: boolean; bytesRead: number }

export type Parser<S> = {
  parse: (raw: string, state: S) => IngestOp[]
  finalize?: (state: S, maxTs: number) => IngestOp[]
}

// NOTE: passing claudeParser explicitly to importSession skips subagent-dir discovery (gate is opts.parser === undefined) — omit it for Claude transcripts.
export const claudeParser: Parser<TranscriptState> = { parse: parseTranscriptLine }

export async function importTranscript<S = TranscriptState>(
  path: string, url: string, fromByte = 0, state: S = newTranscriptState() as unknown as S, finalize = false,
  parser: Parser<S> = claudeParser as unknown as Parser<S>,
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

  // parsing mutates state; snapshot ALL fields so a failed emit retries cleanly
  // Set-valued fields (e.g. agentToolUseIds) are reference types — clone them so the
  // restore is an exact copy, not an alias to the (possibly further-mutated) live state
  // adapter state must be flat: scalars and Sets only — nested objects/Maps would alias through this rollback clone
  const snapshot: any = { ...state }
  for (const k of Object.keys(snapshot)) if (snapshot[k] instanceof Set) snapshot[k] = new Set(snapshot[k])
  const ops = complete.split('\n').filter(Boolean).flatMap(l => parser.parse(l, state))
  if (ops.length > 0) {
    const maxTs = ops.reduce((max, o) => (o.ts > max ? o.ts : max), 0)
    if ('agentId' in (state as any) && (state as any).agentId && ops.length) {
      ops.push({ op: 'span.end', id: `agent:${(state as any).agentId}`, ts: maxTs, status: 'ok' } satisfies IngestOp)
    }
    if (finalize && !('agentId' in (state as any) && (state as any).agentId)) {
      const sessionId = (ops.find(o => 'sessionId' in o) as { sessionId: string } | undefined)?.sessionId
      if (sessionId) ops.push({ op: 'session.end', sessionId, ts: maxTs } satisfies IngestOp)
    }
    if (finalize && parser.finalize && ops.length) ops.push(...parser.finalize(state, maxTs))
  }
  const emitted = await emitOps(url, ops, 5000)
  if (!emitted) {
    Object.assign(state as any, snapshot)
    return { ops: ops.length, emitted: false, bytesRead: fromByte }
  }
  return { ops: ops.length, emitted, bytesRead: fromByte + consumedBytes }
}

export async function importSession(
  path: string, url: string,
  opts: { finalize?: boolean; parser?: Parser<any>; newState?: () => any } = {},
) {
  const newState = opts.newState ?? newTranscriptState
  const parser = opts.parser ?? claudeParser
  let files = 0, ops = 0, emitted = true
  const main = await importTranscript(path, url, 0, newState(), opts.finalize ?? false, parser)
  files++; ops += main.ops; emitted = emitted && main.emitted
  if (!main.emitted) return { files, ops, emitted: false }
  if (opts.parser === undefined) {
    const subDir = join(dirname(path), basename(path, '.jsonl'), 'subagents')
    let subs: string[] = []
    try { subs = readdirSync(subDir).filter(f => f.endsWith('.jsonl')) } catch {}
    for (const f of subs) {
      const r = await importTranscript(join(subDir, f), url, 0, newTranscriptState())
      files++; ops += r.ops; emitted = emitted && r.emitted
    }
  }
  return { files, ops, emitted }
}
