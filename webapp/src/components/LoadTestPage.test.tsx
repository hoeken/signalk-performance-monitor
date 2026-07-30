import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoadTestPage } from './LoadTestPage'

/** Auto-opening stand-in for the browser socket. */
class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.()
    }, 0)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Fake timers drive the send loop, so the run is advanced explicitly. */
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

describe('LoadTestPage', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let view: ReturnType<typeof render>

  beforeEach(() => {
    FakeSocket.instances = []
    fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ id: 'cpu-1' })))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
    view = render(<LoadTestPage />)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const start = async (ms = 300) => {
    fireEvent.click(screen.getByRole('button', { name: 'Start test' }))
    await advance(ms)
    return FakeSocket.instances[0]!
  }

  /** The docs panel names the same stats, so tile lookups are scoped. */
  const tiles = () => within(screen.getByRole('group', { name: 'Load test progress' }))

  const chooseProfile = (value: string) =>
    fireEvent.change(screen.getByLabelText('Profile during test'), { target: { value } })

  it('offers the delta publishing test with the documented defaults', () => {
    expect(screen.getByLabelText('Test type')).toHaveValue('delta')
    expect(screen.getByLabelText('Test duration (seconds)')).toHaveValue(30)
    expect(screen.getByLabelText('Number of paths')).toHaveValue(500)
    expect(screen.getByLabelText('Delta rate (Hz)')).toHaveValue(500)
    expect(screen.getByLabelText('Deltas per message')).toHaveValue(1)
    expect(screen.getByLabelText('Profile during test')).toHaveValue('none')
    expect(
      screen.getByText('500 deltas/s in 500 messages/s over 500 paths for 30s'),
    ).toBeInTheDocument()
  })

  it('derives the message rate from the batch size', async () => {
    fireEvent.change(screen.getByLabelText('Deltas per message'), { target: { value: '5' } })
    expect(
      screen.getByText('500 deltas/s in 100 messages/s over 500 paths for 30s'),
    ).toBeInTheDocument()

    const socket = await start()
    const values = JSON.parse(socket.sent[0]!).updates[0].values
    expect(values).toHaveLength(5)
    // 100 messages/s carrying 5 deltas each, not 500 messages/s.
    expect(tiles().getByText('Messages/s')).toBeInTheDocument()
    expect(tiles().getByText('Deltas/s')).toBeInTheDocument()
  })

  it('publishes deltas over the delta stream and reports progress', async () => {
    const socket = await start()

    expect(socket.url).toContain('/signalk/v1/stream?subscribe=none')
    expect(socket.sent.length).toBeGreaterThan(0)
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      context: 'vessels.self',
      updates: [{ values: [{ path: expect.stringMatching(/^testing\.\d+$/) }] }],
    })
    // Sent counts successfully sent deltas; bytes are their own tile.
    expect(tiles().getByText('Sent')).toBeInTheDocument()
    // Not socket.sent.length: stats are pushed every 250ms, so the tile shows
    // the count as of the last push, not this instant.
    expect(tiles().getByText(/^deltas in [1-9]\d* messages$/)).toBeInTheDocument()
    expect(tiles().getByText('Deltas/s')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Stop test' }))
    expect(screen.getByRole('button', { name: 'Start test' })).toBeInTheDocument()
  })

  it('starts the selected profile for the test duration before the first delta', async () => {
    chooseProfile('cpu')
    const socket = await start()

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/plugins/signalk-performance-monitor/profile')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ duration: 30 })
    expect(socket.sent.length).toBeGreaterThan(0)
  })

  it('posts a memory profile to the heap route', async () => {
    chooseProfile('heap')
    await start(50)

    expect(fetchMock.mock.calls[0]![0]).toBe('/plugins/signalk-performance-monitor/heap-profile')
  })

  it('aborts the run and shows the error when the profile cannot start', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'capture already running' }, 409))
    chooseProfile('cpu')
    const socket = await start()

    expect(screen.getByRole('alert')).toHaveTextContent('capture already running')
    expect(socket.sent).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Start test' })).toBeInTheDocument()
  })

  it('ends the run when the page is left', async () => {
    const socket = await start()
    const sentWhileRunning = socket.sent.length

    // Route changes unmount the page; the socket must not keep publishing.
    view.unmount()
    await advance(300)

    expect(socket.sent.length).toBe(sentWhileRunning)
  })
})
