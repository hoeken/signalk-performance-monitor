/**
 * Signal K delta shaping for metrics snapshots.
 *
 * Paths are precomputed once at module load; each publish builds a single
 * object literal (the server's hot-path rule: no per-interval allocation
 * churn beyond the delta itself).
 */
import type { Delta, Path } from '@signalk/server-api'
import type { MetricsSnapshot } from './shared/types'

interface MetricPaths {
  eventLoopDelayP50: Path
  eventLoopDelayP99: Path
  eventLoopDelayMax: Path
  eventLoopUtilization: Path
  gcPauseTime: Path
  memoryHeapUsed: Path
  memoryRss: Path
  cpuUtilization: Path
}

/** All metrics publish under the fixed `performance.` prefix. */
const paths: MetricPaths = {
  eventLoopDelayP50: 'performance.eventLoopDelay.p50' as Path,
  eventLoopDelayP99: 'performance.eventLoopDelay.p99' as Path,
  eventLoopDelayMax: 'performance.eventLoopDelay.max' as Path,
  eventLoopUtilization: 'performance.eventLoopUtilization' as Path,
  gcPauseTime: 'performance.gc.pauseTime' as Path,
  memoryHeapUsed: 'performance.memory.heapUsed' as Path,
  memoryRss: 'performance.memory.rss' as Path,
  cpuUtilization: 'performance.cpu.utilization' as Path,
}

export function buildMetricsDelta(snapshot: MetricsSnapshot): Delta {
  return {
    updates: [
      {
        values: [
          { path: paths.eventLoopDelayP50, value: snapshot.eventLoopDelay.p50 },
          { path: paths.eventLoopDelayP99, value: snapshot.eventLoopDelay.p99 },
          { path: paths.eventLoopDelayMax, value: snapshot.eventLoopDelay.max },
          { path: paths.eventLoopUtilization, value: snapshot.eventLoopUtilization },
          { path: paths.gcPauseTime, value: snapshot.gcPauseTime },
          { path: paths.memoryHeapUsed, value: snapshot.memory.heapUsed },
          { path: paths.memoryRss, value: snapshot.memory.rss },
          { path: paths.cpuUtilization, value: snapshot.cpuUtilization },
        ],
      },
    ],
  }
}

/** Units metadata, emitted once on the first publish (SI units per Signal K convention). */
export function buildMetaDelta(): Delta {
  return {
    updates: [
      {
        meta: [
          {
            path: paths.eventLoopDelayP50,
            value: { units: 's', description: 'Median event-loop delay over the last interval' },
          },
          {
            path: paths.eventLoopDelayP99,
            value: {
              units: 's',
              description: '99th percentile event-loop delay over the last interval',
            },
          },
          {
            path: paths.eventLoopDelayMax,
            value: { units: 's', description: 'Maximum event-loop delay over the last interval' },
          },
          {
            path: paths.eventLoopUtilization,
            value: {
              units: 'ratio',
              description: 'Event-loop utilization (0-1) over the last interval',
            },
          },
          {
            path: paths.gcPauseTime,
            value: {
              units: 's',
              description: 'Total garbage-collection pause time over the last interval',
            },
          },
          {
            path: paths.memoryHeapUsed,
            value: { units: 'B', description: 'V8 heap used' },
          },
          {
            path: paths.memoryRss,
            value: { units: 'B', description: 'Process resident set size' },
          },
          {
            path: paths.cpuUtilization,
            value: {
              units: 'ratio',
              description: 'Process CPU time / wall time over the last interval',
            },
          },
        ],
      },
    ],
  }
}
