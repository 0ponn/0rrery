import type { SessionDetail, ApiSession } from './types'

const base = ''  // same origin; vite dev proxies /api

export async function fetchSessions(params: { project?: string; status?: string } = {}): Promise<ApiSession[]> {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][])
  const res = await fetch(`${base}/api/sessions?${q}`)
  if (!res.ok) throw new Error(`sessions: ${res.status}`)
  return res.json()
}

export async function fetchSession(id: string): Promise<SessionDetail> {
  const res = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(`session ${id}: ${res.status}`)
  return res.json()
}

export function liveSocket(session: string, onOps: (ops: unknown[]) => void): WebSocket {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/api/live?session=${encodeURIComponent(session)}`)
  ws.onmessage = e => { try { onOps(JSON.parse(e.data)) } catch {} }
  return ws
}
