/**
 * Integration tests: these connect a real inspector session to the test
 * process and profile it, exactly as the plugin does to the Signal K server.
 */
import { promises as fs, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CaptureBusyError,
  CaptureManager,
  FileCaptureUnsupportedError,
  InvalidProfileError,
} from '../src/capture'
import { ProfileStore } from '../src/store'
import type { CpuReport, FilesReport, HeapReport, RunningCapture } from '../src/shared/types'

function busyWait(ms: number): void {
  const until = Date.now() + ms
  let x = 0
  while (Date.now() < until) {
    x += Math.sqrt(Math.random())
  }
  if (x < 0) throw new Error('unreachable')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForIdle(manager: CaptureManager, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (manager.status() !== null) {
    if (Date.now() - start > timeoutMs) throw new Error('capture did not finish in time')
    await sleep(50)
  }
}

describe('CaptureManager', () => {
  let dir: string
  let store: ProfileStore
  let statusUpdates: (RunningCapture | null)[]
  let errors: unknown[]
  let manager: CaptureManager

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-capture-'))
    store = new ProfileStore(dir, 5)
    statusUpdates = []
    errors = []
    manager = new CaptureManager({
      store,
      bucketOptions: {},
      onStatus: (running) => statusUpdates.push(running),
      onError: (error) => errors.push(error),
    })
  })

  afterEach(async () => {
    await manager.abort()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('captures a CPU profile of this process and stores raw + report', async () => {
    const id = await manager.startCpu({ durationSeconds: 0.5, samplingIntervalUs: 500 })
    expect(id).toMatch(/^cpu-/)

    const status = manager.status()
    expect(status?.id).toBe(id)
    expect(status?.type).toBe('cpu')

    busyWait(300)
    await waitForIdle(manager)
    expect(errors).toEqual([])

    const report = (await store.getReport(id)) as CpuReport
    expect(report.type).toBe('cpu')
    expect(report.samplingIntervalUs).toBe(500)
    expect(report.durationMs).toBeGreaterThan(300)
    expect(report.buckets.length).toBeGreaterThan(0)
    expect(report.totalTimeMs).toBeGreaterThan(0)

    const raw = await store.getRaw(id)
    const profile = JSON.parse(raw!.toString())
    expect(Array.isArray(profile.nodes)).toBe(true)
    expect(profile.nodes.length).toBeGreaterThan(0)

    expect(statusUpdates[0]?.id).toBe(id)
    expect(statusUpdates.at(-1)).toBeNull()
  })

  it('captures an allocation profile and buckets allocations', async () => {
    const id = await manager.startHeap({ durationSeconds: 0.5, samplingIntervalBytes: 4096 })
    expect(id).toMatch(/^heap-/)

    const garbage: unknown[] = []
    for (let i = 0; i < 5000; i++) {
      garbage.push(new Array(64).fill(i).join(','))
    }
    expect(garbage.length).toBe(5000)

    await waitForIdle(manager)
    expect(errors).toEqual([])

    const report = (await store.getReport(id)) as HeapReport
    expect(report.type).toBe('heap')
    expect(report.samplingIntervalBytes).toBe(4096)
    expect(report.totalBytes).toBeGreaterThan(0)
    expect(report.buckets.length).toBeGreaterThan(0)
  })

  it('rejects overlapping captures with CaptureBusyError', async () => {
    await manager.startCpu({ durationSeconds: 2, samplingIntervalUs: 1000 })
    await expect(
      manager.startCpu({ durationSeconds: 1, samplingIntervalUs: 1000 }),
    ).rejects.toThrow(CaptureBusyError)
    await expect(
      manager.startHeap({ durationSeconds: 1, samplingIntervalBytes: 32768 }),
    ).rejects.toThrow(CaptureBusyError)
    await expect(
      manager.startFiles({ durationSeconds: 1, sampleIntervalSeconds: 1 }),
    ).rejects.toThrow(CaptureBusyError)
    await manager.abort()
  })

  it('captures file activity against a proc layout and stores raw + report', async () => {
    // A minimal fake /proc/self: an io file and an empty fd inventory, so
    // the loop runs identically on every platform.
    const procSelf = path.join(dir, 'proc-self')
    await fs.mkdir(path.join(procSelf, 'fd'), { recursive: true })
    await fs.mkdir(path.join(procSelf, 'fdinfo'), { recursive: true })
    await fs.writeFile(
      path.join(procSelf, 'io'),
      'rchar: 0\nwchar: 0\nread_bytes: 0\nwrite_bytes: 4096\n',
    )
    const filesManager = new CaptureManager({
      store,
      procSelfDir: procSelf,
      dataPathOptions: { dataRoot: dir },
      onError: (error) => errors.push(error),
    })

    const id = await filesManager.startFiles({ durationSeconds: 0.4, sampleIntervalSeconds: 0.1 })
    expect(id).toMatch(/^files-/)
    expect(filesManager.status()?.type).toBe('files')

    await fs.writeFile(
      path.join(procSelf, 'io'),
      'rchar: 0\nwchar: 0\nread_bytes: 0\nwrite_bytes: 104096\n',
    )
    await waitForIdle(filesManager)
    expect(errors).toEqual([])

    const report = (await store.getReport(id)) as FilesReport
    expect(report.type).toBe('files')
    expect(report.sampleIntervalSeconds).toBe(0.1)
    expect(report.sampleCount).toBeGreaterThanOrEqual(2)
    expect(report.totals.writeBytes).toBe(100000)
    expect(report.attribution.at(-1)?.name).toBe('(unattributed)')

    const raw = JSON.parse((await store.getRaw(id))!.toString()) as {
      samples: unknown[]
    }
    expect(raw.samples.length).toBe(report.sampleCount)
  })

  it('refuses file captures without a proc filesystem', async () => {
    const noProc = new CaptureManager({ store, procSelfDir: path.join(dir, 'missing') })
    await expect(
      noProc.startFiles({ durationSeconds: 1, sampleIntervalSeconds: 1 }),
    ).rejects.toThrow(FileCaptureUnsupportedError)
    expect(noProc.status()).toBeNull()
  })

  it('aborts an in-flight file capture without storing anything', async () => {
    const procSelf = path.join(dir, 'proc-self-abort')
    await fs.mkdir(path.join(procSelf, 'fd'), { recursive: true })
    await fs.mkdir(path.join(procSelf, 'fdinfo'), { recursive: true })
    await fs.writeFile(path.join(procSelf, 'io'), 'read_bytes: 0\nwrite_bytes: 0\n')
    const filesManager = new CaptureManager({
      store,
      procSelfDir: procSelf,
      onError: (error) => errors.push(error),
    })

    const id = await filesManager.startFiles({ durationSeconds: 30, sampleIntervalSeconds: 1 })
    await sleep(50)
    await filesManager.abort()

    expect(filesManager.status()).toBeNull()
    expect(await store.getReport(id)).toBeNull()
    expect(errors).toEqual([])
  })

  it('aborts an in-flight capture without storing anything', async () => {
    const id = await manager.startCpu({ durationSeconds: 30, samplingIntervalUs: 1000 })
    await sleep(100)
    await manager.abort()

    expect(manager.status()).toBeNull()
    expect(await store.getReport(id)).toBeNull()
    expect(await store.list()).toEqual([])

    // and a new capture can start afterwards
    const nextId = await manager.startCpu({ durationSeconds: 0.3, samplingIntervalUs: 1000 })
    await waitForIdle(manager)
    expect(await store.getReport(nextId)).not.toBeNull()
  })

  it('imports a downloaded cpu profile, restoring id and capture time', async () => {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(__dirname, 'fixtures', 'sample.cpuprofile'), 'utf8'),
    )
    const id = await manager.importProfile(raw, {
      samplingIntervalUs: 500,
      samplingIntervalBytes: 32768,
      filename: 'cpu-2026-07-01T12-30-00-000Z.json',
    })

    expect(id).toBe('cpu-2026-07-01T12-30-00-000Z')
    const report = (await store.getReport(id)) as CpuReport
    expect(report.type).toBe('cpu')
    expect(report.capturedAt).toBe('2026-07-01T12:30:00.000Z')
    expect(report.samplingIntervalUs).toBe(500)
    expect(report.buckets.length).toBeGreaterThan(0)
    // stored raw keeps the profile intact and gains embedded metadata
    const stored = JSON.parse((await store.getRaw(id))!.toString()) as Record<string, unknown>
    expect(stored).toMatchObject(raw as object)
    expect(stored['signalk-performance-monitor']).toMatchObject({ id })
  })

  it('round-trips a downloaded capture through import unchanged', async () => {
    const id = await manager.startCpu({ durationSeconds: 0.3, samplingIntervalUs: 500 })
    busyWait(200)
    await waitForIdle(manager)
    expect(errors).toEqual([])
    const original = await store.getReport(id)
    const raw: unknown = JSON.parse((await store.getRaw(id))!.toString())
    await store.delete(id)

    const importedId = await manager.importProfile(raw, {
      // both ignored: the file's embedded metadata wins
      samplingIntervalUs: 9999,
      samplingIntervalBytes: 9999,
    })

    expect(importedId).toBe(id)
    expect(await store.getReport(id)).toEqual(original)
  })

  it('prefers embedded metadata over the filename on import', async () => {
    const raw = {
      head: {
        callFrame: { functionName: '(root)', url: '' },
        selfSize: 0,
        children: [{ callFrame: { functionName: 'alloc', url: 'file:///app.js' }, selfSize: 1024 }],
      },
      'signalk-performance-monitor': {
        id: 'heap-2026-07-02T08-00-00-000Z',
        type: 'heap',
        capturedAt: '2026-07-02T08:00:00.000Z',
        durationMs: 45000,
        samplingIntervalBytes: 4096,
      },
    }
    const id = await manager.importProfile(raw, {
      samplingIntervalUs: 1000,
      samplingIntervalBytes: 32768,
      filename: 'heap-2026-07-03T09-00-00-000Z.json',
    })

    expect(id).toBe('heap-2026-07-02T08-00-00-000Z')
    const report = (await store.getReport(id)) as HeapReport
    expect(report.capturedAt).toBe('2026-07-02T08:00:00.000Z')
    expect(report.durationMs).toBe(45000)
    expect(report.samplingIntervalBytes).toBe(4096)
  })

  it('imports a heap profile under a fresh id when the filename does not match', async () => {
    const raw = {
      head: {
        callFrame: { functionName: '(root)', url: '' },
        selfSize: 0,
        children: [{ callFrame: { functionName: 'alloc', url: 'file:///app.js' }, selfSize: 2048 }],
      },
    }
    const id = await manager.importProfile(raw, {
      samplingIntervalUs: 1000,
      samplingIntervalBytes: 4096,
      filename: 'my profile (1).json',
    })

    expect(id).toMatch(/^heap-/)
    const report = (await store.getReport(id)) as HeapReport
    expect(report.type).toBe('heap')
    expect(report.samplingIntervalBytes).toBe(4096)
    expect(report.totalBytes).toBe(2048)
  })

  it('rejects a cpu-named upload whose content is a heap profile', async () => {
    const raw = { head: { callFrame: { functionName: '(root)', url: '' }, selfSize: 0 } }
    const id = await manager.importProfile(raw, {
      samplingIntervalUs: 1000,
      samplingIntervalBytes: 32768,
      filename: 'cpu-2026-07-01T12-30-00-000Z.json',
    })
    // type comes from the content; the mismatched filename id is ignored
    expect(id).toMatch(/^heap-/)
  })

  it('rejects files that are not V8 profiles', async () => {
    for (const raw of [null, 'hello', 42, {}, { nodes: 'nope' }, { head: { selfSize: 1 } }]) {
      await expect(
        manager.importProfile(raw, { samplingIntervalUs: 1000, samplingIntervalBytes: 32768 }),
      ).rejects.toThrow(InvalidProfileError)
    }
    expect(await store.list()).toEqual([])
  })

  it('reports remaining seconds while running', async () => {
    await manager.startCpu({ durationSeconds: 5, samplingIntervalUs: 1000 })
    const status = manager.status()
    expect(status?.durationSeconds).toBe(5)
    expect(status?.remainingSeconds).toBeGreaterThan(3)
    expect(status?.remainingSeconds).toBeLessThanOrEqual(5)
    await manager.abort()
  })
})
