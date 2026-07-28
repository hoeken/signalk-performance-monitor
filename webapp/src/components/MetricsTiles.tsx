import type { MetricsSnapshot } from '../../../src/shared/types'
import { formatBytes, formatMs, formatPercent } from '../format'

interface TileProps {
  label: string
  value: string
  detail?: string
}

function Tile({ label, value, detail }: TileProps) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {detail ? <div className="tile-detail">{detail}</div> : null}
    </div>
  )
}

export function MetricsTiles({ metrics }: { metrics: MetricsSnapshot }) {
  return (
    <div className="tiles" role="group" aria-label="Live metrics">
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
