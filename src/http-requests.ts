/**
 * Per-request HTTP tracking, from the same `'http'` performance entries the
 * metrics collector times (Node emits one per inbound request, but only while
 * observed — so like the interval metrics, this costs nothing while stopped):
 *
 *  - a ring buffer of the last `RECENT_LIMIT` requests, query strings kept
 *  - cumulative per-path aggregates (count / total / max duration, errors,
 *    bytes), query strings stripped so all hits on a path share one row
 *
 * The aggregate map is capped: once `MAX_AGGREGATE_PATHS` distinct
 * method+path keys exist, further new paths accumulate under `(other)` so
 * unbounded path spaces (ids in URLs, scanners) can't grow memory forever.
 */
import { performance, PerformanceObserver } from 'node:perf_hooks'
import type { HttpPathStats, HttpRequestsResponse, RecentHttpRequest } from './shared/types'

export const RECENT_LIMIT = 100
export const MAX_AGGREGATE_PATHS = 500
export const OVERFLOW_PATH = '(other)'

/** The fields Node puts on an `'http'` entry's `detail` for inbound requests. */
interface HttpEntryDetail {
  req: { method: string; url: string }
  res: { statusCode: number; headers?: Record<string, unknown> }
}

function parseDetail(detail: unknown): HttpEntryDetail | null {
  if (!detail || typeof detail !== 'object') return null
  const { req, res } = detail as { req?: unknown; res?: unknown }
  if (!req || typeof req !== 'object' || !res || typeof res !== 'object') return null
  const { method, url } = req as { method?: unknown; url?: unknown }
  const { statusCode, headers } = res as { statusCode?: unknown; headers?: unknown }
  if (typeof method !== 'string' || typeof url !== 'string' || typeof statusCode !== 'number') {
    return null
  }
  return {
    req: { method, url },
    res: {
      statusCode,
      headers:
        headers && typeof headers === 'object' ? (headers as Record<string, unknown>) : undefined,
    },
  }
}

function contentLength(headers: Record<string, unknown> | undefined): number | undefined {
  const raw = headers?.['content-length']
  const value = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function roundMs(ms: number): number {
  return Math.round(ms * 1000) / 1000
}

export class HttpRequestTracker {
  private observer: PerformanceObserver | null = null
  private recent: RecentHttpRequest[] = []
  private aggregate = new Map<string, HttpPathStats>()

  start(): void {
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // 'http' also carries HttpClient entries for outbound requests.
        if (entry.name !== 'HttpRequest') continue
        const endEpochMs = performance.timeOrigin + entry.startTime + entry.duration
        this.record(entry.duration, (entry as { detail?: unknown }).detail, endEpochMs)
      }
    })
    this.observer.observe({ entryTypes: ['http'] })
  }

  stop(): void {
    this.observer?.disconnect()
    this.observer = null
    this.recent = []
    this.aggregate.clear()
  }

  /** Record one completed request (public so tests can feed entries directly). */
  record(durationMs: number, detail: unknown, endEpochMs: number): void {
    const parsed = parseDetail(detail)
    if (!parsed) return

    const timestamp = new Date(endEpochMs).toISOString()
    const responseBytes = contentLength(parsed.res.headers)

    this.recent.push({
      timestamp,
      method: parsed.req.method,
      path: parsed.req.url,
      statusCode: parsed.res.statusCode,
      durationMs: roundMs(durationMs),
      ...(responseBytes === undefined ? {} : { responseBytes }),
    })
    if (this.recent.length > RECENT_LIMIT) this.recent.shift()

    const queryStart = parsed.req.url.indexOf('?')
    let path = queryStart === -1 ? parsed.req.url : parsed.req.url.slice(0, queryStart)
    let method = parsed.req.method
    let key = `${method} ${path}`
    if (!this.aggregate.has(key) && this.aggregate.size >= MAX_AGGREGATE_PATHS) {
      path = OVERFLOW_PATH
      method = ''
      key = OVERFLOW_PATH
    }
    const stats = this.aggregate.get(key) ?? {
      method,
      path,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      errorCount: 0,
      totalBytes: 0,
      lastSeen: timestamp,
    }
    stats.count += 1
    stats.totalMs = roundMs(stats.totalMs + durationMs)
    stats.maxMs = Math.max(stats.maxMs, roundMs(durationMs))
    if (parsed.res.statusCode >= 400) stats.errorCount += 1
    if (responseBytes !== undefined) stats.totalBytes += responseBytes
    stats.lastSeen = timestamp
    this.aggregate.set(key, stats)
  }

  /** Recent requests newest-first, plus all per-path aggregates. */
  snapshot(): HttpRequestsResponse {
    return {
      recent: [...this.recent].reverse(),
      aggregate: [...this.aggregate.values()],
    }
  }
}
