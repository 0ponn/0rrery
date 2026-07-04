import { test, expect } from 'bun:test'
import { LiveBus } from '../src/livebus'
import type { IngestOp } from '@0rrery/schema'

const opA: IngestOp = { op: 'event', id: 'e1', sessionId: 'a', type: 't', ts: 1 }
const opB: IngestOp = { op: 'event', id: 'e2', sessionId: 'b', type: 't', ts: 2 }
const opEnd: IngestOp = { op: 'span.end', id: 'sp9', ts: 3, status: 'ok' }  // no sessionId on span.end

test('routes by session, firehose gets everything', () => {
  const bus = new LiveBus()
  const gotA: IngestOp[][] = [], gotAll: IngestOp[][] = []
  bus.subscribe('a', ops => gotA.push(ops))
  bus.subscribe('*', ops => gotAll.push(ops))
  bus.publish([opA, opB, opEnd])
  expect(gotA).toEqual([[opA]])
  expect(gotAll).toEqual([[opA, opB, opEnd]])
})

test('unsubscribe stops delivery; subscriber errors are swallowed', () => {
  const bus = new LiveBus()
  const got: IngestOp[][] = []
  bus.subscribe('*', () => { throw new Error('boom') })
  const un = bus.subscribe('a', ops => got.push(ops))
  un()
  expect(() => bus.publish([opA])).not.toThrow()
  expect(got).toEqual([])
})

test('unsubscribe prunes empty session entries', () => {
  const bus = new LiveBus()
  const un = bus.subscribe('a', () => {})
  un()
  expect((bus as any).subs.size).toBe(0)
})
