import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkill, skillSourceDir } from '../src/skill'

test('skillSourceDir finds the repo skill assets', () => {
  const src = skillSourceDir()
  expect(src).not.toBeNull()
  expect(existsSync(join(src!, 'SKILL.md'))).toBe(true)
})

test('installSkill copies and overwrites idempotently', () => {
  const claude = mkdtempSync(join(tmpdir(), '0rrery-skill-'))
  const src = mkdtempSync(join(tmpdir(), '0rrery-skillsrc-'))
  writeFileSync(join(src, 'SKILL.md'), 'v1')
  const dest = installSkill(claude, src)
  expect(dest).toBe(join(claude, 'skills', '0rrery'))
  expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('v1')
  writeFileSync(join(src, 'SKILL.md'), 'v2')
  installSkill(claude, src)
  expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('v2')
})
