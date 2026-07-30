import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeltaLoadTest,
  messageRateOf,
  normalizeConfig,
  streamUrl,
  testPaths,
  type DeltaLoadTestConfig,
  type DeltaLoadTestStats,
} from './loadTest'

/** Minimal stand-in for the browser socket: records sends, opens on demand. */
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  closed = false
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

const CONFIG: DeltaLoadTestConfig = {
  durationSeconds: 5,
  pathCount: 4,
  deltaRate: 100,
  deltasPerMessage: 1,
}

function setup(overrides: Partial<DeltaLoadTestConfig> = {}, beforeRun?: () => Promise<void>) {
  const seen: DeltaLoadTestStats[] = []
  const test = new DeltaLoadTest({
    onStats: (stats) => seen.push(stats),
    beforeRun,
    openSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
  })
  test.start({ ...CONFIG, ...overrides })
  const socket = FakeSocket.instances.at(-1)!
  return { test, socket, latest: () => seen.at(-1)! }
}

describe('streamUrl', () => {
  it('targets the server delta stream with incoming deltas off', () => {
    expect(streamUrl({ protocol: 'http:', host: 'boat.local:3000' } as Location)).toBe(
      'ws://boat.local:3000/signalk/v1/stream?subscribe=none',
    )
    expect(streamUrl({ protocol: 'https:', host: 'boat.local' } as Location)).toBe(
      'wss://boat.local/signalk/v1/stream?subscribe=none',
    )
  })
})

describe('normalizeConfig', () => {
  it('clamps every field to a positive integer', () => {
    expect(
      normalizeConfig({
        durationSeconds: 0,
        pathCount: -5,
        deltaRate: 12.7,
        deltasPerMessage: Number.NaN,
      }),
    ).toEqual({ durationSeconds: 1, pathCount: 1, deltaRate: 12, deltasPerMessage: 1 })
  })

  it('never packs more paths into a message than exist', () => {
    expect(
      normalizeConfig({ ...CONFIG, pathCount: 3, deltasPerMessage: 10 }).deltasPerMessage,
    ).toBe(3)
  })
})

describe('messageRateOf', () => {
  it('divides the delta rate by the batch size', () => {
    expect(messageRateOf({ ...CONFIG, deltaRate: 500, deltasPerMessage: 5 })).toBe(100)
    expect(messageRateOf({ ...CONFIG, deltaRate: 500, deltasPerMessage: 1 })).toBe(500)
  })
})

describe('testPaths', () => {
  it('numbers paths sequentially so reruns reuse them', () => {
    expect(testPaths(3)).toEqual(['testing.0', 'testing.1', 'testing.2'])
  })
})

describe('DeltaLoadTest', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the socket before it reports running', async () => {
    const { socket, latest } = setup()

    expect(socket.url).toContain('/signalk/v1/stream?subscribe=none')
    expect(latest().state).toBe('connecting')

    socket.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(latest().state).toBe('running')
  })

  it('sends deltas at the configured rate', async () => {
    const { socket, latest } = setup({ deltaRate: 100 })
    socket.open()

    await vi.advanceTimersByTimeAsync(1000)

    expect(socket.sent).toHaveLength(100)
    const stats = latest()
    expect(stats.messagesSent).toBe(100)
    expect(stats.deltasSent).toBe(100)
    expect(stats.skippedMessages).toBe(0)
    expect(stats.achievedDeltaRate).toBeCloseTo(100, 0)
    expect(stats.achievedMessageRate).toBeCloseTo(100, 0)
  })

  it('holds the delta rate by sending fewer, batched messages', async () => {
    // pathCount well above the batch size: the clamp keeps a message from
    // listing the same path twice.
    const { socket, latest } = setup({ deltaRate: 100, deltasPerMessage: 5, pathCount: 50 })
    socket.open()

    await vi.advanceTimersByTimeAsync(1000)

    // 100 deltas/s at 5 per message is 20 messages/s, not 100.
    expect(socket.sent).toHaveLength(20)
    const stats = latest()
    expect(stats.deltasSent).toBe(100)
    expect(stats.achievedDeltaRate).toBeCloseTo(100, 0)
    expect(stats.achievedMessageRate).toBeCloseTo(20, 0)
    expect(JSON.parse(socket.sent[0]!).updates[0].values).toHaveLength(5)
  })

  it('carries a partial message worth of deltas as debt, never rounding up', async () => {
    // 30 deltas/s at 4 per message: 7.5 messages/s, so at 400ms exactly 3
    // whole messages (12 deltas) are due and the remaining delta waits.
    const { socket, latest } = setup({ deltaRate: 30, deltasPerMessage: 4 })
    socket.open()

    await vi.advanceTimersByTimeAsync(400)

    expect(socket.sent).toHaveLength(3)
    expect(latest().skippedMessages).toBe(0)
  })

  it('publishes random values round-robin over the test paths', async () => {
    const { socket } = setup({ pathCount: 2, deltasPerMessage: 2, deltaRate: 100 })
    socket.open()

    await vi.advanceTimersByTimeAsync(100)

    expect(JSON.parse(socket.sent[0]!)).toEqual({
      context: 'vessels.self',
      updates: [
        {
          values: [
            { path: 'testing.0', value: expect.any(Number) },
            { path: 'testing.1', value: expect.any(Number) },
          ],
        },
      ],
    })
    const values = socket.sent.flatMap(
      (message) =>
        (JSON.parse(message) as { updates: { values: { value: number }[] }[] }).updates[0]!.values,
    )
    expect(new Set(values.map((entry) => entry.value)).size).toBeGreaterThan(1)
  })

  it('counts deltas and bytes across every message', async () => {
    const { test, socket } = setup({ deltasPerMessage: 2, deltaRate: 20 })
    socket.open()

    await vi.advanceTimersByTimeAsync(200)

    const stats = test.stats()
    expect(stats.messagesSent).toBe(socket.sent.length)
    expect(stats.deltasSent).toBe(stats.messagesSent * 2)
    expect(stats.bytesSent).toBe(socket.sent.reduce((total, message) => total + message.length, 0))
  })

  it('stops itself and closes the socket at the end of the duration', async () => {
    const { socket, latest } = setup({ durationSeconds: 1, deltaRate: 10 })
    socket.open()

    await vi.advanceTimersByTimeAsync(1000)

    expect(latest().state).toBe('finished')
    expect(socket.closed).toBe(true)
    expect(socket.sent).toHaveLength(10)

    // Timers are cleared, so nothing is sent after the run.
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.sent).toHaveLength(10)
    expect(latest().elapsedSeconds).toBeCloseTo(1, 1)
  })

  it('runs beforeRun once the socket is open and before the first delta', async () => {
    const beforeRun = vi.fn(async () => {})
    const { socket } = setup({ deltaRate: 10 }, beforeRun)

    expect(beforeRun).not.toHaveBeenCalled()
    socket.open()
    await vi.advanceTimersByTimeAsync(100)

    expect(beforeRun).toHaveBeenCalledTimes(1)
    expect(socket.sent.length).toBeGreaterThan(0)
  })

  it('aborts without sending when beforeRun fails', async () => {
    const { socket, latest } = setup({}, () => Promise.reject(new Error('capture already running')))
    socket.open()

    await vi.advanceTimersByTimeAsync(200)

    expect(latest()).toMatchObject({ state: 'error', error: 'capture already running' })
    expect(socket.sent).toHaveLength(0)
    expect(socket.closed).toBe(true)
  })

  it('skips instead of queueing when the send buffer backs up', async () => {
    const { socket, latest } = setup({ deltaRate: 100 })
    socket.open()
    socket.bufferedAmount = 8 * 1024 * 1024

    await vi.advanceTimersByTimeAsync(1000)

    expect(socket.sent).toHaveLength(0)
    expect(latest().skippedMessages).toBe(100)
    expect(latest().skippedDeltas).toBe(100)
  })

  it('caps a single tick so a throttled tab cannot burst', async () => {
    const { test, socket } = setup({ deltaRate: 100 })
    socket.open()
    await vi.advanceTimersByTimeAsync(20)

    // A throttled tab: the wall clock jumps 2s while no tick fires, leaving
    // ~200 messages due on the next one. At 100 Hz the cap is 8 per tick.
    vi.setSystemTime(Date.now() + 2000)
    await vi.advanceTimersByTimeAsync(20)

    const stats = test.stats()
    expect(socket.sent).toHaveLength(2 + 8)
    expect(stats.messagesSent).toBe(10)
    expect(stats.skippedMessages).toBe(194)
  })

  it('stops early on request and keeps the partial stats', async () => {
    const { test, socket, latest } = setup({ durationSeconds: 30, deltaRate: 100 })
    socket.open()
    await vi.advanceTimersByTimeAsync(500)

    test.stop()

    expect(latest().state).toBe('finished')
    expect(latest().messagesSent).toBe(50)
    expect(socket.closed).toBe(true)
  })

  it('reports a socket that closes mid-run', async () => {
    const { socket, latest } = setup({ deltaRate: 10 })
    socket.open()
    await vi.advanceTimersByTimeAsync(100)

    socket.onclose?.()

    expect(latest()).toMatchObject({ state: 'error', error: expect.stringContaining('closed') })
  })

  it('ignores a second start while a run is in flight', () => {
    const { test, socket } = setup()
    socket.open()

    test.start(CONFIG)

    expect(FakeSocket.instances).toHaveLength(1)
  })
})
