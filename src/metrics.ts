/**
 * Continuous event-loop / process health metrics.
 *
 * All sources are diffed or reset per sampling interval:
 *  - `monitorEventLoopDelay()` histogram (reset after each sample)
 *  - `performance.eventLoopUtilization()` (diffed)
 *  - a `PerformanceObserver` on 'gc' entries (summed, then reset)
 *  - `process.cpuUsage()` (diffed against wall time)
 *  - a `PerformanceObserver` on 'http' entries — Node emits one per inbound
 *    request handled anywhere in the process, but only while observed, so
 *    the per-request cost exists only while the plugin runs
 *  - `/proc/self/io` (diffed) — kernel-counted storage bytes; falls back to
 *    `process.resourceUsage()` 512-byte block counts on non-Linux hosts
 *  - `process.resourceUsage()` counters (diffed into per-second rates)
 */
import {
  createHistogram,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type EventLoopUtilization,
  type IntervalHistogram,
  type RecordableHistogram,
} from 'node:perf_hooks'
import { PROC_SELF, readProcIo, type ProcIoCounters } from './file-activity'
import type { MetricsSnapshot } from './shared/types'

const NS_PER_SECOND = 1e9
const US_PER_SECOND = 1e6
/** resourceUsage().fsRead/fsWrite count 512-byte blocks (Linux ru_inblock/ru_oublock). */
const FS_BLOCK_BYTES = 512

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

export class MetricsCollector {
  private histogram: IntervalHistogram | null = null
  private gcObserver: PerformanceObserver | null = null
  private gcPauseMs = 0
  private httpObserver: PerformanceObserver | null = null
  private httpHistogram: RecordableHistogram | null = null
  private httpRequestCount = 0
  private previousElu: EventLoopUtilization | null = null
  private previousCpu: NodeJS.CpuUsage | null = null
  private previousResourceUsage: NodeJS.ResourceUsage | null = null
  private previousIo: ProcIoCounters | null = null
  private previousSampleTime = 0
  private latestSnapshot: MetricsSnapshot | null = null

  constructor(private readonly procSelfDir: string = PROC_SELF) {}

  start(): void {
    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.gcPauseMs = 0
    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.gcPauseMs += entry.duration
      }
    })
    this.gcObserver.observe({ entryTypes: ['gc'] })
    this.httpHistogram = createHistogram()
    this.httpRequestCount = 0
    this.httpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // 'http' also carries HttpClient entries for outbound requests.
        if (entry.name !== 'HttpRequest') continue
        this.httpRequestCount += 1
        this.httpHistogram?.record(Math.max(1, Math.round(entry.duration * 1000)))
      }
    })
    this.httpObserver.observe({ entryTypes: ['http'] })
    this.previousElu = performance.eventLoopUtilization()
    this.previousCpu = process.cpuUsage()
    this.previousResourceUsage = process.resourceUsage()
    this.previousIo = readProcIo(this.procSelfDir)
    this.previousSampleTime = performance.now()
  }

  stop(): void {
    this.histogram?.disable()
    this.histogram = null
    this.gcObserver?.disconnect()
    this.gcObserver = null
    this.httpObserver?.disconnect()
    this.httpObserver = null
    this.httpHistogram = null
    this.httpRequestCount = 0
    this.previousElu = null
    this.previousCpu = null
    this.previousResourceUsage = null
    this.previousIo = null
    this.latestSnapshot = null
  }

  /** Take a snapshot covering the interval since the previous sample, and reset. */
  sample(): MetricsSnapshot {
    if (!this.histogram) {
      throw new Error('MetricsCollector.sample() called before start()')
    }

    const now = performance.now()
    const elapsedMs = Math.max(now - this.previousSampleTime, 1)
    this.previousSampleTime = now

    const eventLoopDelay = {
      p50: round6(this.histogram.percentile(50) / NS_PER_SECOND),
      p99: round6(this.histogram.percentile(99) / NS_PER_SECOND),
      max: round6(this.histogram.max / NS_PER_SECOND),
    }
    this.histogram.reset()

    const elu = performance.eventLoopUtilization()
    const eluDiff = this.previousElu ? performance.eventLoopUtilization(elu, this.previousElu) : elu
    this.previousElu = elu

    const cpu = process.cpuUsage()
    const cpuDeltaUs =
      cpu.user + cpu.system - ((this.previousCpu?.user ?? 0) + (this.previousCpu?.system ?? 0))
    this.previousCpu = cpu
    const cpuUtilization = round6(Math.max(cpuDeltaUs, 0) / (elapsedMs * 1000))

    const gcPauseTime = round6(this.gcPauseMs / 1000)
    this.gcPauseMs = 0

    const elapsedSeconds = elapsedMs / 1000

    const requestCount = this.httpRequestCount
    this.httpRequestCount = 0
    const http = {
      requestRate: round6(requestCount / elapsedSeconds),
      requestDuration:
        requestCount > 0 && this.httpHistogram
          ? {
              p50: round6(this.httpHistogram.percentile(50) / US_PER_SECOND),
              p99: round6(this.httpHistogram.percentile(99) / US_PER_SECOND),
              max: round6(this.httpHistogram.max / US_PER_SECOND),
            }
          : { p50: 0, p99: 0, max: 0 },
    }
    this.httpHistogram?.reset()

    const usage = process.resourceUsage()
    const counterRate = (current: number, previous: number | undefined) =>
      round6(Math.max(current - (previous ?? current), 0) / elapsedSeconds)

    // Byte-accurate disk rates from /proc/self/io; the block-count fallback
    // (× 512) only applies where procfs is unavailable.
    const io = readProcIo(this.procSelfDir)
    const diskRates =
      io && this.previousIo
        ? {
            diskReadRate: counterRate(io.readBytes, this.previousIo.readBytes),
            diskWriteRate: counterRate(io.writeBytes, this.previousIo.writeBytes),
          }
        : {
            diskReadRate: round6(
              counterRate(usage.fsRead, this.previousResourceUsage?.fsRead) * FS_BLOCK_BYTES,
            ),
            diskWriteRate: round6(
              counterRate(usage.fsWrite, this.previousResourceUsage?.fsWrite) * FS_BLOCK_BYTES,
            ),
          }
    this.previousIo = io

    const resources = {
      ...diskRates,
      involuntaryContextSwitchRate: counterRate(
        usage.involuntaryContextSwitches,
        this.previousResourceUsage?.involuntaryContextSwitches,
      ),
      majorPageFaultRate: counterRate(
        usage.majorPageFault,
        this.previousResourceUsage?.majorPageFault,
      ),
    }
    this.previousResourceUsage = usage

    const memory = process.memoryUsage()

    const snapshot: MetricsSnapshot = {
      timestamp: new Date().toISOString(),
      eventLoopDelay,
      eventLoopUtilization: round6(eluDiff.utilization),
      gcPauseTime,
      memory: { heapUsed: memory.heapUsed, rss: memory.rss },
      cpuUtilization,
      http,
      resources,
    }
    this.latestSnapshot = snapshot
    return snapshot
  }

  latest(): MetricsSnapshot | null {
    return this.latestSnapshot
  }
}
