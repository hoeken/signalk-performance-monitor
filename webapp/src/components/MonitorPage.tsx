import { useCallback, useEffect, useState } from 'react'
import type {
  HttpRequestsResponse,
  MetricsSnapshot,
  ProfileListResponse,
  ProfileReport,
  ProfileType,
} from '../../../src/shared/types'
import {
  deleteProfile,
  getHttpRequests,
  getProfiles,
  getReport,
  isAuthError,
  resetHttpRequests,
  startProfile,
  uploadProfile,
} from '../api'
import { Documentation } from './Documentation'
import { HttpRequests } from './HttpRequests'
import { MetricsTiles } from './MetricsTiles'
import { ProfileControls } from './ProfileControls'
import { ProfileList } from './ProfileList'
import { ReportView } from './ReportView'

const PROFILES_POLL_MS = 5000
const RUNNING_POLL_MS = 1000
const HTTP_REQUESTS_POLL_MS = 5000

/** Live metrics, profiling, request tracking — the plugin's default page. */
export function MonitorPage({ metrics }: { metrics: MetricsSnapshot | null }) {
  const [httpRequests, setHttpRequests] = useState<HttpRequestsResponse | null>(null)
  const [profiles, setProfiles] = useState<ProfileListResponse | null>(null)
  const [report, setReport] = useState<ProfileReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = profiles?.running ?? null
  const isRunning = running !== null

  // The shell's banner owns auth failures, so they aren't repeated here.
  const reportError = useCallback((err: unknown) => {
    setError(isAuthError(err) ? null : err instanceof Error ? err.message : String(err))
  }, [])

  const refreshProfiles = useCallback(async () => {
    try {
      setProfiles(await getProfiles())
      setError(null)
    } catch (err) {
      reportError(err)
    }
  }, [reportError])

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const data = await getHttpRequests()
        if (!cancelled) setHttpRequests(data)
      } catch {
        // transient; the metrics poll surfaces auth errors
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), HTTP_REQUESTS_POLL_MS)
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

  // Clear the server-side tracking, then refetch so the tables empty
  // immediately instead of on the next poll tick.
  const handleHttpRequestsReset = async () => {
    try {
      await resetHttpRequests()
      setHttpRequests(await getHttpRequests())
      setError(null)
    } catch (err) {
      reportError(err)
    }
  }

  const handleStart = async (type: ProfileType, durationSeconds: number) => {
    try {
      await startProfile(type, durationSeconds)
      setError(null)
      await refreshProfiles()
    } catch (err) {
      reportError(err)
    }
  }

  const handleSelect = async (id: string) => {
    if (report?.id === id) {
      setReport(null)
      return
    }
    try {
      setReport(await getReport(id))
      setError(null)
    } catch (err) {
      reportError(err)
    }
  }

  const handleUpload = async (file: File) => {
    try {
      const { id } = await uploadProfile(file)
      setError(null)
      await refreshProfiles()
      setReport(await getReport(id))
    } catch (err) {
      reportError(err)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteProfile(id)
      if (report?.id === id) setReport(null)
      await refreshProfiles()
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <>
      {error ? (
        <div className="alert alert-error alert-soft" role="alert">
          {error}
        </div>
      ) : null}

      <section aria-labelledby="metrics-heading" className="flex flex-col gap-2">
        <h2 id="metrics-heading" className="text-sm font-semibold text-base-content/60">
          Live metrics
        </h2>
        {metrics ? (
          <MetricsTiles metrics={metrics} />
        ) : (
          <p className="text-sm text-base-content/60">Waiting for metrics…</p>
        )}
      </section>

      <section aria-labelledby="profiling-heading" className="flex flex-col gap-2">
        <h2 id="profiling-heading" className="text-sm font-semibold text-base-content/60">
          Profiling
        </h2>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4 p-5">
            <ProfileControls
              running={running}
              onStart={(type, d) => void handleStart(type, d)}
              onUpload={(file) => void handleUpload(file)}
            />
            {profiles ? (
              <ProfileList
                profiles={profiles.profiles}
                selectedId={report?.id ?? null}
                onSelect={(id) => void handleSelect(id)}
                onDelete={(id) => void handleDelete(id)}
              />
            ) : null}
          </div>
        </div>
      </section>

      {report ? (
        <section aria-labelledby="report-heading" className="flex flex-col gap-2">
          <h2 id="report-heading" className="text-sm font-semibold text-base-content/60">
            Report
          </h2>
          <div className="card border border-base-300 bg-base-100 shadow-sm">
            <div className="card-body gap-3 p-5">
              <ReportView report={report} />
            </div>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="http-requests-heading" className="flex flex-col gap-2">
        <h2 id="http-requests-heading" className="text-sm font-semibold text-base-content/60">
          HTTP Requests
        </h2>
        <HttpRequests data={httpRequests} onReset={handleHttpRequestsReset} />
      </section>

      <section aria-labelledby="documentation-heading" className="flex flex-col gap-2">
        <h2 id="documentation-heading" className="text-sm font-semibold text-base-content/60">
          Documentation
        </h2>
        <Documentation />
      </section>
    </>
  )
}
