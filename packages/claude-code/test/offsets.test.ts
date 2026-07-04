import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOffsets, saveOffsets, reviveState, type FileState } from '../src/offsets'
import { newTranscriptState } from '../src/transcript'

function tmpPath() { return join(mkdtempSync(join(tmpdir(), '0rrery-off-')), 'tailer-offsets.json') }

test('round-trips offsets and full state including the Set', () => {
  const p = tmpPath()
  const trackedFile = tmpPath()  // any real file path; existence is what load checks
  writeFileSync(trackedFile, 'x')
  const state = newTranscriptState()
  state.sessionStarted = true
  state.agentId = 'a1b2c3d4e5'
  state.agentFirstTs = 42
  state.agentToolUseIds.add('tu1').add('tu2')
  const files = new Map<string, FileState>([[trackedFile, { offset: 123, state }]])
  saveOffsets(p, files)
  const loaded = loadOffsets(p)
  const entry = loaded.get(trackedFile)!
  expect(entry.offset).toBe(123)
  expect(entry.state.sessionStarted).toBe(true)
  expect(entry.state.agentId).toBe('a1b2c3d4e5')
  expect(entry.state.agentFirstTs).toBe(42)
  expect(entry.state.agentToolUseIds).toBeInstanceOf(Set)
  expect([...entry.state.agentToolUseIds].sort()).toEqual(['tu1', 'tu2'])
  expect(existsSync(p + '.tmp')).toBe(false)  // atomic write left no tmp behind
})

test('missing file → empty map, no throw, no log', () => {
  expect(loadOffsets(join(tmpdir(), '0rrery-off-nope', 'none.json')).size).toBe(0)
})

test('corrupt JSON and wrong version → empty map, no throw', () => {
  const p1 = tmpPath()
  writeFileSync(p1, '{ not json')
  expect(loadOffsets(p1).size).toBe(0)
  const p2 = tmpPath()
  writeFileSync(p2, JSON.stringify({ version: 99, files: {} }))
  expect(loadOffsets(p2).size).toBe(0)
})

test('entries for files that no longer exist are pruned at load', () => {
  const p = tmpPath()
  const gone = join(tmpdir(), '0rrery-off-gone', 'deleted.jsonl')
  const files = new Map<string, FileState>([[gone, { offset: 5, state: newTranscriptState() }]])
  saveOffsets(p, files)
  expect(loadOffsets(p).size).toBe(0)
})

test('reviveState fills fields missing from older snapshots', () => {
  const revived = reviveState({ sessionStarted: true })  // v-old snapshot lacking agent fields
  expect(revived.sessionStarted).toBe(true)
  expect(revived.agentStarted).toBe(false)
  expect(revived.agentId).toBeNull()
  expect(revived.agentToolUseIds).toBeInstanceOf(Set)
  expect(revived.agentToolUseIds.size).toBe(0)
  const junk = reviveState('not an object')
  expect(junk.sessionStarted).toBe(false)
})

test('saveOffsets to an unwritable path does not throw', () => {
  const files = new Map<string, FileState>()
  expect(() => saveOffsets('/proc/definitely/not/writable.json', files)).not.toThrow()
})
