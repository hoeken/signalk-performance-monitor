/**
 * On-demand CPU and allocation captures via a self-connected
 * `node:inspector` session.
 *
 * The session is in-process: no debug port is opened. The V8 sampling
 * profiler runs off-thread, so overhead is a few percent only while a
 * capture is running. One capture at a time.
 */
import { Session } from 'node:inspector/promises'
import {
  buildCpuReport,
  buildHeapReport,
  type BucketOptions,
  type CpuProfile,
  type DataPathBucketOptions,
  type SamplingHeapProfile,
} from './attribution'
import { FileActivityCapture } from './file-activity'
import {
  capturedAtFromProfileId,
  embeddedProfileMetaOf,
  isValidProfileId,
  makeProfileId,
  profileTypeOf,
  type ProfileStore,
} from './store'
import type { ProfileType, RunningCapture } from './shared/types'

export class CaptureBusyError extends Error {
  constructor() {
    super('a capture is already running')
    this.name = 'CaptureBusyError'
  }
}

export class InvalidProfileError extends Error {
  constructor() {
    super('file is not a V8 .cpuprofile or .heapprofile JSON')
    this.name = 'InvalidProfileError'
  }
}

export class FileCaptureUnsupportedError extends Error {
  constructor() {
    super('file activity capture requires a Linux /proc filesystem')
    this.name = 'FileCaptureUnsupportedError'
  }
}

export interface CpuCaptureOptions {
  durationSeconds: number
  samplingIntervalUs: number
}

export interface HeapCaptureOptions {
  durationSeconds: number
  samplingIntervalBytes: number
}

export interface FilesCaptureOptions {
  durationSeconds: number
  sampleIntervalSeconds: number
}

export interface ImportProfileOptions {
  /** Fallback sampling settings for files without embedded metadata. */
  samplingIntervalUs: number
  samplingIntervalBytes: number
  /** Original filename; a `<id>.json` download name restores the id and capture time. */
  filename?: string
}

function isCpuProfile(raw: unknown): raw is CpuProfile {
  const profile = raw as Partial<CpuProfile> | null
  return (
    typeof profile === 'object' &&
    profile !== null &&
    Array.isArray(profile.nodes) &&
    profile.nodes.length > 0 &&
    typeof profile.nodes[0]?.callFrame === 'object' &&
    typeof profile.startTime === 'number' &&
    typeof profile.endTime === 'number'
  )
}

function isHeapProfile(raw: unknown): raw is SamplingHeapProfile {
  const profile = raw as Partial<SamplingHeapProfile> | null
  return (
    typeof profile === 'object' &&
    profile !== null &&
    typeof profile.head === 'object' &&
    profile.head !== null &&
    typeof profile.head.callFrame === 'object' &&
    typeof profile.head.selfSize === 'number'
  )
}

function idFromFilename(filename: string | undefined, type: ProfileType): string | null {
  if (!filename) return null
  const base = filename.replace(/\.(json|cpuprofile|heapprofile)$/i, '')
  if (!isValidProfileId(base) || profileTypeOf(base) !== type) return null
  return base
}

export interface CaptureManagerOptions {
  store: ProfileStore
  bucketOptions?: BucketOptions
  /** Attribution roots for file activity captures. */
  dataPathOptions?: DataPathBucketOptions
  /** Overridable for tests; defaults to the live /proc/self. */
  procSelfDir?: string
  /** Called when a capture starts (with its status) and when it ends (with null). */
  onStatus?: (running: RunningCapture | null) => void
  onError?: (error: unknown) => void
}

interface RunningState {
  id: string
  type: ProfileType
  startedAt: number
  durationSeconds: number
  abort: AbortController
  done: Promise<void>
}

/** Resolves true if aborted before the timeout elapsed. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class CaptureManager {
  private running: RunningState | null = null

  constructor(private readonly options: CaptureManagerOptions) {}

  status(): RunningCapture | null {
    if (!this.running) return null
    const elapsedSeconds = (Date.now() - this.running.startedAt) / 1000
    return {
      id: this.running.id,
      type: this.running.type,
      startedAt: new Date(this.running.startedAt).toISOString(),
      durationSeconds: this.running.durationSeconds,
      remainingSeconds: Math.max(0, Math.ceil(this.running.durationSeconds - elapsedSeconds)),
    }
  }

  async startCpu(options: CpuCaptureOptions): Promise<string> {
    if (this.running) throw new CaptureBusyError()

    const session = new Session()
    session.connect()
    try {
      await session.post('Profiler.enable')
      await session.post('Profiler.setSamplingInterval', {
        interval: options.samplingIntervalUs,
      })
      await session.post('Profiler.start')
    } catch (error) {
      session.disconnect()
      throw error
    }

    const state = this.beginCapture('cpu', options.durationSeconds)
    state.done = this.finishCpu(session, state, options.samplingIntervalUs)
    return state.id
  }

  private async finishCpu(
    session: Session,
    state: RunningState,
    samplingIntervalUs: number,
  ): Promise<void> {
    try {
      const aborted = await interruptibleSleep(state.durationSeconds * 1000, state.abort.signal)
      const { profile } = await session.post('Profiler.stop')
      await session.post('Profiler.disable')
      if (!aborted) {
        const report = buildCpuReport(
          profile as unknown as CpuProfile,
          {
            id: state.id,
            capturedAt: new Date(state.startedAt).toISOString(),
            samplingIntervalUs,
          },
          this.options.bucketOptions,
        )
        await this.options.store.save(report, profile)
      }
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.endCapture(session, state)
    }
  }

  async startHeap(options: HeapCaptureOptions): Promise<string> {
    if (this.running) throw new CaptureBusyError()

    const session = new Session()
    session.connect()
    try {
      await session.post('HeapProfiler.enable')
      await session.post('HeapProfiler.startSampling', {
        samplingInterval: options.samplingIntervalBytes,
      })
    } catch (error) {
      session.disconnect()
      throw error
    }

    const state = this.beginCapture('heap', options.durationSeconds)
    state.done = this.finishHeap(session, state, options.samplingIntervalBytes)
    return state.id
  }

  private async finishHeap(
    session: Session,
    state: RunningState,
    samplingIntervalBytes: number,
  ): Promise<void> {
    try {
      const aborted = await interruptibleSleep(state.durationSeconds * 1000, state.abort.signal)
      const { profile } = await session.post('HeapProfiler.stopSampling')
      await session.post('HeapProfiler.disable')
      if (!aborted) {
        const report = buildHeapReport(
          profile as unknown as SamplingHeapProfile,
          {
            id: state.id,
            capturedAt: new Date(state.startedAt).toISOString(),
            durationMs: Date.now() - state.startedAt,
            samplingIntervalBytes,
          },
          this.options.bucketOptions,
        )
        await this.options.store.save(report, profile)
      }
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.endCapture(session, state)
    }
  }

  /**
   * Start a file activity capture: open-file inventory, per-file stat
   * deltas, and passive SQLite WAL-index counters, sampled on an interval
   * and checked against the process-wide /proc/self/io totals. No inspector
   * session — but it shares the one-capture-at-a-time slot so the UI story
   * stays simple.
   */
  async startFiles(options: FilesCaptureOptions): Promise<string> {
    if (this.running) throw new CaptureBusyError()
    if (!FileActivityCapture.isSupported(this.options.procSelfDir)) {
      throw new FileCaptureUnsupportedError()
    }

    const capture = new FileActivityCapture({
      procSelfDir: this.options.procSelfDir,
      bucketOptions: this.options.dataPathOptions,
    })
    await capture.sample() // baseline

    const state = this.beginCapture('files', options.durationSeconds)
    state.done = this.finishFiles(capture, state, options.sampleIntervalSeconds)
    return state.id
  }

  private async finishFiles(
    capture: FileActivityCapture,
    state: RunningState,
    sampleIntervalSeconds: number,
  ): Promise<void> {
    try {
      const endAt = state.startedAt + state.durationSeconds * 1000
      const intervalMs = sampleIntervalSeconds * 1000
      let aborted = false
      while (!aborted && Date.now() < endAt) {
        const waitMs = Math.min(intervalMs, endAt - Date.now())
        aborted = await interruptibleSleep(waitMs, state.abort.signal)
        if (!aborted) await capture.sample()
      }
      if (!aborted) {
        const report = capture.buildReport({
          id: state.id,
          capturedAt: new Date(state.startedAt).toISOString(),
          durationMs: Date.now() - state.startedAt,
          sampleIntervalSeconds,
        })
        await this.options.store.save(report, capture.rawCapture())
      }
    } catch (error) {
      this.options.onError?.(error)
    } finally {
      this.endCapture(null, state)
    }
  }

  /**
   * Store a previously downloaded raw profile, rebuilding its report.
   * Runs no inspector session, so it is allowed while a capture is running.
   *
   * Capture time and sampling settings come from the file's embedded
   * metadata (written by ProfileStore.save on every capture), falling back
   * to the download filename and then the configured defaults for files
   * from other tools or older plugin versions.
   */
  async importProfile(raw: unknown, options: ImportProfileOptions): Promise<string> {
    const type = isCpuProfile(raw) ? 'cpu' : isHeapProfile(raw) ? 'heap' : null
    if (!type) throw new InvalidProfileError()

    const embedded = embeddedProfileMetaOf(raw)
    const embeddedId = embedded.id && profileTypeOf(embedded.id) === type ? embedded.id : null

    const now = new Date()
    const id = embeddedId ?? idFromFilename(options.filename, type) ?? makeProfileId(type, now)
    const capturedAt = embedded.capturedAt ?? capturedAtFromProfileId(id) ?? now.toISOString()

    const report =
      type === 'cpu'
        ? buildCpuReport(
            raw as CpuProfile,
            {
              id,
              capturedAt,
              samplingIntervalUs: embedded.samplingIntervalUs ?? options.samplingIntervalUs,
            },
            this.options.bucketOptions,
          )
        : buildHeapReport(
            raw as SamplingHeapProfile,
            // A raw heap profile records no wall-clock duration itself.
            {
              id,
              capturedAt,
              durationMs: embedded.durationMs ?? 0,
              samplingIntervalBytes:
                embedded.samplingIntervalBytes ?? options.samplingIntervalBytes,
            },
            this.options.bucketOptions,
          )

    await this.options.store.save(report, raw)
    return id
  }

  private beginCapture(type: ProfileType, durationSeconds: number): RunningState {
    const state: RunningState = {
      id: makeProfileId(type, new Date()),
      type,
      startedAt: Date.now(),
      durationSeconds,
      abort: new AbortController(),
      done: Promise.resolve(),
    }
    this.running = state
    this.options.onStatus?.(this.status())
    return state
  }

  private endCapture(session: Session | null, state: RunningState): void {
    try {
      session?.disconnect()
    } catch {
      // already disconnected
    }
    if (this.running === state) {
      this.running = null
      this.options.onStatus?.(null)
    }
  }

  /** Abort any in-flight capture and wait for the session to be torn down. */
  async abort(): Promise<void> {
    const running = this.running
    if (!running) return
    running.abort.abort()
    await running.done
  }
}
