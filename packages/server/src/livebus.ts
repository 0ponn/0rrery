import type { IngestOp } from '@0rrery/schema'

type Fn = (ops: IngestOp[]) => void

function sessionOf(op: IngestOp): string | null {
  return 'sessionId' in op ? op.sessionId : null  // span.end carries no session id
}

export class LiveBus {
  private subs = new Map<string, Set<Fn>>()

  subscribe(sessionId: string | '*', fn: Fn): () => void {
    if (!this.subs.has(sessionId)) this.subs.set(sessionId, new Set())
    this.subs.get(sessionId)!.add(fn)
    return () => {
      const fns = this.subs.get(sessionId)
      if (!fns) return
      fns.delete(fn)
      if (fns.size === 0) this.subs.delete(sessionId)
    }
  }

  publish(ops: IngestOp[]): void {
    const bySession = new Map<string, IngestOp[]>()
    for (const op of ops) {
      const sid = sessionOf(op)
      if (sid) (bySession.get(sid) ?? bySession.set(sid, []).get(sid)!).push(op)
    }
    const deliver = (fns: Set<Fn> | undefined, batch: IngestOp[]) => {
      if (!fns || batch.length === 0) return
      for (const fn of fns) { try { fn(batch) } catch {} }
    }
    for (const [sid, batch] of bySession) deliver(this.subs.get(sid), batch)
    deliver(this.subs.get('*'), ops)
  }
}
