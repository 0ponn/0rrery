import { importSession } from '@0rrery/claude-code'

export async function importAll(projectsDir: string, url: string): Promise<{ ok: number; failed: number; total: number }> {
  const files = Array.from(new Bun.Glob('*/*.jsonl').scanSync({ cwd: projectsDir, absolute: true })).sort()
  let ok = 0
  let failed = 0
  for (const f of files) {
    const name = f.split('/').slice(-2).join('/')
    try {
      const r = await importSession(f, url, { finalize: true })
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
  return { ok, failed, total: files.length }
}
