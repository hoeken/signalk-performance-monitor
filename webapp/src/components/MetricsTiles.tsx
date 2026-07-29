import type { MetricsSnapshot } from '../../../src/shared/types'
import { formatBytes, formatBytesRate, formatMs, formatPercent, formatRate } from '../format'

type Status = 'ok' | 'warn' | 'bad'

/**
 * [warn, bad] cutoffs in the API's SI units (seconds, ratios, bytes/s,
 * events/s). Lower is always better. Classic Node.js guidance rather than
 * anything tuned to a particular install: loop delay under 50 ms is
 * responsive and past 100 ms is blocking; utilization follows the
 * conventional 70%/90% bands; GC over 5%/10% of wall time; HTTP p99 per
 * Apdex (tolerable 0.5 s, frustrated 2 s). The OS-level rates have no
 * canon — they sit an order of magnitude above a quiet server's baseline.
 */
const CUTOFFS = {
  loopDelayP99: [0.05, 0.1],
  loopUtilization: [0.7, 0.9],
  cpu: [0.7, 0.9],
  /** 5%/10% of the default 5 s publish interval. */
  gcPause: [0.25, 0.5],
  /** Against the classic ~1.5 GB 64-bit default old-space limit. */
  heapUsed: [1e9, 1.5e9],
  httpP99: [0.5, 2],
  httpRate: [50, 200],
  /** Sustained writes matter for SD-card longevity as much as throughput. */
  diskWrite: [1e6, 1e7],
  ctxSwitches: [500, 5000],
  pageFaults: [1, 25],
} satisfies Record<string, [number, number]>

function statusOf(value: number, [warn, bad]: [number, number]): Status {
  if (value >= bad) return 'bad'
  if (value >= warn) return 'warn'
  return 'ok'
}

const STATUS_COLOR: Record<Status, string> = {
  ok: 'var(--status-ok)',
  warn: 'var(--status-warn)',
  bad: 'var(--status-bad)',
}

/** Triangle (warn) / octagon (bad) so state survives grayscale and CVD. */
function StatusIcon({ status }: { status: Status }) {
  if (status === 'ok') return null
  return (
    <svg viewBox="0 0 12 12" className="inline-block size-3 shrink-0" aria-hidden="true">
      {status === 'warn' ? (
        <path d="M6 1 11.5 11H.5Z" fill="currentColor" />
      ) : (
        <path d="M3.8.5h4.4l3.3 3.3v4.4l-3.3 3.3H3.8L.5 8.2V3.8Z" fill="currentColor" />
      )}
    </svg>
  )
}

interface TileProps {
  label: string
  value: string
  status?: Status
  details?: string[]
}

function Tile({ label, value, status, details }: TileProps) {
  return (
    <div className="stat content-start rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
      <div className="stat-title text-xs whitespace-normal">{label}</div>
      <div
        className="stat-value flex items-center gap-1.5 text-2xl"
        style={status ? { color: STATUS_COLOR[status] } : undefined}
      >
        <StatusIcon status={status ?? 'ok'} />
        {value}
        {status === 'warn' && <span className="sr-only">warning</span>}
        {status === 'bad' && <span className="sr-only">critical</span>}
      </div>
      {details?.map((detail) => (
        <div key={detail} className="stat-desc whitespace-nowrap">
          {detail}
        </div>
      ))}
    </div>
  )
}

export function MetricsTiles({ metrics }: { metrics: MetricsSnapshot }) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3"
      role="group"
      aria-label="Live metrics"
    >
      <Tile
        label="Loop delay p99"
        value={formatMs(metrics.eventLoopDelay.p99)}
        status={statusOf(metrics.eventLoopDelay.p99, CUTOFFS.loopDelayP99)}
        details={[
          `p50 ${formatMs(metrics.eventLoopDelay.p50)}`,
          `max ${formatMs(metrics.eventLoopDelay.max)}`,
        ]}
      />
      <Tile
        label="Loop utilization"
        value={formatPercent(metrics.eventLoopUtilization)}
        status={statusOf(metrics.eventLoopUtilization, CUTOFFS.loopUtilization)}
      />
      <Tile
        label="CPU"
        value={formatPercent(metrics.cpuUtilization)}
        status={statusOf(metrics.cpuUtilization, CUTOFFS.cpu)}
      />
      <Tile
        label="GC pause / interval"
        value={formatMs(metrics.gcPauseTime)}
        status={statusOf(metrics.gcPauseTime, CUTOFFS.gcPause)}
      />
      <Tile
        label="Heap used"
        value={formatBytes(metrics.memory.heapUsed)}
        status={statusOf(metrics.memory.heapUsed, CUTOFFS.heapUsed)}
        details={[`RSS ${formatBytes(metrics.memory.rss)}`]}
      />
      <Tile
        label="HTTP req p99"
        value={formatMs(metrics.http.requestDuration.p99)}
        status={statusOf(metrics.http.requestDuration.p99, CUTOFFS.httpP99)}
        details={[
          `p50 ${formatMs(metrics.http.requestDuration.p50)}`,
          `max ${formatMs(metrics.http.requestDuration.max)}`,
        ]}
      />
      <Tile
        label="HTTP requests"
        value={formatRate(metrics.http.requestRate)}
        status={statusOf(metrics.http.requestRate, CUTOFFS.httpRate)}
      />
      <Tile
        label="Disk writes"
        value={formatBytesRate(metrics.resources.diskWriteRate)}
        status={statusOf(metrics.resources.diskWriteRate, CUTOFFS.diskWrite)}
        details={[`reads ${formatBytesRate(metrics.resources.diskReadRate)}`]}
      />
      <Tile
        label="Ctx switches (invol.)"
        value={formatRate(metrics.resources.involuntaryContextSwitchRate)}
        status={statusOf(metrics.resources.involuntaryContextSwitchRate, CUTOFFS.ctxSwitches)}
      />
      <Tile
        label="Major page faults"
        value={formatRate(metrics.resources.majorPageFaultRate)}
        status={statusOf(metrics.resources.majorPageFaultRate, CUTOFFS.pageFaults)}
      />
    </div>
  )
}
