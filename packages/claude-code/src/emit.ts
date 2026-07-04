import type { IngestOp } from '@0rrery/schema'

export async function emitOps(url: string, ops: IngestOp[], timeoutMs = 200): Promise<boolean> {
  if (ops.length === 0) return true
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ops),
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}
