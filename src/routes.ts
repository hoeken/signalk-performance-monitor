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
import { CaptureBusyError, type CpuCaptureOptions, type HeapCaptureOptions } from './capture'
import { isValidProfileId, profileTypeOf, rawExtension } from './store'
import type {
  MetricsSnapshot,
  ProfileListEntry,
  ProfileReport,
  RunningCapture,
} from './shared/types'

export const DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES = 32768

/** The slice of CaptureManager the routes need (fakeable in tests). */
export interface CaptureController {
  status(): RunningCapture | null
  startCpu(options: CpuCaptureOptions): Promise<string>
  startHeap(options: HeapCaptureOptions): Promise<string>
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
}

export interface RouteDeps {
  metrics: { latest(): MetricsSnapshot | null }
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
        DEFAULT_HEAP_SAMPLING_INTERVAL_BYTES,
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
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${id}${rawExtension(profileTypeOf(id))}"`,
      )
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

async function startCapture(res: Response, start: () => Promise<string>): Promise<void> {
  try {
    const id = await start()
    res.json({ id })
  } catch (error) {
    if (error instanceof CaptureBusyError) {
      res.status(409).json({ error: error.message })
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
