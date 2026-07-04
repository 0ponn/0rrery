import { test, expect } from 'bun:test'
import { emitOps } from '../src/emit'

test('emits to a live server and returns true', async () => {
  let received: unknown = null
  const srv = Bun.serve({ port: 0, async fetch(req) { received = await req.json(); return new Response('{"accepted":0,"rejected":[]}') } })
  const ok = await emitOps(`http://localhost:${srv.port}`, [{ op: 'session.end', sessionId: 's', ts: 1 }])
  expect(ok).toBe(true)
  expect(received).toEqual([{ op: 'session.end', sessionId: 's', ts: 1 }])
  srv.stop(true)
})

test('returns false, never throws, when server is down or slow', async () => {
  expect(await emitOps('http://localhost:1', [{ op: 'session.end', sessionId: 's', ts: 1 }])).toBe(false)
  const slow = Bun.serve({ port: 0, async fetch() { await Bun.sleep(2000); return new Response('') } })
  expect(await emitOps(`http://localhost:${slow.port}`, [{ op: 'session.end', sessionId: 's', ts: 1 }], 50)).toBe(false)
  slow.stop(true)
})

test('no-op on empty ops', async () => {
  expect(await emitOps('http://localhost:1', [])).toBe(true)
})
