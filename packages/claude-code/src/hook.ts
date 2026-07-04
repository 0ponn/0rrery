#!/usr/bin/env bun
// Claude Code hook entry. Fail-open: always exits 0, never blocks the host.
import { mapHookEvent, type HookInput } from './map'
import { emitOps } from './emit'

try {
  const raw = await Bun.stdin.text()
  const input = JSON.parse(raw) as HookInput
  await emitOps(process.env.ORRERY_URL ?? 'http://localhost:7317', mapHookEvent(input))
} catch {}
process.exit(0)
