import { useEffect, useState } from 'react'
import type { MetricsSnapshot } from '../../src/shared/types'
import { ApiError, getMetrics } from './api'
import { formatDateTime } from './format'
import { LoadTestPage } from './components/LoadTestPage'
import { MonitorPage } from './components/MonitorPage'
import { NavBar } from './components/NavBar'
import { useRoute } from './route'

const METRICS_POLL_MS = 2000

/**
 * Shell: nav bar, the metrics poll (every page shows the tiles, so one poll
 * lives here), and the auth-error banner. Page state belongs to the pages.
 */
export function App() {
  const route = useRoute()
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const snapshot = await getMetrics()
        if (!cancelled) setMetrics(snapshot)
      } catch (err) {
        if (!cancelled && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setAuthError(err.message)
        }
      }
    }
    void poll()
    const timer = setInterval(poll, METRICS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="min-h-screen bg-base-200">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
        <NavBar
          route={route}
          subtitle={metrics ? `updated ${formatDateTime(metrics.timestamp)}` : undefined}
        />

        {authError ? (
          <div className="alert alert-error alert-soft" role="alert">
            {authError}
          </div>
        ) : null}

        {route === 'load-test' ? <LoadTestPage /> : <MonitorPage metrics={metrics} />}
      </div>
    </div>
  )
}
