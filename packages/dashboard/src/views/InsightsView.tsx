import { useEffect, useState } from 'react'
import { fetchInsights } from '../api'
import { fmtDuration, fmtTokens, fmtCost } from '../format'
import { TopoGraph } from './TopoGraph'
import type { TopoNode, TopoEdge } from '../topology'

type Filter = { project: string; from: string; to: string }

type SpendRow = { day: string; model: string; project: string | null; tokens_in: number; tokens_out: number; calls: number; est_cost: number | null }
type ToolHealthRow = { name: string; kind: 'tool' | 'mcp'; calls: number; errors: number; denials: number }
type ProjectRollup = { project: string | null; sessions: number; wall_ms: number; tokens_in: number; tokens_out: number; est_cost: number | null; subagents: number }
type SprawlData = { nodes: TopoNode[]; edges: TopoEdge[] }
type SurfaceData = { domains: { host: string; calls: number; tools: string[] }[]; mcp: { server: string; tools: { name: string; calls: number }[] }[] }
type FootprintDir = { path: string; touches: number; reads: number; writes: number }
type FootprintData = { dirs: FootprintDir[]; files: FootprintDir[] }

function useInsights<T>(name: string, filter: Filter): { data: T | null; error: string } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    const params: Record<string, string> = {}
    if (filter.project) params.project = filter.project
    if (filter.from) params.from = filter.from
    if (filter.to) params.to = filter.to
    fetchInsights(name, params)
      .then(d => { if (!cancelled) { setData(d); setError('') } })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [name, filter.project, filter.from, filter.to])
  return { data, error }
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-title">{title}</h2>
      {children}
    </section>
  )
}

const COLOR_VARS = ['var(--accent)', 'var(--ok)', 'var(--mcp)', 'var(--run)']
const OTHER_COLOR = 'var(--dim)'
const BAR_W = 18
const GAP = 2
const CHART_H = 140
const MARGIN_L = 44
const MARGIN_T = 8
const MARGIN_B = 20

function SpendPanel({ filter }: { filter: Filter }) {
  const { data, error } = useInsights<SpendRow[]>('spend', filter)
  if (error) return <Panel title="Spend"><p className="error">{error}</p></Panel>
  if (!data) return <Panel title="Spend"><p className="empty">loading…</p></Panel>
  if (data.length === 0) return <Panel title="Spend"><p className="empty">No data</p></Panel>

  const firstSeen: string[] = []
  const byDayModel = new Map<string, Map<string, { tokens: number; cost: number | null }>>()
  for (const r of data) {
    if (!firstSeen.includes(r.model)) firstSeen.push(r.model)
    let dm = byDayModel.get(r.day)
    if (!dm) { dm = new Map(); byDayModel.set(r.day, dm) }
    const cur = dm.get(r.model) ?? { tokens: 0, cost: null as number | null }
    cur.tokens += r.tokens_in + r.tokens_out
    if (r.est_cost !== null) cur.cost = (cur.cost ?? 0) + r.est_cost
    dm.set(r.model, cur)
  }
  const days = [...byDayModel.keys()].sort()
  const colorModels = firstSeen.slice(0, 4)
  const otherModels = firstSeen.slice(4)
  const legend = colorModels.map((model, i) => ({ model, color: COLOR_VARS[i] }))
  if (otherModels.length > 0) legend.push({ model: 'other', color: OTHER_COLOR })

  const dayData = days.map(day => {
    const dm = byDayModel.get(day)!
    const segs = legend.map(l => {
      if (l.model === 'other') {
        let tokens = 0, cost: number | null = null
        for (const m of otherModels) {
          const v = dm.get(m)
          if (v) { tokens += v.tokens; if (v.cost !== null) cost = (cost ?? 0) + v.cost }
        }
        return { model: 'other', tokens, cost, color: l.color }
      }
      const v = dm.get(l.model)
      return { model: l.model, tokens: v?.tokens ?? 0, cost: v?.cost ?? null, color: l.color }
    }).filter(s => s.tokens > 0)
    const total = segs.reduce((a, s) => a + s.tokens, 0)
    const known = segs.filter(s => s.cost !== null)
    const knownCost = known.length ? known.reduce((a, s) => a + (s.cost ?? 0), 0) : null
    return { day, segs, total, knownCost }
  })

  const maxTotal = Math.max(1, ...dayData.map(d => d.total))
  const width = MARGIN_L + days.length * (BAR_W + GAP)
  const height = MARGIN_T + CHART_H + MARGIN_B
  const step = Math.ceil(days.length / 8)
  const yAt = (v: number) => MARGIN_T + CHART_H - (v / maxTotal) * CHART_H
  const gridFracs = [0, 0.5, 1]

  return (
    <Panel title="Spend">
      <div className="topo-scroll">
        <svg className="spend-svg" width={width} height={height} role="img" aria-label="Token spend by day and model">
          {gridFracs.map(f => {
            const val = maxTotal * f
            const yy = yAt(val)
            return (
              <g key={f}>
                <line x1={MARGIN_L} x2={width} y1={yy} y2={yy} className="grid-line" />
                <text x={MARGIN_L - 6} y={yy + 4} textAnchor="end" className="axis-label">{fmtTokens(Math.round(val))}</text>
              </g>
            )
          })}
          {dayData.map((d, i) => {
            const x = MARGIN_L + i * (BAR_W + GAP)
            let cursor = MARGIN_T + CHART_H
            return (
              <g key={d.day}>
                {d.segs.map(s => {
                  const segH = (s.tokens / maxTotal) * CHART_H
                  const y = cursor - segH
                  cursor = y - GAP
                  const costLabel = s.cost !== null ? `$${s.cost.toFixed(2)}` : '—'
                  return (
                    <rect key={s.model} x={x} y={y} width={BAR_W} height={Math.max(0, segH)} fill={s.color}>
                      <title>{`${d.day} · ${s.model} · ${fmtTokens(s.tokens)} · ${costLabel}`}</title>
                    </rect>
                  )
                })}
              </g>
            )
          })}
          {dayData.map((d, i) => i % step === 0 && (
            <text key={d.day} x={MARGIN_L + i * (BAR_W + GAP) + BAR_W / 2} y={height - 4} textAnchor="middle" className="axis-label">
              {d.day.slice(5)}
            </text>
          ))}
        </svg>
      </div>
      <div className="chips legend-row">
        {legend.map(l => (
          <span key={l.model} className="chip legend-chip"><i className="topo-chip" style={{ background: l.color }} /> {l.model}</span>
        ))}
      </div>
      <div className="spend-costs">
        {dayData.filter(d => d.knownCost !== null).map(d => (
          <div key={d.day}>{d.day}: ${d.knownCost!.toFixed(2)} est.</div>
        ))}
      </div>
      <p className="footnote">$ estimated; unknown-price models excluded from $</p>
    </Panel>
  )
}

function ToolHealthPanel({ filter }: { filter: Filter }) {
  const { data, error } = useInsights<ToolHealthRow[]>('tool-health', filter)
  if (error) return <Panel title="Tool health"><p className="error">{error}</p></Panel>
  if (!data) return <Panel title="Tool health"><p className="empty">loading…</p></Panel>
  if (data.length === 0) return <Panel title="Tool health"><p className="empty">No data</p></Panel>
  return (
    <Panel title="Tool health">
      <div className="wide-table">
        <table>
          <thead><tr><th>Name</th><th>Kind</th><th>Calls</th><th>Error %</th><th>Denials</th></tr></thead>
          <tbody>
            {data.map(r => {
              const errPct = r.calls ? (r.errors / r.calls) * 100 : 0
              return (
                <tr key={`${r.kind}:${r.name}`}>
                  <td>{r.name}</td>
                  <td><span className={`badge ${r.kind}`}>{r.kind}</span></td>
                  <td>{r.calls}</td>
                  <td style={errPct > 5 ? { color: 'var(--err)' } : undefined}>{errPct.toFixed(1)}%</td>
                  <td>{r.denials}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function ProjectsPanel({ filter }: { filter: Filter }) {
  const { data, error } = useInsights<ProjectRollup[]>('projects', filter)
  if (error) return <Panel title="Projects"><p className="error">{error}</p></Panel>
  if (!data) return <Panel title="Projects"><p className="empty">loading…</p></Panel>
  if (data.length === 0) return <Panel title="Projects"><p className="empty">No data</p></Panel>
  return (
    <Panel title="Projects">
      <div className="wide-table">
        <table>
          <thead><tr><th>Project</th><th>Sessions</th><th>Duration</th><th>Tokens</th><th>Est $</th></tr></thead>
          <tbody>
            {data.map(p => (
              <tr key={p.project ?? '—'}>
                <td>{p.project ?? '—'}</td>
                <td>{p.sessions}</td>
                <td>{fmtDuration(p.wall_ms)}</td>
                <td>{fmtTokens(p.tokens_in + p.tokens_out)}</td>
                <td>{p.est_cost !== null ? fmtCost(p.est_cost) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function SprawlPanel({ filter }: { filter: Filter }) {
  const { data, error } = useInsights<SprawlData>('sprawl', filter)
  if (error) return <Panel title="Sprawl"><p className="error">{error}</p></Panel>
  if (!data) return <Panel title="Sprawl"><p className="empty">loading…</p></Panel>
  if (!data.nodes || data.nodes.length <= 1) return <Panel title="Sprawl"><p className="empty">No data</p></Panel>
  return (
    <Panel title="Sprawl">
      <TopoGraph nodes={data.nodes} edges={data.edges} />
    </Panel>
  )
}

function SurfacePanel({ filter }: { filter: Filter }) {
  const { data, error } = useInsights<SurfaceData>('surface', filter)
  if (error) return <Panel title="Surface"><p className="error">{error}</p></Panel>
  if (!data) return <Panel title="Surface"><p className="empty">loading…</p></Panel>
  const noData = (!data.domains || data.domains.length === 0) && (!data.mcp || data.mcp.length === 0)
  if (noData) return <Panel title="Surface"><p className="empty">No data</p></Panel>
  return (
    <Panel title="Surface">
      <h3 className="subhead">Domains</h3>
      {data.domains.length === 0 ? <p className="empty">No data</p> : (
        <div className="wide-table">
          <table>
            <thead><tr><th>Host</th><th>Calls</th><th>Tools</th></tr></thead>
            <tbody>
              {data.domains.map(d => (
                <tr key={d.host}><td>{d.host}</td><td>{d.calls}</td><td>{d.tools.join(', ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className="subhead">MCP servers</h3>
      {data.mcp.length === 0 ? <p className="empty">No data</p> : (
        <div className="wide-table">
          <table>
            <thead><tr><th>Server</th><th>Tools</th></tr></thead>
            <tbody>
              {data.mcp.map(m => (
                <tr key={m.server}>
                  <td>{m.server}</td>
                  <td>{m.tools.map(t => `${t.name} (${t.calls})`).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function FootprintPanel({ filter }: { filter: Filter }) {
  const { data, error } = useInsights<FootprintData>('footprint', filter)
  const [showAll, setShowAll] = useState(false)
  if (error) return <Panel title="Footprint"><p className="error">{error}</p></Panel>
  if (!data) return <Panel title="Footprint"><p className="empty">loading…</p></Panel>
  if (!data.dirs || data.dirs.length === 0) return <Panel title="Footprint"><p className="empty">No data</p></Panel>
  const rows = showAll ? data.dirs : data.dirs.slice(0, 20)
  return (
    <Panel title="Footprint">
      <div className="wide-table">
        <table>
          <thead><tr><th>Dir</th><th>Touches</th><th>Reads</th><th>Writes</th></tr></thead>
          <tbody>
            {rows.map(d => (
              <tr key={d.path}><td>{d.path}</td><td>{d.touches}</td><td>{d.reads}</td><td>{d.writes}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.dirs.length > 20 && (
        <button className="pause" onClick={() => setShowAll(!showAll)}>{showAll ? 'show top 20' : `show all (${data.dirs.length})`}</button>
      )}
    </Panel>
  )
}

export function InsightsView() {
  const [projectInput, setProjectInput] = useState('')
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [filter, setFilter] = useState<Filter>({ project: '', from: '', to: '' })

  const apply = () => {
    const from = fromInput ? String(new Date(fromInput).getTime()) : ''
    const to = toInput ? String(new Date(`${toInput}T23:59:59.999`).getTime()) : ''
    setFilter({ project: projectInput.trim(), from, to })
  }

  return (
    <section>
      <header className="viewhead">
        <h1>Insights</h1>
      </header>
      <div className="filters">
        <input placeholder="project" value={projectInput} onChange={e => setProjectInput(e.target.value)} />
        <input type="date" value={fromInput} onChange={e => setFromInput(e.target.value)} />
        <input type="date" value={toInput} onChange={e => setToInput(e.target.value)} />
        <button className="pause" onClick={apply}>Apply</button>
      </div>
      <SpendPanel filter={filter} />
      <ToolHealthPanel filter={filter} />
      <ProjectsPanel filter={filter} />
      <SprawlPanel filter={filter} />
      <SurfacePanel filter={filter} />
      <FootprintPanel filter={filter} />
    </section>
  )
}
