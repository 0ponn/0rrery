import { test, expect } from 'bun:test'
import { scrubPii, parseDsn, buildEnvelope, parseStack, reportError } from './observability'

test('scrubPii drops trace-shaped keys wholesale', () => {
  const out = scrubPii({ prompt: 'write me a worm', args: { file: 'x' }, cwd: '/home/mlayug/x', stage: 'ingest', n: 3 }) as Record<string, unknown>
  expect(out.prompt).toBe('[redacted]')
  expect(out.args).toBe('[redacted]')
  expect(out.cwd).toBe('[redacted]')
  expect(out.stage).toBe('ingest') // stage is a tag, not payload
  expect(out.n).toBe(3)
})

test('scrubPii collapses home dirs, which carry the username', () => {
  expect(scrubPii({ note: 'failed at /home/mlayug/Documents/x.ts' })).toEqual({ note: 'failed at ~/Documents/x.ts' })
  expect(scrubPii({ note: 'mail me@0pon.com' })).toEqual({ note: 'mail [email]' })
})

test('scrubPii is depth-capped', () => {
  let deep: unknown = { prompt: 'x' }
  for (let i = 0; i < 10; i++) deep = { nested: deep }
  expect(JSON.stringify(scrubPii(deep))).toContain('[deep]')
})

test('parseDsn extracts the ingest URL and key, rejects junk', () => {
  expect(parseDsn('https://abc@o1.ingest.us.sentry.io/9')).toEqual({ ingestUrl: 'https://o1.ingest.us.sentry.io/api/9/envelope/', key: 'abc' })
  expect(parseDsn('nope')).toBeNull()
  expect(parseDsn('https://o1.ingest.us.sentry.io/9')).toBeNull()
})

test('parseStack orders oldest-first, flags in_app, and hides the home dir', () => {
  const stack = ['Error: boom', '    at ingest (/home/mlayug/Documents/0pon/0rrery/packages/server/src/server.ts:132:9)', '    at run (/node_modules/bun/x.js:1:1)'].join('\n')
  const frames = parseStack(stack)
  expect(frames[frames.length - 1].function).toBe('ingest')
  expect(frames[frames.length - 1].filename.startsWith('~/')).toBe(true)
  expect(frames[frames.length - 1].in_app).toBe(true)
  expect(frames[0].in_app).toBe(false)
  expect(parseStack(undefined)).toEqual([])
})

test('buildEnvelope emits 3 lines with the auth header and a distinct event id', () => {
  const a = buildEnvelope('https://abc@o1.ingest.us.sentry.io/9', 'ServerError: boom', undefined, { service: '0rrery', stage: 'ingest' })!
  expect(a.url).toBe('https://o1.ingest.us.sentry.io/api/9/envelope/')
  expect(a.headers['X-Sentry-Auth']).toContain('sentry_key=abc')
  expect(a.body.split('\n').length).toBe(3)
  expect(JSON.parse(a.body.split('\n')[2]).tags.stage).toBe('ingest')
  const b = buildEnvelope('https://abc@o1.ingest.us.sentry.io/9', 'x', undefined)!
  expect(JSON.parse(a.body.split('\n')[0]).event_id).not.toBe(JSON.parse(b.body.split('\n')[0]).event_id)
})

test('reportError tags the service and never leaks the raw error path', async () => {
  process.env.SENTRY_DSN = 'https://abc@o1.ingest.us.sentry.io/9'
  delete process.env.SENTRY_SERVICE
  const origFetch = globalThis.fetch
  const origLog = console.error
  console.error = () => {}
  let body = ''
  let resolve: () => void = () => {}
  const sent = new Promise<void>(r => { resolve = r })
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => { body = init.body; resolve(); return new Response('') }) as unknown as typeof fetch
  try {
    reportError(new Error('cannot write /home/mlayug/.local/share/0rrery/db'), { stage: 'deadLetter' })
    await sent
    const event = JSON.parse(body.split('\n')[2])
    expect(event.tags.service).toBe('0rrery')
    expect(event.tags.stage).toBe('deadLetter')
    expect(body.includes('/home/mlayug')).toBe(false)
  } finally {
    globalThis.fetch = origFetch
    console.error = origLog
    delete process.env.SENTRY_DSN
  }
})

test('reportError is inert without a DSN, does not block, and never throws', () => {
  delete process.env.SENTRY_DSN
  const origFetch = globalThis.fetch
  const origLog = console.error
  let logged = ''
  console.error = (...a: unknown[]) => { logged = a.join(' ') }
  let called = false
  globalThis.fetch = (async () => { called = true; throw new Error('down') }) as unknown as typeof fetch
  try {
    expect(reportError(new Error('boom'), { prompt: 'secret' })).toBeUndefined() // sync: ingest path adds no latency
    expect(logged).toContain('boom')
    expect(logged.includes('secret')).toBe(false)
    expect(called).toBe(false)
  } finally {
    globalThis.fetch = origFetch
    console.error = origLog
  }
})
