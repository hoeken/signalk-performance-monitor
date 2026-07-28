import { createServer, get, type Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { buildMetaDelta, buildMetricsDelta } from '../src/deltas'
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
      // rss reads /proc/self/stat, which reports 0 under QEMU user-mode
      // emulation (armv7 CI) — only compare when the OS actually reports it.
      expect(snapshot.memory.rss).toBeGreaterThanOrEqual(0)
      if (snapshot.memory.rss > 0) {
        expect(snapshot.memory.rss).toBeGreaterThan(snapshot.memory.heapUsed)
      }
      // No HTTP server ran, so the interval is request-free.
      expect(snapshot.http.requestRate).toBe(0)
      expect(snapshot.http.requestDuration).toEqual({ p50: 0, p99: 0, max: 0 })
      expect(snapshot.resources.fsReadRate).toBeGreaterThanOrEqual(0)
      expect(snapshot.resources.fsWriteRate).toBeGreaterThanOrEqual(0)
      expect(snapshot.resources.involuntaryContextSwitchRate).toBeGreaterThanOrEqual(0)
      expect(snapshot.resources.majorPageFaultRate).toBeGreaterThanOrEqual(0)
      expect(collector.latest()).toBe(snapshot)
    } finally {
      collector.stop()
    }
  })

  it('times inbound http requests and resets per interval', async () => {
    const collector = new MetricsCollector()
    collector.start()
    const server: Server = createServer((req, res) => {
      setTimeout(() => res.end('ok'), 10)
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected a port')
      const fetchOnce = () =>
        new Promise<void>((resolve, reject) => {
          get(`http://127.0.0.1:${address.port}/`, (res) => {
            res.resume()
            res.on('end', resolve)
          }).on('error', reject)
        })
      for (let i = 0; i < 5; i++) {
        await fetchOnce()
      }
      // Observer callbacks dispatch asynchronously; give them a beat to land.
      await sleep(50)

      const busy = collector.sample()
      expect(busy.http.requestRate).toBeGreaterThan(0)
      // The handler holds each request for 10ms, and only inbound
      // HttpRequest entries count — outbound client timings (which include
      // connect overhead) are excluded.
      expect(busy.http.requestDuration.p50).toBeGreaterThan(0.005)
      expect(busy.http.requestDuration.p99).toBeGreaterThanOrEqual(busy.http.requestDuration.p50)
      expect(busy.http.requestDuration.max).toBeGreaterThanOrEqual(busy.http.requestDuration.p99)

      // A request-free interval must not inherit the previous one.
      await sleep(50)
      const idle = collector.sample()
      expect(idle.http.requestRate).toBe(0)
      expect(idle.http.requestDuration).toEqual({ p50: 0, p99: 0, max: 0 })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      collector.stop()
    }
  })

  it('diffs resource usage counters into per-second rates', async () => {
    const base: NodeJS.ResourceUsage = {
      userCPUTime: 0,
      systemCPUTime: 0,
      maxRSS: 0,
      sharedMemorySize: 0,
      unsharedDataSize: 0,
      unsharedStackSize: 0,
      minorPageFault: 0,
      majorPageFault: 400,
      swappedOut: 0,
      fsRead: 100,
      fsWrite: 200,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 300,
    }
    const spy = vi
      .spyOn(process, 'resourceUsage')
      .mockReturnValueOnce(base) // baseline taken in start()
      .mockReturnValueOnce({
        ...base,
        fsRead: 150,
        fsWrite: 300,
        involuntaryContextSwitches: 450,
        majorPageFault: 400,
      })
      .mockReturnValueOnce({ ...base, fsRead: 0, fsWrite: 0, involuntaryContextSwitches: 0 })
    const collector = new MetricsCollector()
    collector.start()
    try {
      await sleep(100)
      const first = collector.sample()
      // Deltas were +50 reads, +100 writes, +150 switches, +0 faults over the
      // same wall-clock interval, so the rate ratios are exact.
      expect(first.resources.fsReadRate).toBeGreaterThan(0)
      expect(first.resources.fsWriteRate).toBeCloseTo(first.resources.fsReadRate * 2, 2)
      expect(first.resources.involuntaryContextSwitchRate).toBeCloseTo(
        first.resources.fsReadRate * 3,
        2,
      )
      expect(first.resources.majorPageFaultRate).toBe(0)

      await sleep(20)
      // Counters that go backwards (they shouldn't) clamp to zero, like CPU.
      const second = collector.sample()
      expect(second.resources.fsReadRate).toBe(0)
      expect(second.resources.fsWriteRate).toBe(0)
      expect(second.resources.involuntaryContextSwitchRate).toBe(0)
    } finally {
      collector.stop()
      spy.mockRestore()
    }
  })

  it('resets interval accumulators between samples', async () => {
    const collector = new MetricsCollector()
    collector.start()
    try {
      // Let the delay monitor take its baseline tick before stalling the
      // loop — a block right after enable() is never recorded.
      await sleep(50)
      busyWait(200)
      await sleep(50)
      const first = collector.sample()
      // An idle interval after a busy one must not inherit the busy max.
      await sleep(150)
      const second = collector.sample()
      // The busy interval stalled the loop for ~200ms; a reset histogram in
      // the idle interval reads far lower even on a noisy shared runner.
      expect(first.eventLoopDelay.max).toBeGreaterThan(0.1)
      expect(second.eventLoopDelay.max).toBeLessThan(first.eventLoopDelay.max / 2)
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
    http: { requestRate: 3.4, requestDuration: { p50: 0.0042, p99: 0.0871, max: 0.1502 } },
    resources: {
      fsReadRate: 12,
      fsWriteRate: 45.2,
      involuntaryContextSwitchRate: 123.4,
      majorPageFaultRate: 0.2,
    },
  }

  it('publishes every metric under the performance prefix in one update', () => {
    const delta = buildMetricsDelta(snapshot)
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
      { path: 'performance.http.requestRate', value: 3.4 },
      { path: 'performance.http.requestDuration.p50', value: 0.0042 },
      { path: 'performance.http.requestDuration.p99', value: 0.0871 },
      { path: 'performance.http.requestDuration.max', value: 0.1502 },
      { path: 'performance.disk.readRate', value: 12 },
      { path: 'performance.disk.writeRate', value: 45.2 },
      { path: 'performance.cpu.involuntaryContextSwitchRate', value: 123.4 },
      { path: 'performance.memory.majorPageFaultRate', value: 0.2 },
    ])
  })

  it('emits SI units metadata for every published path', () => {
    const metaDelta = buildMetaDelta()
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
      'performance.http.requestRate': 'Hz',
      'performance.http.requestDuration.p50': 's',
      'performance.http.requestDuration.p99': 's',
      'performance.http.requestDuration.max': 's',
      'performance.disk.readRate': 'Hz',
      'performance.disk.writeRate': 'Hz',
      'performance.cpu.involuntaryContextSwitchRate': 'Hz',
      'performance.memory.majorPageFaultRate': 'Hz',
    })
  })
})
