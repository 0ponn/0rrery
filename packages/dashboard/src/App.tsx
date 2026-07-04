import { useEffect, useState } from 'react'
import { SessionsView } from './views/SessionsView'
import { SessionDetailView } from './views/SessionDetailView'
import { LiveView } from './views/LiveView'

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

  return (
    <div className="app">
      <nav className="topnav">
        <span className="brand">0rrery</span>
        <a href="#/" className={hash === '#/' ? 'active' : ''}>Sessions</a>
        <a href="#/live" className={hash === '#/live' ? 'active' : ''}>Live</a>
      </nav>
      <main>{view}</main>
    </div>
  )
}
