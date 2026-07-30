import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ProfileType } from '../../../src/shared/types'
import { startProfile } from '../api'
import { formatBytes, formatRate } from '../format'
import {
  DEFAULT_LOAD_TEST_CONFIG,
  DeltaLoadTest,
  TEST_PATH_PREFIX,
  messageRateOf,
  normalizeConfig,
  type DeltaLoadTestStats,
} from '../loadTest'
import { routeHref } from '../route'

/**
 * Load generation. One tester for now (websocket delta publishing); the
 * test-type select is the seam the next one plugs into.
 */

/** Only member so far — kept as a list so adding a tester is additive. */
const TEST_TYPES = [{ id: 'delta', label: 'Delta publishing (websocket)' }] as const

type TestTypeId = (typeof TEST_TYPES)[number]['id']

/** 'none' is not a ProfileType, hence the widened union. */
type ProfileChoice = 'none' | Extract<ProfileType, 'cpu' | 'heap'>

const PROFILE_CHOICES: { id: ProfileChoice; label: string }[] = [
  { id: 'none', label: 'No profile' },
  { id: 'cpu', label: 'CPU profile' },
  { id: 'heap', label: 'Memory profile' },
]

interface Field {
  key: 'durationSeconds' | 'pathCount' | 'deltaRate' | 'deltasPerMessage'
  label: string
  min: number
  max: number
  hint: string
}

const FIELDS: Field[] = [
  {
    key: 'durationSeconds',
    label: 'Test duration (seconds)',
    min: 1,
    max: 3600,
    hint: 'Also the profile duration, when one is selected.',
  },
  {
    key: 'pathCount',
    label: 'Number of paths',
    min: 1,
    max: 100000,
    hint: `Distinct ${TEST_PATH_PREFIX}.<n> paths, cycled round-robin.`,
  },
  {
    key: 'deltaRate',
    label: 'Delta rate (Hz)',
    min: 1,
    max: 100000,
    hint: 'Path/value updates per second, aggregate.',
  },
  {
    key: 'deltasPerMessage',
    label: 'Deltas per message',
    min: 1,
    max: 1000,
    hint: 'Batch size; divides the delta rate into the message rate.',
  },
]

type FormValues = Record<Field['key'], string>

const INITIAL_VALUES: FormValues = {
  durationSeconds: String(DEFAULT_LOAD_TEST_CONFIG.durationSeconds),
  pathCount: String(DEFAULT_LOAD_TEST_CONFIG.pathCount),
  deltaRate: String(DEFAULT_LOAD_TEST_CONFIG.deltaRate),
  deltasPerMessage: String(DEFAULT_LOAD_TEST_CONFIG.deltasPerMessage),
}

export function LoadTestPage() {
  const [testType, setTestType] = useState<TestTypeId>('delta')
  const [profileChoice, setProfileChoice] = useState<ProfileChoice>('none')
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES)
  const [stats, setStats] = useState<DeltaLoadTestStats | null>(null)

  // What the *current* run was started with: the engine's beforeRun hook is
  // installed once, so it reads the request from here rather than closing
  // over the form state it was created with.
  const run = useRef<{ durationSeconds: number; profile: ProfileChoice }>({
    durationSeconds: DEFAULT_LOAD_TEST_CONFIG.durationSeconds,
    profile: 'none',
  })
  const [test] = useState(
    () =>
      new DeltaLoadTest({
        onStats: setStats,
        beforeRun: async () => {
          const { profile, durationSeconds } = run.current
          if (profile === 'none') return
          await startProfile(profile, durationSeconds)
        },
      }),
  )

  // A run is bound to this page: navigating away closes the socket rather
  // than leaving a hidden load on the server.
  useEffect(() => () => test.stop(), [test])

  const busy = stats?.state === 'connecting' || stats?.state === 'running'
  const config = normalizeConfig({
    durationSeconds: Number(values.durationSeconds),
    pathCount: Number(values.pathCount),
    deltaRate: Number(values.deltaRate),
    deltasPerMessage: Number(values.deltasPerMessage),
  })

  const handleStart = () => {
    run.current = { durationSeconds: config.durationSeconds, profile: profileChoice }
    test.start(config)
  }

  return (
    <>
      {stats?.error ? (
        <div className="alert alert-error alert-soft" role="alert">
          {stats.error}
        </div>
      ) : null}

      <section aria-labelledby="load-test-heading" className="flex flex-col gap-2">
        <h2 id="load-test-heading" className="text-sm font-semibold text-base-content/60">
          Load test
        </h2>
        <div className="card border border-base-300 bg-base-100 shadow-sm">
          <div className="card-body gap-4 p-5">
            <div className="flex flex-wrap items-end gap-4">
              <Labelled id="load-test-type" label="Test type">
                <select
                  id="load-test-type"
                  className="select select-sm w-64"
                  value={testType}
                  disabled={busy}
                  onChange={(event) => setTestType(event.target.value as TestTypeId)}
                >
                  {TEST_TYPES.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </Labelled>
              <Labelled id="load-test-profile" label="Profile during test">
                <select
                  id="load-test-profile"
                  className="select select-sm w-44"
                  value={profileChoice}
                  disabled={busy}
                  onChange={(event) => setProfileChoice(event.target.value as ProfileChoice)}
                >
                  {PROFILE_CHOICES.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Labelled>
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-4">
              {FIELDS.map((field) => (
                <Labelled
                  key={field.key}
                  id={`load-test-${field.key}`}
                  label={field.label}
                  hint={field.hint}
                >
                  <input
                    id={`load-test-${field.key}`}
                    type="number"
                    className="input input-sm w-full"
                    min={field.min}
                    max={field.max}
                    step={1}
                    value={values[field.key]}
                    disabled={busy}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                    }
                  />
                </Labelled>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {busy ? (
                <button
                  type="button"
                  className="btn btn-sm btn-error btn-outline"
                  onClick={() => test.stop()}
                >
                  Stop test
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary btn-outline"
                  onClick={handleStart}
                >
                  Start test
                </button>
              )}
              <span className="text-sm text-base-content/60">
                {config.deltaRate.toLocaleString()} deltas/s in {formatCount(messageRateOf(config))}{' '}
                messages/s over {config.pathCount.toLocaleString()} paths for{' '}
                {config.durationSeconds}s
              </span>
            </div>

            {stats ? <RunStatus stats={stats} durationSeconds={config.durationSeconds} /> : null}

            {stats?.state === 'finished' && run.current.profile !== 'none' ? (
              <p className="text-sm text-base-content/70">
                The capture is on the{' '}
                <a className="link" href={routeHref('monitor')}>
                  Monitor
                </a>{' '}
                page under Profiling.
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <section aria-labelledby="load-test-docs-heading" className="flex flex-col gap-2">
        <h2 id="load-test-docs-heading" className="text-sm font-semibold text-base-content/60">
          About load testing
        </h2>
        <LoadTestDocs />
      </section>
    </>
  )
}

/**
 * Field name above the control, hint below it. The hint sits outside the
 * <label> deliberately: inside, it would become part of the control's
 * accessible name.
 */
function Labelled({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? <span className="text-xs text-base-content/60">{hint}</span> : null}
    </div>
  )
}

/** Whole numbers plain, fractions to one decimal — 500 deltas/s ÷ 3 is 166.7 msg/s. */
const formatCount = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 1 })

const STATE_LABELS: Record<DeltaLoadTestStats['state'], string> = {
  idle: 'Idle',
  connecting: 'Connecting…',
  running: 'Running',
  finished: 'Finished',
  error: 'Failed',
}

function RunStatus({
  stats,
  durationSeconds,
}: {
  stats: DeltaLoadTestStats
  durationSeconds: number
}) {
  const progress = durationSeconds > 0 ? Math.min(1, stats.elapsedSeconds / durationSeconds) : 0
  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Load test progress">
      <div className="flex items-center gap-3">
        <span className="text-sm whitespace-nowrap">
          {STATE_LABELS[stats.state]}: {stats.elapsedSeconds.toFixed(1)}s
        </span>
        <progress
          className="progress progress-primary flex-1"
          value={progress}
          max={1}
          aria-label="Test progress"
        />
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        <Stat
          label="Sent"
          value={stats.deltasSent.toLocaleString()}
          desc={`deltas in ${stats.messagesSent.toLocaleString()} messages`}
        />
        <Stat label="Deltas/s" value={formatRate(stats.achievedDeltaRate)} />
        <Stat label="Messages/s" value={formatRate(stats.achievedMessageRate)} />
        <Stat label="Bytes sent" value={formatBytes(stats.bytesSent)} />
        <Stat label="Skipped" value={stats.skippedDeltas.toLocaleString()} desc="deltas" />
      </div>
    </div>
  )
}

function Stat({ label, value, desc }: { label: string; value: string; desc?: string }) {
  return (
    <div className="stat content-start rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
      <div className="stat-title text-xs whitespace-normal">{label}</div>
      <div className="stat-value text-2xl">{value}</div>
      {desc ? <div className="stat-desc whitespace-nowrap">{desc}</div> : null}
    </div>
  )
}

function LoadTestDocs() {
  return (
    <details className="collapse-arrow collapse border border-base-300 bg-base-100 shadow-sm">
      <summary className="collapse-title font-medium">How the delta publishing test works</summary>
      <div className="collapse-content flex flex-col gap-3 text-sm leading-relaxed text-base-content/80">
        <p>
          Your browser opens a websocket to this server&apos;s delta stream (
          <code>/signalk/v1/stream</code>, with incoming deltas turned off) and publishes random
          numbers to <code>{TEST_PATH_PREFIX}.0</code> … <code>{TEST_PATH_PREFIX}.N</code> on{' '}
          <code>vessels.self</code> at the configured rate. That is the same path a real producer
          takes — parse, full-model update, subscription fan-out — so it stresses the server rather
          than this plugin.
        </p>
        <p>
          A <strong>delta</strong> is one path/value update — the unit of work the server does — and
          a <strong>message</strong> is the websocket envelope carrying one or more of them. So the{' '}
          <strong>delta rate</strong> sets the load, and <strong>deltas per message</strong> divides
          it into the message rate: 500 deltas/s at 5 per message is 100 messages/s. Batching keeps
          the load identical while cutting envelope and framing overhead, which is exactly the
          comparison worth running.
        </p>
        <p>
          Pick a <strong>CPU profile</strong> to find out where the time goes, or a{' '}
          <strong>Memory profile</strong> to see what the delta path allocates — the capture starts
          with the first delta and covers the whole run, and lands in the profile list on the{' '}
          <a className="link" href={routeHref('monitor')}>
            Monitor
          </a>{' '}
          page. To watch loop delay p99 and CPU live instead, open the Monitor page in a second tab:
          the interesting question is the rate at which those numbers stop being flat.
        </p>
        <p>
          <strong>Skipped</strong> counts deltas the browser gave up on because the socket&apos;s
          send buffer was backing up (the server is behind) or because the tab was throttled — a
          background tab throttles timers hard, so keep this tab visible. <strong>Deltas/s</strong>{' '}
          and <strong>Messages/s</strong> are what was actually achieved; if they sit well under the
          configured rate, the bottleneck may be the browser and not the server.
        </p>
        <p>
          The test paths stay in the server&apos;s full model until it restarts. Path ids are
          sequential so repeated runs reuse the same paths instead of accumulating new ones, and the
          test leaves nothing else behind. Leaving this page stops the run.
        </p>
      </div>
    </details>
  )
}
