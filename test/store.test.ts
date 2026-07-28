import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  capturedAtFromProfileId,
  embeddedProfileMetaOf,
  isValidProfileId,
  makeProfileId,
  ProfileStore,
} from '../src/store'
import type { CpuReport, FilesReport, HeapReport } from '../src/shared/types'

function makeReport(id: string, capturedAt: string): CpuReport {
  return {
    id,
    type: 'cpu',
    capturedAt,
    durationMs: 1000,
    samplingIntervalUs: 1000,
    totalTimeMs: 1000,
    buckets: [{ name: '(idle)', selfTimeMs: 1000, percent: 100 }],
  }
}

describe('profile ids', () => {
  it('generates filesystem-safe ids that validate', () => {
    const id = makeProfileId('cpu', new Date('2026-07-28T10:15:30.123Z'))
    expect(id).toBe('cpu-2026-07-28T10-15-30-123Z')
    expect(isValidProfileId(id)).toBe(true)
    expect(isValidProfileId(makeProfileId('heap', new Date()))).toBe(true)
    expect(isValidProfileId(makeProfileId('files', new Date()))).toBe(true)
  })

  it('rejects traversal and junk ids', () => {
    expect(isValidProfileId('../../etc/passwd')).toBe(false)
    expect(isValidProfileId('cpu-..')).toBe(false)
    expect(isValidProfileId('cpu-a/b')).toBe(false)
    expect(isValidProfileId('gpu-2026')).toBe(false)
    expect(isValidProfileId('')).toBe(false)
  })

  it('recovers the capture timestamp embedded in an id', () => {
    const date = new Date('2026-07-28T10:15:30.123Z')
    expect(capturedAtFromProfileId(makeProfileId('cpu', date))).toBe(date.toISOString())
    expect(capturedAtFromProfileId(makeProfileId('heap', date))).toBe(date.toISOString())
    expect(capturedAtFromProfileId(makeProfileId('files', date))).toBe(date.toISOString())
    expect(capturedAtFromProfileId('cpu-fake')).toBeNull()
    expect(capturedAtFromProfileId('cpu-2026-99-99T10-15-30-123Z')).toBeNull()
  })
})

describe('ProfileStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-store-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('saves the raw profile with embedded capture metadata beside the report', async () => {
    const store = new ProfileStore(path.join(dir, 'nested'), 5)
    await store.save(makeReport('cpu-a1', '2026-07-28T10:00:00.000Z'), { nodes: [] })

    const report = await store.getReport('cpu-a1')
    expect(report?.id).toBe('cpu-a1')
    const raw = await store.getRaw('cpu-a1')
    expect(JSON.parse(raw!.toString())).toEqual({
      nodes: [],
      'signalk-performance-monitor': {
        id: 'cpu-a1',
        type: 'cpu',
        capturedAt: '2026-07-28T10:00:00.000Z',
        durationMs: 1000,
        samplingIntervalUs: 1000,
      },
    })
  })

  it('validates embedded metadata field by field', () => {
    expect(embeddedProfileMetaOf({ nodes: [] })).toEqual({})
    expect(embeddedProfileMetaOf(null)).toEqual({})
    expect(embeddedProfileMetaOf({ 'signalk-performance-monitor': 'junk' })).toEqual({})
    expect(
      embeddedProfileMetaOf({
        'signalk-performance-monitor': {
          id: '../evil',
          capturedAt: 'not a date',
          durationMs: -5,
          samplingIntervalUs: 250,
        },
      }),
    ).toEqual({ samplingIntervalUs: 250 })
  })

  it('lists profiles most recent first with raw sizes', async () => {
    const store = new ProfileStore(dir, 5)
    await store.save(makeReport('cpu-a1', '2026-07-28T10:00:00.000Z'), { a: 1 })
    await store.save(makeReport('cpu-a2', '2026-07-28T11:00:00.000Z'), { a: 22 })

    const entries = await store.list()
    expect(entries.map((entry) => entry.id)).toEqual(['cpu-a2', 'cpu-a1'])
    expect(entries[0].rawSizeBytes).toBeGreaterThan(0)
    expect(entries[0].type).toBe('cpu')
    expect(entries[0].durationMs).toBe(1000)
  })

  it('rotates out the oldest profiles beyond maxStored, per type', async () => {
    const store = new ProfileStore(dir, 2)
    await store.save(makeReport('cpu-a1', '2026-07-28T10:00:00.000Z'), {})
    await store.save(makeReport('cpu-a2', '2026-07-28T11:00:00.000Z'), {})
    const heapReport: HeapReport = {
      id: 'heap-b1',
      type: 'heap',
      capturedAt: '2026-07-28T09:00:00.000Z',
      durationMs: 1000,
      samplingIntervalBytes: 32768,
      totalBytes: 1024,
      buckets: [{ name: 'plugin-x', selfBytes: 1024, percent: 100 }],
    }
    await store.save(heapReport, {})
    await store.save(makeReport('cpu-a3', '2026-07-28T12:00:00.000Z'), {})

    const entries = await store.list()
    expect(entries.map((entry) => entry.id).sort()).toEqual(['cpu-a2', 'cpu-a3', 'heap-b1'])
    expect(await store.getReport('cpu-a1')).toBeNull()
    expect(await store.getRaw('cpu-a1')).toBeNull()
  })

  it('stores file activity reports under their own extension and type', async () => {
    const store = new ProfileStore(dir, 5)
    const filesReport: FilesReport = {
      id: 'files-c1',
      type: 'files',
      capturedAt: '2026-07-28T08:00:00.000Z',
      durationMs: 30000,
      sampleIntervalSeconds: 1,
      sampleCount: 31,
      totals: { writeBytes: 1000, readBytes: 0, writeBytesPerSecond: 33.3, readBytesPerSecond: 0 },
      files: [],
      databases: [],
      attribution: [{ name: '(unattributed)', estimatedWriteBytes: 1000, percent: 100 }],
    }
    await store.save(filesReport, { samples: [] })

    const entries = await store.list()
    expect(entries[0]).toMatchObject({ id: 'files-c1', type: 'files' })
    const files = await fs.readdir(dir)
    expect(files).toContain('files-c1.filesprofile')
    const raw = JSON.parse((await store.getRaw('files-c1'))!.toString()) as Record<string, unknown>
    expect(raw['signalk-performance-monitor']).toMatchObject({
      id: 'files-c1',
      type: 'files',
      sampleIntervalSeconds: 1,
    })
  })

  it('deletes both files and reports missing ids', async () => {
    const store = new ProfileStore(dir, 5)
    await store.save(makeReport('cpu-a1', '2026-07-28T10:00:00.000Z'), {})

    expect(await store.delete('cpu-a1')).toBe(true)
    expect(await store.list()).toEqual([])
    expect(await store.delete('cpu-a1')).toBe(false)
  })

  it('refuses invalid ids on every accessor', async () => {
    const store = new ProfileStore(dir, 5)
    expect(await store.getReport('../evil')).toBeNull()
    expect(await store.getRaw('../evil')).toBeNull()
    expect(await store.delete('../evil')).toBe(false)
    await expect(store.save(makeReport('../evil', '2026-07-28T10:00:00.000Z'), {})).rejects.toThrow(
      /invalid profile id/,
    )
  })

  it('skips unreadable entries instead of failing the whole list', async () => {
    const store = new ProfileStore(dir, 5)
    await store.save(makeReport('cpu-a1', '2026-07-28T10:00:00.000Z'), {})
    await fs.writeFile(path.join(dir, 'cpu-broken.report.json'), 'not json')

    const entries = await store.list()
    expect(entries.map((entry) => entry.id)).toEqual(['cpu-a1'])
  })
})
