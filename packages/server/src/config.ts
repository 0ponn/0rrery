import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type Config = {
  port: number; host: string; dbPath: string; retentionDays: number
  dashboardDist: string | null; authToken: string | null; dataDir: string; staleAfterMs: number
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? join(homedir(), '.0rrery')
  const dist = resolve(import.meta.dir, '../../dashboard/dist')
  const envPort = Number(process.env.ORRERY_PORT)
  const envStale = Number(process.env.ORRERY_STALE_MS)
  return {
    dataDir,
    port: overrides.port ?? (process.env.ORRERY_PORT && Number.isFinite(envPort) ? envPort : 7317),
    host: overrides.host ?? process.env.ORRERY_HOST ?? '127.0.0.1',
    dbPath: overrides.dbPath ?? process.env.ORRERY_DB ?? join(dataDir, '0rrery.db'),
    retentionDays: overrides.retentionDays ?? 90,
    dashboardDist: overrides.dashboardDist !== undefined ? overrides.dashboardDist : (existsSync(dist) ? dist : null),
    authToken: overrides.authToken ?? process.env.ORRERY_TOKEN ?? null,
    staleAfterMs: overrides.staleAfterMs ?? (process.env.ORRERY_STALE_MS && Number.isInteger(envStale) && envStale >= 0 ? envStale : 1_800_000),
  }
}
