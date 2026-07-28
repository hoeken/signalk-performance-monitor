import type { MetricsSnapshot } from '../../../src/shared/types'
import { formatBytes, formatMs, formatPercent } from '../format'

interface TileProps {
  label: string
  value: string
  detail?: string
}

function Tile({ label, value, detail }: TileProps) {
  return (
    <div className="stat rounded-box border border-base-300 bg-base-100 p-4 shadow-sm">
      <div className="stat-title text-xs whitespace-normal">{label}</div>
      <div className="stat-value text-2xl">{value}</div>
      {detail ? <div className="stat-desc whitespace-normal">{detail}</div> : null}
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
        detail={`p50 ${formatMs(metrics.eventLoopDelay.p50)} · max ${formatMs(
          metrics.eventLoopDelay.max,
        )}`}
      />
      <Tile label="Loop utilization" value={formatPercent(metrics.eventLoopUtilization)} />
      <Tile label="CPU" value={formatPercent(metrics.cpuUtilization)} />
      <Tile label="GC pause / interval" value={formatMs(metrics.gcPauseTime)} />
      <Tile
        label="Heap used"
        value={formatBytes(metrics.memory.heapUsed)}
        detail={`RSS ${formatBytes(metrics.memory.rss)}`}
      />
    </div>
  )
}
