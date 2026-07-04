import { test, expect } from 'bun:test'
import { loadConfig } from '../src/config'

test('defaults', () => {
  delete process.env.ORRERY_PORT; delete process.env.ORRERY_DB; delete process.env.ORRERY_TOKEN
  const c = loadConfig()
  expect(c.port).toBe(7317)
  expect(c.dbPath.endsWith('/.0rrery/0rrery.db')).toBe(true)
  expect(c.retentionDays).toBe(90)
  expect(c.authToken).toBeNull()
})

test('env and overrides win in order', () => {
  process.env.ORRERY_PORT = '9999'
  try {
    expect(loadConfig().port).toBe(9999)
    expect(loadConfig({ port: 1234 }).port).toBe(1234)
  } finally {
    delete process.env.ORRERY_PORT
  }
})

test('malformed ORRERY_PORT falls back to default', () => {
  process.env.ORRERY_PORT = 'abc'
  try { expect(loadConfig().port).toBe(7317) } finally { delete process.env.ORRERY_PORT }
})

test('explicit null dashboardDist honored; dbPath follows overridden dataDir', () => {
  const c = loadConfig({ dataDir: '/tmp/xdir', dashboardDist: null })
  expect(c.dashboardDist).toBeNull()
  expect(c.dbPath).toBe('/tmp/xdir/0rrery.db')
})
