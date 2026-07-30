import { ROUTES, ROUTE_TITLES, routeHref, type Route } from '../route'
import { ThemeToggle } from './ThemeToggle'

/**
 * App header: title, page links, theme toggle. The links are real anchors on
 * the hash routes so they deep-link, open in a new tab, and keep browser
 * back/forward working.
 */
export function NavBar({ route, subtitle }: { route: Route; subtitle?: string }) {
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-1.5">
        <h1 className="text-xl font-semibold">Performance Monitor</h1>
        <ThemeToggle />
      </div>
      <nav aria-label="Pages" className="tabs tabs-box tabs-sm">
        {ROUTES.map((name) => (
          <a
            key={name}
            href={routeHref(name)}
            className={`tab${name === route ? ' tab-active' : ''}`}
            aria-current={name === route ? 'page' : undefined}
          >
            {ROUTE_TITLES[name]}
          </a>
        ))}
      </nav>
      {subtitle ? <span className="ml-auto text-xs text-base-content/60">{subtitle}</span> : null}
    </header>
  )
}
