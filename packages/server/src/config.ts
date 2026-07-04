import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type Config = {
  port: number; dbPath: string; retentionDays: number
  dashboardDist: string | null; authToken: string | null; dataDir: string
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = overrides.dataDir ?? join(homedir(), '.0rrery')
  const dist = resolve(import.meta.dir, '../../dashboard/dist')
  return {
    dataDir,
    port: overrides.port ?? (process.env.ORRERY_PORT ? Number(process.env.ORRERY_PORT) : 7317),
    dbPath: overrides.dbPath ?? process.env.ORRERY_DB ?? join(dataDir, '0rrery.db'),
    retentionDays: overrides.retentionDays ?? 90,
    dashboardDist: overrides.dashboardDist !== undefined ? overrides.dashboardDist : (existsSync(dist) ? dist : null),
    authToken: overrides.authToken ?? process.env.ORRERY_TOKEN ?? null,
  }
}
