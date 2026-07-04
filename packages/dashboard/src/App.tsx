import { useEffect, useState } from 'react'
import { SessionsView } from './views/SessionsView'

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
  // Task 13 adds: if (sessionMatch) view = <SessionDetailView id={decodeURIComponent(sessionMatch[1])} />
  // Task 14 adds: if (hash === '#/live') view = <LiveView />

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
