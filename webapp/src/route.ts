import { useEffect, useState } from 'react'

/**
 * Hash routing, so the nav bar's pages are linkable and survive a reload
 * without pulling in a router: the webapp is mounted at an arbitrary path
 * under the Signal K server, which rules out path-based history routing
 * unless the server learns to serve index.html for unknown sub-paths.
 */

export const ROUTES = ['monitor', 'load-test'] as const

export type Route = (typeof ROUTES)[number]

export const ROUTE_TITLES: Record<Route, string> = {
  monitor: 'Monitor',
  'load-test': 'Load Testing',
}

export const routeHref = (route: Route): string => `#/${route}`

/** Unknown or missing hashes land on the monitor page. */
export function routeFromHash(hash: string): Route {
  const name = hash.replace(/^#\/?/, '')
  return ROUTES.find((route) => route === name) ?? 'monitor'
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash))
  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  return route
}
