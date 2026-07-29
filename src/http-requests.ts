/**
 * Per-request HTTP tracking, from the same `'http'` performance entries the
 * metrics collector times (Node emits one per inbound request, but only while
 * observed — so like the interval metrics, this costs nothing while stopped):
 *
 *  - a ring buffer of the last `RECENT_LIMIT` requests, query strings and
 *    request headers kept (credential-bearing header values redacted)
 *  - cumulative per-path aggregates (count / total / max duration, errors,
 *    bytes), query strings stripped and known unbounded URL families
 *    collapsed (see `COLLAPSE_RULES`) so related hits share one row
 */
import { performance, PerformanceObserver } from 'node:perf_hooks'
import type { HttpPathStats, HttpRequestsResponse, RecentHttpRequest } from './shared/types'

export const RECENT_LIMIT = 200

/**
 * Aggregate-only path collapsing: each rule rewrites members of an unbounded
 * URL family (per-entry ids, chart tile coordinates) to the family's root so
 * they share one aggregate row instead of one row each. First match wins;
 * recent requests are never collapsed.
 */
const COLLAPSE_RULES: [RegExp, string][] = [
  // Resource entries, global or per-vessel: keep the resource type, drop the
  // entry id / chart tile coordinates after it.
  [/^(\/signalk\/v\d+\/api\/(?:vessels\/[^/]+\/)?resources\/[^/]+)\/.+$/, '$1'],
]

export function collapsePath(path: string): string {
  for (const [pattern, replacement] of COLLAPSE_RULES) {
    if (pattern.test(path)) return path.replace(pattern, replacement)
  }
  return path
}

/** The fields Node puts on an `'http'` entry's `detail` for inbound requests. */
interface HttpEntryDetail {
  req: { method: string; url: string; headers?: Record<string, string> }
  res: { statusCode: number; headers?: Record<string, unknown> }
}

/** Headers whose values carry credentials; kept (so their presence is visible) but blanked. */
const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

/** Flatten request headers to strings and blank out credential values. */
function sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    const text = Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : null
    if (text === null) continue
    headers[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? '(redacted)' : text
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function parseDetail(detail: unknown): HttpEntryDetail | null {
  if (!detail || typeof detail !== 'object') return null
  const { req, res } = detail as { req?: unknown; res?: unknown }
  if (!req || typeof req !== 'object' || !res || typeof res !== 'object') return null
  const {
    method,
    url,
    headers: reqHeaders,
  } = req as { method?: unknown; url?: unknown; headers?: unknown }
  const { statusCode, headers } = res as { statusCode?: unknown; headers?: unknown }
  if (typeof method !== 'string' || typeof url !== 'string' || typeof statusCode !== 'number') {
    return null
  }
  return {
    req: { method, url, headers: sanitizeHeaders(reqHeaders) },
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
      ...(parsed.req.headers === undefined ? {} : { requestHeaders: parsed.req.headers }),
    })
    if (this.recent.length > RECENT_LIMIT) this.recent.shift()

    const queryStart = parsed.req.url.indexOf('?')
    const path = collapsePath(
      queryStart === -1 ? parsed.req.url : parsed.req.url.slice(0, queryStart),
    )
    const method = parsed.req.method
    const key = `${method} ${path}`
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
