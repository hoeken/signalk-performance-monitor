/**
 * Integration tests for the HTTP API, exercised through a real express app
 * with a fake capture controller and a real on-disk store.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CaptureBusyError,
  FileCaptureUnsupportedError,
  InvalidProfileError,
  type CpuCaptureOptions,
  type FilesCaptureOptions,
  type HeapCaptureOptions,
  type ImportProfileOptions,
} from '../src/capture'
import { registerRoutes, type CaptureController, type RouteDeps } from '../src/routes'
import { ProfileStore } from '../src/store'
import type {
  CpuReport,
  HttpRequestsResponse,
  MetricsSnapshot,
  RunningCapture,
} from '../src/shared/types'

const SNAPSHOT: MetricsSnapshot = {
  timestamp: '2026-07-28T00:00:00.000Z',
  eventLoopDelay: { p50: 0.001, p99: 0.005, max: 0.02 },
  eventLoopUtilization: 0.3,
  gcPauseTime: 0.001,
  memory: { heapUsed: 1000, rss: 2000 },
  cpuUtilization: 0.25,
  http: { requestRate: 2, requestDuration: { p50: 0.004, p99: 0.05, max: 0.12 } },
  resources: {
    diskReadRate: 10,
    diskWriteRate: 20,
    involuntaryContextSwitchRate: 30,
    majorPageFaultRate: 0,
  },
}

const HTTP_REQUESTS: HttpRequestsResponse = {
  recent: [
    {
      timestamp: '2026-07-28T00:00:00.000Z',
      method: 'GET',
      path: '/signalk/v1/api/vessels/self?depth=1',
      statusCode: 200,
      durationMs: 4.2,
      responseBytes: 1832,
    },
  ],
  aggregate: [
    {
      method: 'GET',
      path: '/signalk/v1/api/vessels/self',
      count: 12,
      totalMs: 50.4,
      maxMs: 9.9,
      errorCount: 0,
      totalBytes: 21984,
      lastSeen: '2026-07-28T00:00:00.000Z',
    },
  ],
}

class FakeCaptures implements CaptureController {
  running: RunningCapture | null = null
  cpuCalls: CpuCaptureOptions[] = []
  heapCalls: HeapCaptureOptions[] = []
  filesCalls: FilesCaptureOptions[] = []
  filesSupported = true
  importCalls: { raw: unknown; options: ImportProfileOptions }[] = []

  status(): RunningCapture | null {
    return this.running
  }

  async startCpu(options: CpuCaptureOptions): Promise<string> {
    if (this.running) throw new CaptureBusyError()
    this.cpuCalls.push(options)
    this.running = {
      id: 'cpu-fake',
      type: 'cpu',
      startedAt: '2026-07-28T00:00:00.000Z',
      durationSeconds: options.durationSeconds,
      remainingSeconds: options.durationSeconds,
    }
    return 'cpu-fake'
  }

  async startHeap(options: HeapCaptureOptions): Promise<string> {
    if (this.running) throw new CaptureBusyError()
    this.heapCalls.push(options)
    this.running = {
      id: 'heap-fake',
      type: 'heap',
      startedAt: '2026-07-28T00:00:00.000Z',
      durationSeconds: options.durationSeconds,
      remainingSeconds: options.durationSeconds,
    }
    return 'heap-fake'
  }

  async startFiles(options: FilesCaptureOptions): Promise<string> {
    if (this.running) throw new CaptureBusyError()
    if (!this.filesSupported) throw new FileCaptureUnsupportedError()
    this.filesCalls.push(options)
    this.running = {
      id: 'files-fake',
      type: 'files',
      startedAt: '2026-07-28T00:00:00.000Z',
      durationSeconds: options.durationSeconds,
      remainingSeconds: options.durationSeconds,
    }
    return 'files-fake'
  }

  async importProfile(raw: unknown, options: ImportProfileOptions): Promise<string> {
    const looksLikeProfile =
      raw !== null &&
      typeof raw === 'object' &&
      ('nodes' in raw || 'head' in raw || 'samples' in raw)
    if (!looksLikeProfile) throw new InvalidProfileError()
    this.importCalls.push({ raw, options })
    return 'cpu-imported'
  }
}

function makeReport(id: string): CpuReport {
  return {
    id,
    type: 'cpu',
    capturedAt: '2026-07-28T10:00:00.000Z',
    durationMs: 30000,
    samplingIntervalUs: 1000,
    totalTimeMs: 30000,
    buckets: [{ name: '(idle)', selfTimeMs: 30000, percent: 100 }],
  }
}

describe('HTTP routes', () => {
  let dir: string
  let store: ProfileStore
  let captures: FakeCaptures
  let deps: RouteDeps | null
  let app: express.Express
  const errors: string[] = []
  const httpRequestsReset = vi.fn()

  beforeEach(async () => {
    httpRequestsReset.mockClear()
    dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-routes-'))
    store = new ProfileStore(dir, 5)
    captures = new FakeCaptures()
    deps = {
      metrics: { latest: () => SNAPSHOT },
      httpRequests: { snapshot: () => HTTP_REQUESTS, reset: httpRequestsReset },
      captures,
      store,
      options: {
        defaultProfileDurationSeconds: 30,
        maxProfileDurationSeconds: 120,
        samplingIntervalUs: 1000,
        // Deliberately non-default values, so these tests prove the
        // configured intervals (not the built-in defaults) flow through.
        samplingIntervalBytes: 16384,
        filesSampleIntervalSeconds: 0.25,
      },
    }
    app = express()
    app.use(express.json())
    const router = express.Router()
    registerRoutes(router, () => deps, { error: (message) => errors.push(message) })
    app.use(router)
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('GET /metrics returns the current snapshot', async () => {
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(SNAPSHOT)
  })

  it('GET /http-requests returns the tracker snapshot', async () => {
    const res = await request(app).get('/http-requests')
    expect(res.status).toBe(200)
    expect(res.body).toEqual(HTTP_REQUESTS)
  })

  it('DELETE /http-requests resets the tracker', async () => {
    const res = await request(app).delete('/http-requests')
    expect(res.status).toBe(204)
    expect(httpRequestsReset).toHaveBeenCalledTimes(1)
  })

  it('GET /http-requests answers empty with enabled=false when recording is off', async () => {
    deps!.httpRequests = null
    const res = await request(app).get('/http-requests')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ recent: [], aggregate: [], enabled: false })
  })

  it('DELETE /http-requests is a no-op 204 when recording is off', async () => {
    deps!.httpRequests = null
    const res = await request(app).delete('/http-requests')
    expect(res.status).toBe(204)
    expect(httpRequestsReset).not.toHaveBeenCalled()
  })

  it('answers 503 before the plugin has started', async () => {
    deps = null
    for (const probe of [request(app).get('/metrics'), request(app).post('/profile')]) {
      const res = await probe
      expect(res.status).toBe(503)
    }
  })

  it('POST /profile starts a capture with defaults and returns its id', async () => {
    const res = await request(app).post('/profile').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'cpu-fake' })
    expect(captures.cpuCalls).toEqual([{ durationSeconds: 30, samplingIntervalUs: 1000 }])
  })

  it('POST /profile honours duration and samplingIntervalUs', async () => {
    const res = await request(app).post('/profile').send({ duration: 10, samplingIntervalUs: 500 })
    expect(res.status).toBe(200)
    expect(captures.cpuCalls).toEqual([{ durationSeconds: 10, samplingIntervalUs: 500 }])
  })

  it('POST /profile rejects overlapping captures with 409', async () => {
    await request(app).post('/profile').send({})
    const res = await request(app).post('/profile').send({})
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/already running/)
  })

  it('POST /profile enforces the duration cap and validity', async () => {
    for (const body of [
      { duration: 121 },
      { duration: -5 },
      { duration: 'long' },
      { duration: 0 },
    ]) {
      const res = await request(app).post('/profile').send(body)
      expect(res.status).toBe(400)
      expect(captures.cpuCalls).toEqual([])
    }
  })

  it('POST /profile rejects bad sampling intervals', async () => {
    const res = await request(app).post('/profile').send({ samplingIntervalUs: -1 })
    expect(res.status).toBe(400)
  })

  it('POST /heap-profile starts an allocation capture', async () => {
    const res = await request(app).post('/heap-profile').send({ duration: 15 })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'heap-fake' })
    expect(captures.heapCalls).toEqual([{ durationSeconds: 15, samplingIntervalBytes: 16384 }])
  })

  it('POST /files-profile starts a file activity capture with defaults', async () => {
    const res = await request(app).post('/files-profile').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'files-fake' })
    expect(captures.filesCalls).toEqual([{ durationSeconds: 30, sampleIntervalSeconds: 0.25 }])
  })

  it('POST /files-profile honours duration and sampleIntervalSeconds', async () => {
    const res = await request(app)
      .post('/files-profile')
      .send({ duration: 60, sampleIntervalSeconds: 5 })
    expect(res.status).toBe(200)
    expect(captures.filesCalls).toEqual([{ durationSeconds: 60, sampleIntervalSeconds: 5 }])
  })

  it('POST /files-profile validates its inputs and rejects overlap', async () => {
    for (const body of [{ duration: 121 }, { sampleIntervalSeconds: -1 }]) {
      const res = await request(app).post('/files-profile').send(body)
      expect(res.status).toBe(400)
    }
    expect(captures.filesCalls).toEqual([])

    await request(app).post('/profile').send({})
    const busy = await request(app).post('/files-profile').send({})
    expect(busy.status).toBe(409)
  })

  it('POST /files-profile answers 501 where /proc is unavailable', async () => {
    captures.filesSupported = false
    const res = await request(app).post('/files-profile').send({})
    expect(res.status).toBe(501)
    expect(res.body.error).toMatch(/Linux/)
  })

  it('POST /profile/upload imports an octet-stream profile with its filename', async () => {
    const profile = { nodes: [], startTime: 0, endTime: 1000 }
    const res = await request(app)
      .post('/profile/upload?filename=cpu-2026-07-01T00-00-00-000Z.json')
      .set('Content-Type', 'application/octet-stream')
      .send(JSON.stringify(profile))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ id: 'cpu-imported' })
    expect(captures.importCalls).toEqual([
      {
        raw: profile,
        options: {
          samplingIntervalUs: 1000,
          samplingIntervalBytes: 16384,
          filename: 'cpu-2026-07-01T00-00-00-000Z.json',
        },
      },
    ])
  })

  it('POST /profile/upload also accepts a JSON-parsed body', async () => {
    const profile = { nodes: [], startTime: 0, endTime: 1000 }
    const res = await request(app).post('/profile/upload').send(profile)

    expect(res.status).toBe(200)
    expect(captures.importCalls[0]?.raw).toEqual(profile)
    expect(captures.importCalls[0]?.options.filename).toBeUndefined()
  })

  it('POST /profile/upload rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/profile/upload')
      .set('Content-Type', 'application/octet-stream')
      .send('not json {')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not valid JSON/)
    expect(captures.importCalls).toEqual([])
  })

  it('POST /profile/upload rejects unrecognized profile shapes with 400', async () => {
    const res = await request(app)
      .post('/profile/upload')
      .set('Content-Type', 'application/octet-stream')
      .send(JSON.stringify({ hello: 'world' }))
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/not a V8/)
  })

  it('GET /profile lists stored profiles and running status', async () => {
    await store.save(makeReport('cpu-a1'), { nodes: [] })
    await request(app).post('/profile').send({})

    const res = await request(app).get('/profile')
    expect(res.status).toBe(200)
    expect(res.body.running.id).toBe('cpu-fake')
    expect(res.body.profiles).toHaveLength(1)
    expect(res.body.profiles[0].id).toBe('cpu-a1')
  })

  it('GET /profile/:id/report returns the stored report or 404', async () => {
    await store.save(makeReport('cpu-a1'), { nodes: [] })

    const found = await request(app).get('/profile/cpu-a1/report')
    expect(found.status).toBe(200)
    expect(found.body.id).toBe('cpu-a1')

    const missing = await request(app).get('/profile/cpu-nope/report')
    expect(missing.status).toBe(404)
  })

  it('GET /profile/:id/raw downloads the raw profile with embedded metadata', async () => {
    await store.save(makeReport('cpu-a1'), { nodes: [1, 2, 3] })

    const res = await request(app).get('/profile/cpu-a1/raw')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="cpu-a1.json"')
    expect(res.body.nodes).toEqual([1, 2, 3])
    expect(res.body['signalk-performance-monitor']).toMatchObject({
      id: 'cpu-a1',
      capturedAt: '2026-07-28T10:00:00.000Z',
    })
  })

  it('rejects malformed profile ids with 400', async () => {
    const res = await request(app).get('/profile/%2e%2e%2fevil/report')
    expect(res.status).toBe(400)
  })

  it('DELETE /profile/:id removes a profile or answers 404', async () => {
    await store.save(makeReport('cpu-a1'), {})

    const deleted = await request(app).delete('/profile/cpu-a1')
    expect(deleted.status).toBe(204)
    expect(await store.list()).toEqual([])

    const missing = await request(app).delete('/profile/cpu-a1')
    expect(missing.status).toBe(404)
  })

  it('turns unexpected handler errors into 500s and logs them', async () => {
    captures.startCpu = async () => {
      throw new Error('inspector exploded')
    }
    const res = await request(app).post('/profile').send({})
    expect(res.status).toBe(500)
    expect(errors.some((message) => message.includes('inspector exploded'))).toBe(true)
  })
})
