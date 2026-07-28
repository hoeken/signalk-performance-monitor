/**
 * JSON shapes shared between the plugin backend and the webapp.
 * Both sides import from this file so the API contract is checked
 * at compile time.
 */

export interface EventLoopDelayMetrics {
  /** seconds */
  p50: number
  /** seconds */
  p99: number
  /** seconds, reset each publish interval */
  max: number
}

export interface MemoryMetrics {
  /** bytes */
  heapUsed: number
  /** bytes */
  rss: number
}

export interface MetricsSnapshot {
  timestamp: string
  eventLoopDelay: EventLoopDelayMetrics
  /** ratio 0-1, diffed over the last interval */
  eventLoopUtilization: number
  /** seconds of GC pause summed over the last interval */
  gcPauseTime: number
  memory: MemoryMetrics
  /** ratio of process CPU time to wall time over the last interval */
  cpuUtilization: number
}

export type ProfileType = 'cpu' | 'heap'

export interface CpuTopFunction {
  name: string
  url: string
  selfTimeMs: number
}

export interface CpuBucket {
  name: string
  selfTimeMs: number
  percent: number
  topFunctions?: CpuTopFunction[]
}

export interface CpuReport {
  id: string
  type: 'cpu'
  capturedAt: string
  durationMs: number
  samplingIntervalUs: number
  totalTimeMs: number
  buckets: CpuBucket[]
}

export interface HeapTopFunction {
  name: string
  url: string
  selfBytes: number
}

export interface HeapBucket {
  name: string
  selfBytes: number
  percent: number
  topFunctions?: HeapTopFunction[]
}

export interface HeapReport {
  id: string
  type: 'heap'
  capturedAt: string
  durationMs: number
  samplingIntervalBytes: number
  totalBytes: number
  buckets: HeapBucket[]
}

export type ProfileReport = CpuReport | HeapReport

export interface ProfileListEntry {
  id: string
  type: ProfileType
  capturedAt: string
  durationMs: number
  rawSizeBytes: number
}

export interface RunningCapture {
  id: string
  type: ProfileType
  startedAt: string
  durationSeconds: number
  remainingSeconds: number
}

export interface ProfileListResponse {
  running: RunningCapture | null
  profiles: ProfileListEntry[]
}

export interface StartProfileResponse {
  id: string
}

export interface ApiError {
  error: string
}
