import { existsSync } from 'node:fs'
import { importSession } from '@0rrery/claude-code'
import { codexParser, newCodexState } from '@0rrery/codex'

async function importOne<S>(
  path: string, url: string, opts: Parameters<typeof importSession<S>>[2], label: string,
): Promise<'ok' | 'failed' | 'unreachable'> {
  try {
    const r = await importSession(path, url, opts)
    if (r.emitted) {
      console.log(`  ${label}: ${r.ops} ops`)
      return 'ok'
    }
    console.error(`  ${label}: server unreachable at ${url} — aborting sweep`)
    return 'unreachable'
  } catch (err) {
    console.error(`  ${label}: ${err instanceof Error ? err.message : String(err)}`)
    return 'failed'
  }
}

export async function importAll(
  projectsDir: string, url: string, codexRoot?: string,
): Promise<{ ok: number; failed: number; total: number }> {
  const claudeFiles = existsSync(projectsDir)
    ? Array.from(new Bun.Glob('*/*.jsonl').scanSync({ cwd: projectsDir, absolute: true })).sort()
    : []
  let ok = 0
  let failed = 0
  let aborted = false

  for (const f of claudeFiles) {
    const name = f.split('/').slice(-2).join('/')
    const result = await importOne(f, url, { finalize: true }, name)
    if (result === 'ok') {
      ok++
    } else {
      failed++
      if (result === 'unreachable') { aborted = true; break }
    }
  }

  const codexFiles = !aborted && codexRoot && existsSync(codexRoot)
    ? Array.from(new Bun.Glob('**/*.jsonl').scanSync({ cwd: codexRoot, absolute: true })).sort()
    : []
  for (const f of codexFiles) {
    const name = f.split('/').slice(-2).join('/')
    const result = await importOne(f, url, { finalize: true, parser: codexParser, newState: newCodexState }, name)
    if (result === 'ok') {
      ok++
    } else {
      failed++
      if (result === 'unreachable') break
    }
  }

  return { ok, failed, total: claudeFiles.length + codexFiles.length }
}
