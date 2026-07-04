import { test, expect } from 'bun:test'
import { loadConfig } from '../src/config'

test('defaults', () => {
  delete process.env.ORRERY_PORT; delete process.env.ORRERY_DB
  const c = loadConfig()
  expect(c.port).toBe(7317)
  expect(c.dbPath.endsWith('/.0rrery/0rrery.db')).toBe(true)
  expect(c.retentionDays).toBe(90)
  expect(c.authToken).toBeNull()
})

test('env and overrides win in order', () => {
  process.env.ORRERY_PORT = '9999'
  expect(loadConfig().port).toBe(9999)
  expect(loadConfig({ port: 1234 }).port).toBe(1234)
  delete process.env.ORRERY_PORT
})
