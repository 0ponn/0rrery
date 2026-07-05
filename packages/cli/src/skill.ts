import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Bundled entry: dist-pkg/index.js with dist-pkg/skill; repo: packages/cli/src with packages/cli/skill.
export function skillSourceDir(): string | null {
  const candidates = [join(import.meta.dir, 'skill'), join(import.meta.dir, '../skill')]
  return candidates.find(existsSync) ?? null
}

export function installSkill(claudeDir: string, srcDir: string): string {
  const dest = join(claudeDir, 'skills', '0rrery')
  mkdirSync(dest, { recursive: true })
  cpSync(srcDir, dest, { recursive: true })
  return dest
}
