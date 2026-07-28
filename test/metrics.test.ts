import { describe, expect, it } from 'vitest'
import { buildMetaDelta, buildMetricPaths, buildMetricsDelta } from '../src/deltas'
import { MetricsCollector } from '../src/metrics'
import type { MetricsSnapshot } from '../src/shared/types'

function busyWait(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    Math.sqrt(Math.random())
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('MetricsCollector', () => {
  it('produces a sane snapshot under load', async () => {
    const collector = new MetricsCollector()
    collector.start()
    try {
      busyWait(60)
      await sleep(120)

      const snapshot = collector.sample()
      expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(snapshot.eventLoopDelay.p50).toBeGreaterThanOrEqual(0)
      expect(snapshot.eventLoopDelay.p99).toBeGreaterThanOrEqual(snapshot.eventLoopDelay.p50)
      expect(snapshot.eventLoopDelay.max).toBeGreaterThanOrEqual(snapshot.eventLoopDelay.p99)
      expect(snapshot.eventLoopUtilization).toBeGreaterThan(0)
      expect(snapshot.eventLoopUtilization).toBeLessThanOrEqual(1)
      expect(snapshot.cpuUtilization).toBeGreaterThan(0)
      expect(snapshot.gcPauseTime).toBeGreaterThanOrEqual(0)
      expect(snapshot.memory.heapUsed).toBeGreaterThan(0)
      expect(snapshot.memory.rss).toBeGreaterThan(snapshot.memory.heapUsed)
      expect(collector.latest()).toBe(snapshot)
    } finally {
      collector.stop()
    }
  })

  it('resets interval accumulators between samples', async () => {
    const collector = new MetricsCollector()
    collector.start()
    try {
      busyWait(50)
      await sleep(50)
      const first = collector.sample()
      // An idle interval after a busy one must not inherit the busy max.
      await sleep(150)
      const second = collector.sample()
      expect(second.eventLoopDelay.max).toBeLessThanOrEqual(first.eventLoopDelay.max + 0.001)
      expect(second.cpuUtilization).toBeLessThan(first.cpuUtilization)
    } finally {
      collector.stop()
    }
  })

  it('throws if sampled before start', () => {
    const collector = new MetricsCollector()
    expect(() => collector.sample()).toThrow(/before start/)
  })
})

describe('delta shaping', () => {
  const snapshot: MetricsSnapshot = {
    timestamp: '2026-07-28T00:00:00.000Z',
    eventLoopDelay: { p50: 0.0021, p99: 0.0113, max: 0.0405 },
    eventLoopUtilization: 0.42,
    gcPauseTime: 0.003,
    memory: { heapUsed: 51234816, rss: 98765824 },
    cpuUtilization: 0.37,
  }

  it('publishes every metric under the configured prefix in one update', () => {
    const paths = buildMetricPaths('performance')
    const delta = buildMetricsDelta(paths, snapshot)
    expect(delta.updates).toHaveLength(1)
    const update = delta.updates[0]
    if (!('values' in update)) throw new Error('expected a values update')
    expect(update.values).toEqual([
      { path: 'performance.eventLoopDelay.p50', value: 0.0021 },
      { path: 'performance.eventLoopDelay.p99', value: 0.0113 },
      { path: 'performance.eventLoopDelay.max', value: 0.0405 },
      { path: 'performance.eventLoopUtilization', value: 0.42 },
      { path: 'performance.gc.pauseTime', value: 0.003 },
      { path: 'performance.memory.heapUsed', value: 51234816 },
      { path: 'performance.memory.rss', value: 98765824 },
      { path: 'performance.cpu.utilization', value: 0.37 },
    ])
  })

  it('respects a custom path prefix', () => {
    const paths = buildMetricPaths('server.perf')
    const delta = buildMetricsDelta(paths, snapshot)
    const update = delta.updates[0]
    if (!('values' in update)) throw new Error('expected a values update')
    expect(update.values[0].path).toBe('server.perf.eventLoopDelay.p50')
  })

  it('emits SI units metadata for every published path', () => {
    const paths = buildMetricPaths('performance')
    const metaDelta = buildMetaDelta(paths)
    const update = metaDelta.updates[0]
    if (!('meta' in update)) throw new Error('expected a meta update')
    const units = Object.fromEntries(update.meta.map((m) => [m.path, m.value.units]))
    expect(units).toEqual({
      'performance.eventLoopDelay.p50': 's',
      'performance.eventLoopDelay.p99': 's',
      'performance.eventLoopDelay.max': 's',
      'performance.eventLoopUtilization': 'ratio',
      'performance.gc.pauseTime': 's',
      'performance.memory.heapUsed': 'B',
      'performance.memory.rss': 'B',
      'performance.cpu.utilization': 'ratio',
    })
  })
})
