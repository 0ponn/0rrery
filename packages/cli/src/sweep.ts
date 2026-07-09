import { existsSync } from 'node:fs'
import { importSession } from '@0rrery/claude-code'
import { parseCodexLine, newCodexState } from '@0rrery/codex'

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
    try {
      const r = await importSession(f, url, { finalize: true })
      if (r.emitted) {
        ok++
        console.log(`  ${name}: ${r.ops} ops`)
      } else {
        failed++
        console.error(`  ${name}: server unreachable at ${url} — aborting sweep`)
        aborted = true
        break
      }
    } catch (err) {
      failed++
      console.error(`  ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const codexFiles = !aborted && codexRoot && existsSync(codexRoot)
    ? Array.from(new Bun.Glob('**/*.jsonl').scanSync({ cwd: codexRoot, absolute: true })).sort()
    : []
  for (const f of codexFiles) {
    const name = f.split('/').slice(-2).join('/')
    try {
      const r = await importSession(f, url, { finalize: true, parse: parseCodexLine, newState: newCodexState })
      if (r.emitted) {
        ok++
        console.log(`  ${name}: ${r.ops} ops`)
      } else {
        failed++
        console.error(`  ${name}: server unreachable at ${url} — aborting sweep`)
        break
      }
    } catch (err) {
      failed++
      console.error(`  ${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { ok, failed, total: claudeFiles.length + codexFiles.length }
}
