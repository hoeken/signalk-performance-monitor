/**
 * HTTP API, registered via the plugin's `registerWithRouter` hook.
 *
 * Routes under /plugins/<id>/ are admin-only under the server's security
 * strategy by default — required here, since profiles reveal file paths and
 * function names (see SPEC "Security considerations").
 *
 * `registerWithRouter` is called before `start()`, so handlers resolve their
 * dependencies through `getDeps()` on every request and answer 503 until the
 * plugin has started.
 */
import type { IRouter, Request, Response } from 'express'
import {
  CaptureBusyError,
  FileCaptureUnsupportedError,
  InvalidProfileError,
  type CpuCaptureOptions,
  type FilesCaptureOptions,
  type HeapCaptureOptions,
  type ImportProfileOptions,
} from './capture'
import { isValidProfileId } from './store'
import type {
  HttpRequestsResponse,
  MetricsSnapshot,
  ProfileListEntry,
  ProfileReport,
  RunningCapture,
} from './shared/types'

// Config defaults for the sampling intervals (plugin config can override,
// and every capture request can override the configured value in turn).
export const DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES = 32768
// File captures are on-demand and bounded, so sample fast: 100ms catches
// files opened and closed between coarser samples and gives mtime-churn
// counts real resolution, at a sampling cost that only exists mid-capture.
export const DEFAULT_FILES_SAMPLE_INTERVAL_SECONDS = 0.1

/**
 * Uploads bypass the server's JSON body parser (the webapp sends
 * application/octet-stream), so this route enforces its own size cap.
 */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

/** The slice of CaptureManager the routes need (fakeable in tests). */
export interface CaptureController {
  status(): RunningCapture | null
  startCpu(options: CpuCaptureOptions): Promise<string>
  startHeap(options: HeapCaptureOptions): Promise<string>
  startFiles(options: FilesCaptureOptions): Promise<string>
  importProfile(raw: unknown, options: ImportProfileOptions): Promise<string>
}

export interface ProfileReader {
  list(): Promise<ProfileListEntry[]>
  getReport(id: string): Promise<ProfileReport | null>
  getRaw(id: string): Promise<Buffer | null>
  delete(id: string): Promise<boolean>
}

export interface RouteOptions {
  defaultProfileDurationSeconds: number
  maxProfileDurationSeconds: number
  samplingIntervalUs: number
  samplingIntervalBytes: number
  filesSampleIntervalSeconds: number
}

export interface RouteDeps {
  metrics: { latest(): MetricsSnapshot | null }
  /** null when request recording is disabled in plugin config. */
  httpRequests: { snapshot(): HttpRequestsResponse; reset(): void } | null
  captures: CaptureController
  store: ProfileReader
  options: RouteOptions
}

export interface RouteLogger {
  error(message: string): void
}

type Handler = (deps: RouteDeps, req: Request, res: Response) => Promise<void> | void

export function registerRoutes(
  router: IRouter,
  getDeps: () => RouteDeps | null,
  log: RouteLogger,
): void {
  const wrap =
    (handler: Handler) =>
    (req: Request, res: Response): void => {
      const deps = getDeps()
      if (!deps) {
        res.status(503).json({ error: 'plugin not started' })
        return
      }
      Promise.resolve(handler(deps, req, res)).catch((error: unknown) => {
        log.error(`request failed: ${String(error)}`)
        if (!res.headersSent) {
          res.status(500).json({ error: 'internal error' })
        }
      })
    }

  router.get(
    '/metrics',
    wrap((deps, _req, res) => {
      const snapshot = deps.metrics.latest()
      if (!snapshot) {
        res.status(503).json({ error: 'no metrics collected yet' })
        return
      }
      res.json(snapshot)
    }),
  )

  router.get(
    '/http-requests',
    wrap((deps, _req, res) => {
      if (!deps.httpRequests) {
        const disabled: HttpRequestsResponse = { recent: [], aggregate: [], enabled: false }
        res.json(disabled)
        return
      }
      res.json(deps.httpRequests.snapshot())
    }),
  )

  router.delete(
    '/http-requests',
    wrap((deps, _req, res) => {
      deps.httpRequests?.reset()
      res.status(204).end()
    }),
  )

  router.post(
    '/profile',
    wrap(async (deps, req, res) => {
      const body = asBody(req)
      const duration = validateDuration(body.duration, deps.options, res)
      if (duration === null) return
      const samplingIntervalUs = validatePositiveNumber(
        body.samplingIntervalUs,
        deps.options.samplingIntervalUs,
        'samplingIntervalUs',
        res,
      )
      if (samplingIntervalUs === null) return

      await startCapture(res, () =>
        deps.captures.startCpu({
          durationSeconds: duration,
          samplingIntervalUs: Math.floor(samplingIntervalUs),
        }),
      )
    }),
  )

  router.post(
    '/heap-profile',
    wrap(async (deps, req, res) => {
      const body = asBody(req)
      const duration = validateDuration(body.duration, deps.options, res)
      if (duration === null) return
      const samplingIntervalBytes = validatePositiveNumber(
        body.samplingIntervalBytes,
        deps.options.samplingIntervalBytes,
        'samplingIntervalBytes',
        res,
      )
      if (samplingIntervalBytes === null) return

      await startCapture(res, () =>
        deps.captures.startHeap({
          durationSeconds: duration,
          samplingIntervalBytes: Math.floor(samplingIntervalBytes),
        }),
      )
    }),
  )

  router.post(
    '/files-profile',
    wrap(async (deps, req, res) => {
      const body = asBody(req)
      const duration = validateDuration(body.duration, deps.options, res)
      if (duration === null) return
      const sampleIntervalSeconds = validatePositiveNumber(
        body.sampleIntervalSeconds,
        deps.options.filesSampleIntervalSeconds,
        'sampleIntervalSeconds',
        res,
      )
      if (sampleIntervalSeconds === null) return

      await startCapture(res, () =>
        deps.captures.startFiles({
          durationSeconds: duration,
          sampleIntervalSeconds,
        }),
      )
    }),
  )

  router.post(
    '/profile/upload',
    wrap(async (deps, req, res) => {
      let raw: unknown
      try {
        raw = await readUploadedJson(req)
      } catch (error) {
        if (error instanceof UploadTooLargeError) {
          res.status(413).json({ error: error.message })
          return
        }
        res.status(400).json({ error: 'request body is not valid JSON' })
        return
      }

      const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined
      try {
        const id = await deps.captures.importProfile(raw, {
          samplingIntervalUs: deps.options.samplingIntervalUs,
          samplingIntervalBytes: deps.options.samplingIntervalBytes,
          filename,
        })
        res.json({ id })
      } catch (error) {
        if (error instanceof InvalidProfileError) {
          res.status(400).json({ error: error.message })
          return
        }
        throw error
      }
    }),
  )

  router.get(
    '/profile',
    wrap(async (deps, _req, res) => {
      res.json({
        running: deps.captures.status(),
        profiles: await deps.store.list(),
      })
    }),
  )

  router.get(
    '/profile/:id/report',
    wrap(async (deps, req, res) => {
      const id = requireValidId(req, res)
      if (!id) return
      const report = await deps.store.getReport(id)
      if (!report) {
        res.status(404).json({ error: 'profile not found' })
        return
      }
      res.json(report)
    }),
  )

  router.get(
    '/profile/:id/raw',
    wrap(async (deps, req, res) => {
      const id = requireValidId(req, res)
      if (!id) return
      const raw = await deps.store.getRaw(id)
      if (!raw) {
        res.status(404).json({ error: 'profile not found' })
        return
      }
      res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`)
      res.type('application/json').send(raw)
    }),
  )

  router.delete(
    '/profile/:id',
    wrap(async (deps, req, res) => {
      const id = requireValidId(req, res)
      if (!id) return
      const deleted = await deps.store.delete(id)
      if (!deleted) {
        res.status(404).json({ error: 'profile not found' })
        return
      }
      res.status(204).end()
    }),
  )
}

function asBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body
  if (body && typeof body === 'object') return body as Record<string, unknown>
  return {}
}

class UploadTooLargeError extends Error {
  constructor() {
    super(`upload exceeds ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`)
    this.name = 'UploadTooLargeError'
  }
}

/**
 * The uploaded profile JSON, however it arrived: already parsed by a JSON
 * body parser, buffered by a raw body parser, or still on the request stream
 * (the webapp sends application/octet-stream so JSON parser limits don't
 * apply to multi-megabyte profiles).
 */
async function readUploadedJson(req: Request): Promise<unknown> {
  const body: unknown = req.body
  if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf8'))
  if (body && typeof body === 'object' && Object.keys(body).length > 0) return body
  const buffered = await readRequestBody(req, MAX_UPLOAD_BYTES)
  return JSON.parse(buffered.toString('utf8'))
}

function readRequestBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > maxBytes) {
        failed = true
        reject(new UploadTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      failed = true
      reject(error)
    })
  })
}

async function startCapture(res: Response, start: () => Promise<string>): Promise<void> {
  try {
    const id = await start()
    res.json({ id })
  } catch (error) {
    if (error instanceof CaptureBusyError) {
      res.status(409).json({ error: error.message })
      return
    }
    if (error instanceof FileCaptureUnsupportedError) {
      res.status(501).json({ error: error.message })
      return
    }
    throw error
  }
}

function validateDuration(value: unknown, options: RouteOptions, res: Response): number | null {
  const duration = value ?? options.defaultProfileDurationSeconds
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    res.status(400).json({ error: 'duration must be a positive number of seconds' })
    return null
  }
  if (duration > options.maxProfileDurationSeconds) {
    res.status(400).json({
      error: `duration must be at most ${options.maxProfileDurationSeconds} seconds`,
    })
    return null
  }
  return duration
}

function validatePositiveNumber(
  value: unknown,
  fallback: number,
  name: string,
  res: Response,
): number | null {
  const parsed = value ?? fallback
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    res.status(400).json({ error: `${name} must be a positive number` })
    return null
  }
  return parsed
}

function requireValidId(req: Request, res: Response): string | null {
  const id = req.params.id
  if (!id || !isValidProfileId(id)) {
    res.status(400).json({ error: 'invalid profile id' })
    return null
  }
  return id
}
