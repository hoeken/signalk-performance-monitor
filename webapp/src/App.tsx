import { useCallback, useEffect, useState } from 'react'
import type {
  MetricsSnapshot,
  ProfileListResponse,
  ProfileReport,
  ProfileType,
} from '../../src/shared/types'
import { ApiError, deleteProfile, getMetrics, getProfiles, getReport, startProfile } from './api'
import { MetricsTiles } from './components/MetricsTiles'
import { ProfileControls } from './components/ProfileControls'
import { ProfileList } from './components/ProfileList'
import { ReportView } from './components/ReportView'

const METRICS_POLL_MS = 2000
const PROFILES_POLL_MS = 5000
const RUNNING_POLL_MS = 1000

export function App() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [profiles, setProfiles] = useState<ProfileListResponse | null>(null)
  const [report, setReport] = useState<ProfileReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = profiles?.running ?? null
  const isRunning = running !== null

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await getProfiles())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const snapshot = await getMetrics()
        if (!cancelled) setMetrics(snapshot)
      } catch (err) {
        if (!cancelled && err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setError(err.message)
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

  // Re-armed when a capture starts/ends so polling speeds up while running.
  useEffect(() => {
    void refreshProfiles()
    const timer = setInterval(
      () => void refreshProfiles(),
      isRunning ? RUNNING_POLL_MS : PROFILES_POLL_MS,
    )
    return () => clearInterval(timer)
  }, [refreshProfiles, isRunning])

  const handleStart = async (type: ProfileType, durationSeconds: number) => {
    try {
      await startProfile(type, durationSeconds)
      setError(null)
      await refreshProfiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSelect = async (id: string) => {
    try {
      setReport(await getReport(id))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteProfile(id)
      if (report?.id === id) setReport(null)
      await refreshProfiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="app viz-root">
      <header>
        <h1>Performance Monitor</h1>
        {metrics ? <span className="updated">updated {metrics.timestamp}</span> : null}
      </header>

      {error ? (
        <div className="banner" role="alert">
          {error}
        </div>
      ) : null}

      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading">Live metrics</h2>
        {metrics ? (
          <MetricsTiles metrics={metrics} />
        ) : (
          <p className="empty">Waiting for metrics…</p>
        )}
      </section>

      <section aria-labelledby="profiling-heading">
        <h2 id="profiling-heading">Profiling</h2>
        <ProfileControls running={running} onStart={(type, d) => void handleStart(type, d)} />
        {profiles ? (
          <ProfileList
            profiles={profiles.profiles}
            selectedId={report?.id ?? null}
            onSelect={(id) => void handleSelect(id)}
            onDelete={(id) => void handleDelete(id)}
          />
        ) : null}
      </section>

      {report ? (
        <section aria-labelledby="report-heading">
          <h2 id="report-heading">Per-plugin report</h2>
          <ReportView report={report} />
        </section>
      ) : null}
    </div>
  )
}
