/**
 * Browser-side Signal K delta load generator.
 *
 * Opens a websocket to the server's own delta stream and publishes synthetic
 * `testing.<n>` values at a configured rate. Deliberately client-side: the
 * deltas travel the same inbound path a real producer's would (websocket
 * parse → `handleMessage` → full-model update → subscription fan-out), so a
 * profile captured during the run measures the server's delta pipeline rather
 * than a plugin calling itself.
 *
 * A **delta** here is one path/value pair — the unit of work the server
 * actually does — and a websocket **message** is the envelope carrying one or
 * more of them. The delta rate is therefore what the run is configured by;
 * `deltasPerMessage` divides it into the message rate, so batching trades
 * messages for envelope overhead without changing the load.
 *
 * Rate is held by a catch-up accumulator, not one timer per message: browsers
 * clamp `setInterval` to ~4ms and throttle background tabs hard, so a tick
 * every SEND_TICK_MS sends however many messages the wall clock says are due.
 * Per-tick bursts are capped and the shortfall reported as skipped, so a
 * throttled or backpressured tab reports honestly instead of firing a
 * catch-up storm at the server once it wakes up.
 */

/** Every path published by the tester lives under this prefix. */
export const TEST_PATH_PREFIX = 'testing'

/** Send-loop period; 20ms is well clear of the browser's ~4ms clamp. */
const SEND_TICK_MS = 20
/** How often stats are pushed to the UI, independent of the send rate. */
const STATS_TICK_MS = 250
/** Stop sending while the socket's own queue is this far behind. */
const MAX_BUFFERED_BYTES = 1024 * 1024
/** A single tick may send at most this many ticks' worth of messages. */
const MAX_BURST_TICKS = 4
/** `WebSocket.OPEN`, spelled out so the sender doesn't depend on the global. */
const SOCKET_OPEN = 1

export type LoadTestState = 'idle' | 'connecting' | 'running' | 'finished' | 'error'

export interface DeltaLoadTestConfig {
  durationSeconds: number
  /** Distinct `testing.<n>` paths the run cycles through. */
  pathCount: number
  /** Deltas (path/value pairs) per second, aggregate — the configured load. */
  deltaRate: number
  /** Deltas per websocket message; divides `deltaRate` into the message rate. */
  deltasPerMessage: number
}

export const DEFAULT_LOAD_TEST_CONFIG: DeltaLoadTestConfig = {
  durationSeconds: 30,
  pathCount: 500,
  deltaRate: 500,
  deltasPerMessage: 1,
}

/** Websocket messages per second implied by the delta rate and batch size. */
export const messageRateOf = (config: DeltaLoadTestConfig): number =>
  config.deltaRate / config.deltasPerMessage

export interface DeltaLoadTestStats {
  state: LoadTestState
  /** Seconds since the first delta; frozen once the run ends. */
  elapsedSeconds: number
  messagesSent: number
  /** `messagesSent` × the batch size — the load the server actually saw. */
  deltasSent: number
  bytesSent: number
  /** Messages per second achieved so far. */
  achievedMessageRate: number
  /** Deltas per second achieved so far — compare against the configured rate. */
  achievedDeltaRate: number
  /** Messages the accumulator gave up on: backpressure, or a throttled tab. */
  skippedMessages: number
  /** The same shortfall in deltas, the unit the run is configured in. */
  skippedDeltas: number
  error: string | null
}

export interface DeltaLoadTestHooks {
  onStats(stats: DeltaLoadTestStats): void
  /**
   * Awaited once the socket is open and before the first delta — where the
   * page starts a profile, so the capture window covers the load and not the
   * connect handshake. A rejection aborts the run with its message.
   */
  beforeRun?(): Promise<void>
  /** WebSocket factory; overridden in tests. */
  openSocket?(url: string): WebSocket
}

/** The server's delta stream on this origin, with its own deltas turned off. */
export function streamUrl(location: Location | URL = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/signalk/v1/stream?subscribe=none`
}

/**
 * Clamped to what the sender can honour: deltas per message never exceeds the
 * path count (a message must not list the same path twice) and every field is
 * a positive integer, so a half-typed form field can't produce a broken run.
 */
export function normalizeConfig(config: DeltaLoadTestConfig): DeltaLoadTestConfig {
  const pathCount = clampInt(config.pathCount, 1, 100_000)
  return {
    durationSeconds: clampInt(config.durationSeconds, 1, 3600),
    pathCount,
    deltaRate: clampInt(config.deltaRate, 1, 100_000),
    deltasPerMessage: clampInt(config.deltasPerMessage, 1, pathCount),
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * Path ids are the index, not a fresh random number per run: the server keeps
 * every path it has ever seen in its full model, so stable ids mean repeated
 * runs reuse the same `pathCount` paths instead of growing the model forever.
 */
export function testPaths(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${TEST_PATH_PREFIX}.${index}`)
}

export class DeltaLoadTest {
  private config = DEFAULT_LOAD_TEST_CONFIG
  private socket: WebSocket | null = null
  private paths: string[] = []
  private nextPathIndex = 0
  private sendTimer: ReturnType<typeof setInterval> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private startedAt = 0
  private stoppedAt = 0
  private state: LoadTestState = 'idle'
  private messagesSent = 0
  private bytesSent = 0
  private skippedMessages = 0
  private error: string | null = null
  /** Set while we close the socket ourselves, so `onclose` isn't read as a failure. */
  private closing = false

  constructor(private readonly hooks: DeltaLoadTestHooks) {}

  get busy(): boolean {
    return this.state === 'connecting' || this.state === 'running'
  }

  stats(): DeltaLoadTestStats {
    const elapsedSeconds = this.elapsedSeconds()
    const batch = this.config.deltasPerMessage
    const deltasSent = this.messagesSent * batch
    return {
      state: this.state,
      elapsedSeconds,
      messagesSent: this.messagesSent,
      deltasSent,
      bytesSent: this.bytesSent,
      achievedMessageRate: elapsedSeconds > 0 ? this.messagesSent / elapsedSeconds : 0,
      achievedDeltaRate: elapsedSeconds > 0 ? deltasSent / elapsedSeconds : 0,
      skippedMessages: this.skippedMessages,
      skippedDeltas: this.skippedMessages * batch,
      error: this.error,
    }
  }

  start(config: DeltaLoadTestConfig): void {
    if (this.busy) return
    this.config = normalizeConfig(config)
    this.paths = testPaths(this.config.pathCount)
    this.nextPathIndex = 0
    this.messagesSent = 0
    this.bytesSent = 0
    this.skippedMessages = 0
    this.startedAt = 0
    this.stoppedAt = 0
    this.error = null
    this.closing = false
    this.state = 'connecting'
    this.emit()

    let socket: WebSocket
    try {
      socket = (this.hooks.openSocket ?? ((url: string) => new WebSocket(url)))(streamUrl())
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      return
    }
    this.socket = socket
    socket.onopen = () => void this.onOpen()
    socket.onerror = () => this.fail('websocket error — is the Signal K server reachable?')
    socket.onclose = () => {
      if (!this.closing && this.busy) this.fail('websocket closed before the test finished')
    }
  }

  /** Ends the run early; the stats stay on screen as a partial result. */
  stop(): void {
    if (!this.busy) return
    this.finish('finished')
  }

  private async onOpen(): Promise<void> {
    if (this.state !== 'connecting') return
    try {
      await this.hooks.beforeRun?.()
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      return
    }
    // A stop() or a socket close while beforeRun was in flight wins.
    if (this.state !== 'connecting') return

    this.state = 'running'
    this.startedAt = Date.now()
    this.sendTimer = setInterval(() => this.tick(), SEND_TICK_MS)
    this.statsTimer = setInterval(() => this.emit(), STATS_TICK_MS)
    this.emit()
  }

  private tick(): void {
    const socket = this.socket
    if (this.state !== 'running' || !socket) return

    const { durationSeconds, deltaRate, deltasPerMessage } = this.config
    const elapsed = (Date.now() - this.startedAt) / 1000
    // Deltas the wall clock says should have gone out by now, minus those
    // already sent or written off — so the rate self-corrects after a late
    // tick without the write-offs coming back as debt. Whole messages only:
    // a partial message's worth stays as debt for the next tick rather than
    // being written off or rounded up.
    const owed =
      Math.floor(Math.min(elapsed, durationSeconds) * deltaRate) -
      (this.messagesSent + this.skippedMessages) * deltasPerMessage
    const due = Math.floor(Math.max(0, owed) / deltasPerMessage)

    if (socket.readyState !== SOCKET_OPEN) {
      this.skippedMessages += due
    } else {
      // Not reported: on a healthy connection it never leaves zero, and when
      // it doesn't, the Skipped counter is what says so.
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.skippedMessages += due
      } else {
        const messageRate = messageRateOf(this.config)
        const burst = Math.max(1, Math.ceil((messageRate * SEND_TICK_MS) / 1000) * MAX_BURST_TICKS)
        const send = Math.min(due, burst)
        this.skippedMessages += due - send
        for (let i = 0; i < send; i += 1) this.send(socket)
      }
    }

    if (elapsed >= durationSeconds) this.finish('finished')
  }

  private send(socket: WebSocket): void {
    const message = this.nextMessage()
    socket.send(message)
    this.messagesSent += 1
    // The payload is ASCII (paths, numbers, punctuation), so length is bytes.
    this.bytesSent += message.length
  }

  /** Round-robin over the path list so every path gets the same share. */
  private nextMessage(): string {
    const values: { path: string; value: number }[] = []
    for (let i = 0; i < this.config.deltasPerMessage; i += 1) {
      values.push({
        path: this.paths[this.nextPathIndex]!,
        // Three decimals: random enough to defeat any value-equality
        // short-circuit, short enough to keep the payload sensor-sized.
        value: Math.round(Math.random() * 1e5) / 1e3,
      })
      this.nextPathIndex = (this.nextPathIndex + 1) % this.paths.length
    }
    return JSON.stringify({ context: 'vessels.self', updates: [{ values }] })
  }

  private fail(message: string): void {
    this.error = message
    this.finish('error')
  }

  private finish(state: LoadTestState): void {
    if (this.sendTimer) clearInterval(this.sendTimer)
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.sendTimer = null
    this.statsTimer = null
    this.stoppedAt = Date.now()
    this.state = state
    const socket = this.socket
    this.socket = null
    if (socket) {
      this.closing = true
      socket.onopen = null
      socket.onerror = null
      socket.onclose = null
      try {
        socket.close()
      } catch {
        // already closing or closed
      }
    }
    this.emit()
  }

  private elapsedSeconds(): number {
    if (!this.startedAt) return 0
    const end = this.state === 'running' ? Date.now() : this.stoppedAt
    return Math.max(0, (end - this.startedAt) / 1000)
  }

  private emit(): void {
    this.hooks.onStats(this.stats())
  }
}
