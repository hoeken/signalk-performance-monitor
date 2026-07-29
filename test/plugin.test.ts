/**
 * Lifecycle tests: the plugin against a mocked ServerAPI surface, with its
 * router mounted in a real express app.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Delta, ServerAPI } from '@signalk/server-api'
import { CONFIG_DEFAULTS, createPlugin, detectServerRoot, PLUGIN_ID } from '../src/plugin'

interface MockApp {
  api: ServerAPI
  deltas: { id: string; delta: Delta }[]
  statuses: string[]
  errors: string[]
}

function makeMockApp(dataDir: string): MockApp {
  const deltas: { id: string; delta: Delta }[] = []
  const statuses: string[] = []
  const errors: string[] = []
  const api = {
    handleMessage: (id: string, delta: Delta) => {
      deltas.push({ id, delta })
    },
    setPluginStatus: (message: string) => {
      statuses.push(message)
    },
    setPluginError: (message: string) => {
      errors.push(message)
    },
    error: (message: string) => {
      errors.push(message)
    },
    debug: () => undefined,
    getDataDirPath: () => dataDir,
  } as unknown as ServerAPI
  return { api, deltas, statuses, errors }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('plugin lifecycle', () => {
  let dataDir: string
  let mock: MockApp

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-plugin-'))
    mock = makeMockApp(dataDir)
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('declares the expected identity and a schema with defaults', () => {
    const plugin = createPlugin(mock.api)
    expect(plugin.id).toBe(PLUGIN_ID)
    const schema = typeof plugin.schema === 'function' ? plugin.schema() : plugin.schema
    const properties = (schema as { properties: Record<string, { default?: unknown }> }).properties
    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
      expect(properties[key]?.default).toBe(value)
    }
  })

  it('publishes meta once and metric deltas on the configured interval', async () => {
    const plugin = createPlugin(mock.api)
    plugin.start({ publishIntervalSeconds: 1 }, () => undefined)
    try {
      await sleep(1200)

      const metaDeltas = mock.deltas.filter(({ delta }) =>
        delta.updates.some((update) => 'meta' in update),
      )
      expect(metaDeltas).toHaveLength(1)

      const valueDeltas = mock.deltas.filter(({ delta }) =>
        delta.updates.some((update) => 'values' in update),
      )
      expect(valueDeltas.length).toBeGreaterThanOrEqual(1)
      expect(valueDeltas[0].id).toBe(PLUGIN_ID)
      const update = valueDeltas[0].delta.updates[0]
      if (!('values' in update)) throw new Error('expected values update')
      expect(update.values.map((value) => value.path)).toContain('performance.eventLoopDelay.p99')
      expect(mock.statuses.some((status) => status.startsWith('Monitoring'))).toBe(true)
    } finally {
      plugin.stop()
    }
  })

  it('stays silent on the delta bus when publishing is disabled', async () => {
    const plugin = createPlugin(mock.api)
    plugin.start({ publishIntervalSeconds: 1, publishDeltas: false }, () => undefined)
    try {
      await sleep(1200)
      expect(mock.deltas).toEqual([])
    } finally {
      plugin.stop()
    }
  })

  it('serves metrics over its router once started and 503 before', async () => {
    const plugin = createPlugin(mock.api)
    const app = express()
    app.use(express.json())
    const router = express.Router()
    plugin.registerWithRouter?.(router)
    app.use(router)

    const before = await request(app).get('/metrics')
    expect(before.status).toBe(503)

    plugin.start({}, () => undefined)
    try {
      const after = await request(app).get('/metrics')
      expect(after.status).toBe(200)
      expect(after.body.memory.heapUsed).toBeGreaterThan(0)
    } finally {
      plugin.stop()
    }

    const stopped = await request(app).get('/metrics')
    expect(stopped.status).toBe(503)
  })

  it('serves /http-requests as disabled when recording is turned off', async () => {
    const plugin = createPlugin(mock.api)
    const app = express()
    app.use(express.json())
    const router = express.Router()
    plugin.registerWithRouter?.(router)
    app.use(router)

    plugin.start({ httpRequestsEnabled: false }, () => undefined)
    try {
      const res = await request(app).get('/http-requests')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ recent: [], aggregate: [], enabled: false })

      const reset = await request(app).delete('/http-requests')
      expect(reset.status).toBe(204)
    } finally {
      plugin.stop()
    }
  })

  it('runs a real end-to-end capture through the HTTP API', async () => {
    const plugin = createPlugin(mock.api)
    const app = express()
    app.use(express.json())
    const router = express.Router()
    plugin.registerWithRouter?.(router)
    app.use(router)

    plugin.start({}, () => undefined)
    try {
      const started = await request(app).post('/profile').send({ duration: 0.5 })
      expect(started.status).toBe(200)
      const id = started.body.id as string

      const during = await request(app).get('/profile')
      expect(during.body.running?.id).toBe(id)

      let report: request.Response
      const deadline = Date.now() + 10000
      do {
        await sleep(200)
        report = await request(app).get(`/profile/${id}/report`)
      } while (report.status === 404 && Date.now() < deadline)

      expect(report.status).toBe(200)
      expect(report.body.type).toBe('cpu')
      expect(report.body.buckets.length).toBeGreaterThan(0)

      const raw = await request(app).get(`/profile/${id}/raw`)
      expect(raw.status).toBe(200)

      const deleted = await request(app).delete(`/profile/${id}`)
      expect(deleted.status).toBe(204)
      expect(mock.errors).toEqual([])
    } finally {
      plugin.stop()
    }
  })

  it('stops cleanly with an in-flight capture (abort, nothing stored)', async () => {
    const plugin = createPlugin(mock.api)
    const app = express()
    app.use(express.json())
    const router = express.Router()
    plugin.registerWithRouter?.(router)
    app.use(router)

    plugin.start({}, () => undefined)
    const started = await request(app).post('/profile').send({ duration: 60 })
    expect(started.status).toBe(200)
    plugin.stop()
    await sleep(300)

    const files = await fs.readdir(dataDir)
    expect(files.filter((file) => file.endsWith('.cpuprofile'))).toEqual([])
  })
})

describe('detectServerRoot', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-root-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('finds the signalk-server package root above the entry file', async () => {
    const serverDir = path.join(dir, 'signalk-server')
    await fs.mkdir(path.join(serverDir, 'lib'), { recursive: true })
    await fs.writeFile(
      path.join(serverDir, 'package.json'),
      JSON.stringify({ name: 'signalk-server' }),
    )
    const entry = path.join(serverDir, 'lib', 'index.js')
    await fs.writeFile(entry, '')

    expect(detectServerRoot(entry)).toBe(serverDir)
  })

  it('does not match packages that are not signalk-server', async () => {
    await fs.mkdir(path.join(dir, 'lib'), { recursive: true })
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'some-other-app' }))
    const entry = path.join(dir, 'lib', 'app.js')
    await fs.writeFile(entry, '')
    // The walk may still find a real signalk-server package.json above the
    // temp dir (this test can run on an actual Signal K host) — it must just
    // never claim the decoy inside our temp dir.
    const result = detectServerRoot(entry)
    expect(result === undefined || !result.startsWith(dir)).toBe(true)
  })
})
