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

export interface HttpMetrics {
  /** inbound HTTP requests handled per second over the last interval */
  requestRate: number
  /** request duration percentiles in seconds; all zero when no requests were handled */
  requestDuration: {
    p50: number
    p99: number
    /** seconds, reset each publish interval */
    max: number
  }
}

/** One completed inbound HTTP request, newest first in `HttpRequestsResponse.recent`. */
export interface RecentHttpRequest {
  /** ISO time the response finished */
  timestamp: string
  method: string
  /** request path including the query string */
  path: string
  statusCode: number
  /** milliseconds */
  durationMs: number
  /** response Content-Length; absent for chunked/streamed responses */
  responseBytes?: number
}

/** Cumulative per-path stats since plugin start; query strings are stripped. */
export interface HttpPathStats {
  method: string
  /** path with the query string stripped; "(other)" collects overflow paths */
  path: string
  count: number
  /** milliseconds, summed across all requests */
  totalMs: number
  /** milliseconds, slowest single request */
  maxMs: number
  /** responses with status >= 400 */
  errorCount: number
  /** summed response Content-Length across responses that declared one */
  totalBytes: number
  /** ISO time of the most recent request */
  lastSeen: string
}

export interface HttpRequestsResponse {
  recent: RecentHttpRequest[]
  aggregate: HttpPathStats[]
}

/** Per-second rates diffed from `process.resourceUsage()` over the last interval. */
export interface ResourceUsageMetrics {
  /** 512-byte blocks read from storage per second (page-cache misses only, so usually 0) */
  fsReadRate: number
  /** 512-byte blocks written to storage per second */
  fsWriteRate: number
  /** involuntary context switches per second — a CPU contention indicator */
  involuntaryContextSwitchRate: number
  /** major page faults per second — a memory pressure indicator */
  majorPageFaultRate: number
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
  http: HttpMetrics
  resources: ResourceUsageMetrics
}

export type ProfileType = 'cpu' | 'heap'

/**
 * One frame of the aggregated call tree rendered as a flame graph.
 * `self`/`total` are integer microseconds for CPU reports and bytes for
 * heap reports; integers so child widths always sum to at most the parent.
 * Subtrees below 0.1% of the root total are pruned — their cost stays in
 * every ancestor's `total`, it just isn't broken down further.
 */
export interface FlameNode {
  name: string
  /** Attribution bucket of this frame, same names as the report buckets. */
  bucket: string
  self: number
  total: number
  url?: string
  children?: FlameNode[]
}

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
  /** Absent when the capture had no samples, or in reports from older versions. */
  flame?: FlameNode
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
  /** Absent when nothing was sampled, or in reports from older versions. */
  flame?: FlameNode
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
