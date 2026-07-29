import { createServer, get, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import { collapsePath, HttpRequestTracker, RECENT_LIMIT } from '../src/http-requests'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const T0 = Date.UTC(2026, 6, 28, 10, 0, 0)

function detail(overrides: {
  method?: string
  url?: string
  statusCode?: number
  headers?: Record<string, unknown>
}): unknown {
  return {
    req: { method: overrides.method ?? 'GET', url: overrides.url ?? '/a', headers: {} },
    res: {
      statusCode: overrides.statusCode ?? 200,
      statusMessage: 'OK',
      headers: overrides.headers ?? {},
    },
  }
}

describe('collapsePath', () => {
  it('truncates resource paths after the resource type', () => {
    expect(
      collapsePath(
        '/signalk/v1/api/vessels/self/resources/routes/23b88b4b-a700-5c78-97cb-38565297354f',
      ),
    ).toBe('/signalk/v1/api/vessels/self/resources/routes')
    expect(collapsePath('/signalk/v1/api/resources/charts/Fiji_Viti_Levu-NW/10/1016/564')).toBe(
      '/signalk/v1/api/resources/charts',
    )
    expect(collapsePath('/signalk/v2/api/resources/waypoints/abc')).toBe(
      '/signalk/v2/api/resources/waypoints',
    )
  })

  it('leaves resource-type roots and unrelated paths alone', () => {
    expect(collapsePath('/signalk/v1/api/resources/charts')).toBe(
      '/signalk/v1/api/resources/charts',
    )
    expect(collapsePath('/signalk/v1/api/vessels/self/navigation/position')).toBe(
      '/signalk/v1/api/vessels/self/navigation/position',
    )
    expect(collapsePath('/webapp/resources/charts/10/1016/564')).toBe(
      '/webapp/resources/charts/10/1016/564',
    )
  })
})

describe('HttpRequestTracker', () => {
  it('records recent requests newest-first with query strings kept', () => {
    const tracker = new HttpRequestTracker()
    tracker.record(2.5, detail({ url: '/a?x=1', headers: { 'content-length': '123' } }), T0)
    tracker.record(1.25, detail({ method: 'POST', url: '/b', statusCode: 201 }), T0 + 1000)

    const { recent } = tracker.snapshot()
    expect(recent).toEqual([
      {
        timestamp: '2026-07-28T10:00:01.000Z',
        method: 'POST',
        path: '/b',
        statusCode: 201,
        durationMs: 1.25,
      },
      {
        timestamp: '2026-07-28T10:00:00.000Z',
        method: 'GET',
        path: '/a?x=1',
        statusCode: 200,
        durationMs: 2.5,
        responseBytes: 123,
      },
    ])
  })

  it('keeps only the last requests once past the limit', () => {
    const tracker = new HttpRequestTracker()
    for (let i = 0; i < RECENT_LIMIT + 20; i++) {
      tracker.record(1, detail({ url: `/req/${i}` }), T0 + i)
    }
    const { recent } = tracker.snapshot()
    expect(recent).toHaveLength(RECENT_LIMIT)
    expect(recent[0]!.path).toBe(`/req/${RECENT_LIMIT + 19}`)
    expect(recent[RECENT_LIMIT - 1]!.path).toBe('/req/20')
  })

  it('aggregates by method and path with query strings stripped', () => {
    const tracker = new HttpRequestTracker()
    tracker.record(2, detail({ url: '/a?x=1', headers: { 'content-length': '100' } }), T0)
    tracker.record(4, detail({ url: '/a?x=2', headers: { 'content-length': '50' } }), T0 + 1000)
    tracker.record(1, detail({ method: 'POST', url: '/a' }), T0 + 2000)

    const { aggregate } = tracker.snapshot()
    expect(aggregate).toHaveLength(2)
    expect(aggregate.find((s) => s.method === 'GET')).toEqual({
      method: 'GET',
      path: '/a',
      count: 2,
      totalMs: 6,
      maxMs: 4,
      errorCount: 0,
      totalBytes: 150,
      lastSeen: '2026-07-28T10:00:01.000Z',
    })
    expect(aggregate.find((s) => s.method === 'POST')?.count).toBe(1)
  })

  it('counts 4xx/5xx responses as errors', () => {
    const tracker = new HttpRequestTracker()
    tracker.record(1, detail({ url: '/a', statusCode: 200 }), T0)
    tracker.record(1, detail({ url: '/a', statusCode: 404 }), T0)
    tracker.record(1, detail({ url: '/a', statusCode: 500 }), T0)
    expect(tracker.snapshot().aggregate[0]!.errorCount).toBe(2)
  })

  it('collapses resource entry paths to the resource type in aggregates only', () => {
    const tracker = new HttpRequestTracker()
    tracker.record(
      1,
      detail({ url: '/signalk/v1/api/resources/charts/Fiji_Viti_Levu-NW/10/1016/564' }),
      T0,
    )
    tracker.record(
      1,
      detail({ url: '/signalk/v1/api/resources/charts/Fiji_Viti_Levu-NW/10/1016/565' }),
      T0,
    )

    const { recent, aggregate } = tracker.snapshot()
    expect(aggregate).toEqual([
      expect.objectContaining({ path: '/signalk/v1/api/resources/charts', count: 2 }),
    ])
    expect(recent.map((r) => r.path)).toEqual([
      '/signalk/v1/api/resources/charts/Fiji_Viti_Levu-NW/10/1016/565',
      '/signalk/v1/api/resources/charts/Fiji_Viti_Levu-NW/10/1016/564',
    ])
  })

  it('ignores entries without the expected detail shape', () => {
    const tracker = new HttpRequestTracker()
    tracker.record(1, undefined, T0)
    tracker.record(1, { req: { method: 'GET' } }, T0)
    tracker.record(1, { req: { method: 'GET', url: '/a' }, res: {} }, T0)
    expect(tracker.snapshot()).toEqual({ recent: [], aggregate: [] })
  })

  it('clears all state on stop', () => {
    const tracker = new HttpRequestTracker()
    tracker.start()
    tracker.record(1, detail({ url: '/a' }), T0)
    tracker.stop()
    expect(tracker.snapshot()).toEqual({ recent: [], aggregate: [] })
  })

  it('observes real inbound requests while started', async () => {
    const tracker = new HttpRequestTracker()
    tracker.start()
    const server: Server = createServer((req, res) => {
      res.setHeader('Content-Length', 2)
      res.end('ok')
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('expected a port')
      await new Promise<void>((resolve, reject) => {
        get(`http://127.0.0.1:${address.port}/hello?greeting=1`, (res) => {
          res.resume()
          res.on('end', resolve)
        }).on('error', reject)
      })
      // Observer callbacks dispatch asynchronously; give them a beat to land.
      await sleep(50)

      const { recent, aggregate } = tracker.snapshot()
      const hit = recent.find((r) => r.path === '/hello?greeting=1')
      expect(hit).toMatchObject({ method: 'GET', statusCode: 200, responseBytes: 2 })
      expect(hit!.durationMs).toBeGreaterThan(0)
      expect(Math.abs(new Date(hit!.timestamp).getTime() - Date.now())).toBeLessThan(5000)
      expect(aggregate.find((s) => s.path === '/hello')).toMatchObject({ method: 'GET', count: 1 })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      tracker.stop()
    }
  })
})
