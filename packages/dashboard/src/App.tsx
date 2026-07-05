import { Component, useEffect, useState, type ReactNode } from 'react'
import { SessionsView } from './views/SessionsView'
import { SessionDetailView } from './views/SessionDetailView'
import { LiveView } from './views/LiveView'
import { InsightsView } from './views/InsightsView'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="error">
          <p>{this.state.error.message}</p>
          <a href="#/">back to sessions</a>
        </div>
      )
    }
    return this.props.children
  }
}

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

export function App() {
  const hash = useHashRoute()
  const sessionMatch = hash.match(/^#\/session\/(.+)$/)

  let view = <SessionsView />
  if (sessionMatch) view = <SessionDetailView id={decodeURIComponent(sessionMatch[1])} />
  if (hash === '#/live') view = <LiveView />
  if (hash === '#/insights') view = <InsightsView />

  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">0rrery</span>
        <a href="#/" className={hash === '#/' ? 'active' : ''}>Sessions</a>
        <a href="#/live" className={hash === '#/live' ? 'active' : ''}>Live</a>
        <a href="#/insights" className={hash === '#/insights' ? 'active' : ''}>Insights</a>
      </nav>
      <main><ErrorBoundary>{view}</ErrorBoundary></main>
    </div>
  )
}
