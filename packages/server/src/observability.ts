// Error-reporting seam for the 0rrery server. Same Sentry envelope as the
// other 0pon repos, in this repo's idiom and with a much harder scrub.
//
// 0rrery stores agent traces: prompts, file paths, tool arguments, denied
// permissions. None of that may leave the machine. Callers pass stage tags and
// counts, never payloads, and scrubPii is the backstop rather than the plan.
//
// Local-only tool, so the point is cross-machine visibility: an ingest failure
// on zimaboard is otherwise invisible from fedorahome.

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const HOME_RE = /\/home\/[^/\s]+/g
// Keys whose VALUE is sensitive regardless of content, redacted wholesale.
const PII_KEY = /^(email|phone|name|message|to|reply_?to|address|ip|token|secret|authorization|password|prompt|raw|content|args|input|output|cwd|path)$/i

/** Recursively strip anything trace-shaped: sensitive keys dropped, emails
 *  masked, home directories collapsed (they carry the username). */
export function scrubPii(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return value.replace(EMAIL_RE, '[email]').replace(HOME_RE, '~')
  if (Array.isArray(value)) return value.map(v => scrubPii(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = PII_KEY.test(k) ? '[redacted]' : scrubPii(v, depth + 1)
    return out
  }
  return value
}

type Dsn = { ingestUrl: string; key: string }

export function parseDsn(dsn: string): Dsn | null {
  try {
    const u = new URL(dsn)
    const projectId = u.pathname.replace(/^\//, '')
    if (!u.username || !projectId) return null
    return { ingestUrl: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, key: u.username }
  } catch { return null }
}

export type StackFrame = { filename: string; function?: string; lineno?: number; colno?: number; in_app: boolean }

/** Parse a V8 stack into Sentry frames (oldest-first; throw site last). */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return []
  const frames: StackFrame[] = []
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/)
    if (!m) continue
    const filename = m[2].replace(HOME_RE, '~')
    frames.push({ filename, ...(m[1] ? { function: m[1] } : {}), lineno: Number(m[3]), colno: Number(m[4]), in_app: !filename.includes('node_modules') })
  }
  return frames.reverse()
}

/** Build the newline-delimited Sentry envelope. Pure; no network. */
export function buildEnvelope(dsn: string, message: string, scrubbed: unknown, tags?: Record<string, string>, frames?: StackFrame[]) {
  const parsed = parseDsn(dsn)
  if (!parsed) return null
  const eventId = crypto.randomUUID().replace(/-/g, '')
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    logger: '0rrery',
    environment: process.env.NODE_ENV ?? 'development',
    ...(tags && Object.keys(tags).length ? { tags } : {}),
    exception: { values: [{ type: 'ServerError', value: message, ...(frames && frames.length ? { stacktrace: { frames } } : {}) }] },
    ...(scrubbed !== undefined ? { extra: { context: scrubbed } } : {}),
  }
  const body = [
    JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(event),
  ].join('\n')
  return {
    url: parsed.ingestUrl,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.key}, sentry_client=0rrery/1.0`,
    },
    body,
  }
}

/** Report a server-side error. Always logs (scrubbed); ships when SENTRY_DSN is
 *  set. NEVER throws, and never awaits the transport — this runs on a local
 *  ingest path and must not add latency to it. */
export function reportError(err: unknown, context?: Record<string, unknown>): void {
  const scrubbed = context ? scrubPii(context) : undefined
  const message = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(HOME_RE, '~')
  console.error('0rrery:', message, scrubbed ? JSON.stringify(scrubbed) : '')

  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  const tags: Record<string, string> = {
    service: process.env.SENTRY_SERVICE ?? '0rrery',
    ...(typeof context?.stage === 'string' ? { stage: context.stage } : {}),
  }
  try {
    const env = buildEnvelope(dsn, message, scrubbed, tags, err instanceof Error ? parseStack(err.stack) : [])
    if (!env) return
    void fetch(env.url, { method: 'POST', headers: env.headers, body: env.body, signal: AbortSignal.timeout(2000) }).catch(() => {})
  } catch { /* never throw into the caller */ }
}
