import type { MetricsSnapshot } from '../../../src/shared/types'
import { formatBytes, formatBytesRate, formatMs, formatPercent, formatRate } from '../format'

interface TileProps {
  label: string
  value: string
  details?: string[]
}

function Tile({ label, value, details }: TileProps) {
  return (
    <div className="stat content-start rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
      <div className="stat-title text-xs whitespace-normal">{label}</div>
      <div className="stat-value text-2xl">{value}</div>
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
        details={[
          `p50 ${formatMs(metrics.eventLoopDelay.p50)}`,
          `max ${formatMs(metrics.eventLoopDelay.max)}`,
        ]}
      />
      <Tile label="Loop utilization" value={formatPercent(metrics.eventLoopUtilization)} />
      <Tile label="CPU" value={formatPercent(metrics.cpuUtilization)} />
      <Tile label="GC pause / interval" value={formatMs(metrics.gcPauseTime)} />
      <Tile
        label="Heap used"
        value={formatBytes(metrics.memory.heapUsed)}
        details={[`RSS ${formatBytes(metrics.memory.rss)}`]}
      />
      <Tile
        label="HTTP req p99"
        value={formatMs(metrics.http.requestDuration.p99)}
        details={[
          `p50 ${formatMs(metrics.http.requestDuration.p50)}`,
          `max ${formatMs(metrics.http.requestDuration.max)}`,
        ]}
      />
      <Tile label="HTTP requests" value={formatRate(metrics.http.requestRate)} />
      <Tile
        label="Disk writes"
        value={formatBytesRate(metrics.resources.diskWriteRate)}
        details={[`reads ${formatBytesRate(metrics.resources.diskReadRate)}`]}
      />
      <Tile
        label="Ctx switches (invol.)"
        value={formatRate(metrics.resources.involuntaryContextSwitchRate)}
      />
      <Tile label="Major page faults" value={formatRate(metrics.resources.majorPageFaultRate)} />
    </div>
  )
}
