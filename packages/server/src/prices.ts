import { readFileSync } from 'node:fs'

// $ per million tokens; longest-prefix match against the model name.
// Deliberately excludes models without public pricing — unknown → null, never guessed.
const DEFAULTS: Record<string, { in: number; out: number }> = {
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4': { in: 0.8, out: 4 },
  'claude-3-5-haiku': { in: 0.8, out: 4 },
}

let cached: Record<string, { in: number; out: number }> | null = null

export function loadPrices(): Record<string, { in: number; out: number }> {
  if (cached) return cached
  let overrides = {}
  const p = process.env.ORRERY_PRICES
  if (p) {
    try { overrides = JSON.parse(readFileSync(p, 'utf8')) } catch { console.warn(`ORRERY_PRICES: cannot read ${p}, using defaults`) }
  }
  cached = { ...DEFAULTS, ...overrides }
  return cached
}

export function estCost(model: string, tin: number, tout: number): number | null {
  const prices = loadPrices()
  const key = Object.keys(prices).filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  if (!key) return null
  return (tin / 1e6) * prices[key].in + (tout / 1e6) * prices[key].out
}
