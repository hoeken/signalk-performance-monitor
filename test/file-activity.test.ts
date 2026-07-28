/**
 * Unit tests against a fake /proc/self layout (real symlinks and text
 * files in a temp dir) plus hand-built SQLite WAL-index headers, so every
 * sample is driven explicitly — no timers, no real database needed.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildFilesReport,
  FileActivityCapture,
  inferFilesCaptureMeta,
  isFilesRawCapture,
  listOpenFiles,
  parseProcIo,
  parseWalIndexHeader,
  readProcIo,
  type FilesRawCapture,
} from '../src/file-activity'
import { bucketForDataPath } from '../src/attribution'

const PROC_IO_TEXT = [
  'rchar: 120000',
  'wchar: 340000',
  'syscr: 100',
  'syscw: 200',
  'read_bytes: 4096',
  'write_bytes: 819200',
  'cancelled_write_bytes: 512',
  '',
].join('\n')

/** A valid WAL-index header: two identical 48-byte copies + lock area. */
function walIndexBuffer(fields: { iChange: number; mxFrame: number; pageSize?: number }): Buffer {
  const copy = Buffer.alloc(48)
  copy.writeUInt32LE(3007000, 0) // iVersion
  copy.writeUInt32LE(fields.iChange, 8)
  copy.writeUInt8(1, 12) // isInit
  const pageSize = fields.pageSize ?? 4096
  copy.writeUInt16LE(pageSize === 65536 ? 1 : pageSize, 14)
  copy.writeUInt32LE(fields.mxFrame, 16)
  copy.writeUInt32LE(64, 20) // nPage
  return Buffer.concat([copy, copy, Buffer.alloc(40)])
}

describe('parseProcIo', () => {
  it('parses the kernel counters', () => {
    expect(parseProcIo(PROC_IO_TEXT)).toEqual({
      rchar: 120000,
      wchar: 340000,
      readBytes: 4096,
      writeBytes: 819200,
      cancelledWriteBytes: 512,
    })
  })

  it('returns null when the storage counters are missing', () => {
    expect(parseProcIo('rchar: 5\nwchar: 6\n')).toBeNull()
    expect(parseProcIo('')).toBeNull()
  })

  it('reads and parses a proc io file, null when absent', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-io-'))
    try {
      await fs.writeFile(path.join(dir, 'io'), PROC_IO_TEXT)
      expect(readProcIo(dir)?.writeBytes).toBe(819200)
      expect(readProcIo(path.join(dir, 'nope'))).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('parseWalIndexHeader', () => {
  it('reads iChange, mxFrame, and the page size', () => {
    const header = parseWalIndexHeader(walIndexBuffer({ iChange: 42, mxFrame: 17 }))
    expect(header).toEqual({ iChange: 42, mxFrame: 17, pageSize: 4096, nPage: 64 })
  })

  it('decodes the 65536 page-size encoding', () => {
    const header = parseWalIndexHeader(walIndexBuffer({ iChange: 1, mxFrame: 1, pageSize: 65536 }))
    expect(header?.pageSize).toBe(65536)
  })

  it('rejects torn reads where the two header copies differ', () => {
    const buf = walIndexBuffer({ iChange: 42, mxFrame: 17 })
    buf.writeUInt32LE(43, 8) // bump iChange in the first copy only
    expect(parseWalIndexHeader(buf)).toBeNull()
  })

  it('rejects uninitialized and truncated headers', () => {
    const uninitialized = walIndexBuffer({ iChange: 0, mxFrame: 0 })
    uninitialized.writeUInt8(0, 12)
    uninitialized.writeUInt8(0, 60)
    expect(parseWalIndexHeader(uninitialized)).toBeNull()
    expect(parseWalIndexHeader(Buffer.alloc(48))).toBeNull()
    expect(parseWalIndexHeader(Buffer.alloc(0))).toBeNull()
  })
})

describe('bucketForDataPath', () => {
  const options = { dataRoot: '/home/pi/.signalk', serverRoot: '/opt/signalk-server' }

  it('attributes plugin-config-data files to their plugin', () => {
    expect(
      bucketForDataPath('/home/pi/.signalk/plugin-config-data/crowd-depth/depth.db', options),
    ).toBe('crowd-depth')
    expect(
      bucketForDataPath('/home/pi/.signalk/plugin-config-data/crowd-depth/depth.db-wal', options),
    ).toBe('crowd-depth')
  })

  it('attributes other data-root files to the server core', () => {
    expect(bucketForDataPath('/home/pi/.signalk/settings.json', options)).toBe(
      'signalk-server (core)',
    )
    expect(bucketForDataPath('/home/pi/.signalk/serverstate/course/courseInfo.json', options)).toBe(
      'signalk-server (core)',
    )
  })

  it('attributes node_modules paths to their package, even under the data root', () => {
    expect(
      bucketForDataPath('/home/pi/.signalk/node_modules/some-plugin/cache.json', options),
    ).toBe('some-plugin')
    expect(bucketForDataPath('/usr/lib/node_modules/@scope/pkg/data/file.log', options)).toBe(
      '@scope/pkg',
    )
  })

  it('attributes server-root files to the core and the rest to (other)', () => {
    expect(bucketForDataPath('/opt/signalk-server/settings/state.json', options)).toBe(
      'signalk-server (core)',
    )
    expect(bucketForDataPath('/var/log/syslog', options)).toBe('(other)')
    expect(bucketForDataPath('/var/log/syslog')).toBe('(other)')
  })

  it('attributes plugin storage folders under the data root by their folder name', () => {
    // The folder name is the plugin's own choice and often differs from its
    // package name (signalk-charts-provider-simple stores charts under
    // charts-simple/), so the folder name is the bucket.
    expect(
      bucketForDataPath('/home/pi/.signalk/charts-simple/Fiji/Fiji_Blighwater.mbtiles', options),
    ).toBe('charts-simple')
    expect(bucketForDataPath('/home/pi/.signalk/red/flows.json', options)).toBe('red')
    expect(bucketForDataPath('/home/pi/.signalk/@scope/tiles/cache/z1.db', options)).toBe(
      '@scope/tiles',
    )
  })

  it('keeps core folders, top-level files, and hidden dirs with the server core', () => {
    for (const corePath of [
      '/home/pi/.signalk/serverstate/course/courseInfo.json',
      '/home/pi/.signalk/serverState/course/courseInfo.json',
      '/home/pi/.signalk/applicationData/global/some-app/1.0.json',
      '/home/pi/.signalk/resources/routes/x.json',
      '/home/pi/.signalk/logs/skserver.log',
      '/home/pi/.signalk/.cache/something',
      '/home/pi/.signalk/security.json',
      '/home/pi/.signalk/charts-simple', // a top-level *file*, not a storage folder
    ]) {
      expect(bucketForDataPath(corePath, options)).toBe('signalk-server (core)')
    }
  })
})

describe('listOpenFiles', () => {
  let dir: string
  let procSelf: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-fd-'))
    procSelf = path.join(dir, 'proc-self')
    await fs.mkdir(path.join(procSelf, 'fd'), { recursive: true })
    await fs.mkdir(path.join(procSelf, 'fdinfo'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function addFd(fd: number, target: string, flagsOctal: string): Promise<void> {
    await fs.symlink(target, path.join(procSelf, 'fd', String(fd)))
    await fs.writeFile(
      path.join(procSelf, 'fdinfo', String(fd)),
      `pos:\t0\nflags:\t${flagsOctal}\nmnt_id:\t29\n`,
    )
  }

  it('lists regular files with access flags, skipping sockets and pipes', async () => {
    const fileA = path.join(dir, 'a.log')
    const fileB = path.join(dir, 'b.db')
    await fs.writeFile(fileA, 'aaa')
    await fs.writeFile(fileB, 'bbb')
    await addFd(3, fileA, '0102101') // O_WRONLY | O_CREAT | O_APPEND | O_LARGEFILE
    await addFd(4, fileB, '0100002') // O_RDWR
    await addFd(5, 'socket:[12345]', '02')
    await addFd(6, 'anon_inode:[eventpoll]', '02')
    await fs.symlink(path.join(dir, 'gone'), path.join(procSelf, 'fd', '7')) // dangling

    const open = await listOpenFiles(procSelf)
    expect(open.map((entry) => entry.path).sort()).toEqual([fileA, fileB])
    const byPath = new Map(open.map((entry) => [entry.path, entry]))
    expect(byPath.get(fileA)).toMatchObject({ writable: true, readable: false, append: true })
    expect(byPath.get(fileB)).toMatchObject({ writable: true, readable: true, append: false })
  })

  it('returns empty when the fd dir does not exist', async () => {
    expect(await listOpenFiles(path.join(dir, 'missing'))).toEqual([])
  })
})

describe('FileActivityCapture', () => {
  let dir: string
  let procSelf: string
  let dataRoot: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(tmpdir(), 'skpm-cap-'))
    procSelf = path.join(dir, 'proc-self')
    dataRoot = path.join(dir, '.signalk')
    await fs.mkdir(path.join(procSelf, 'fd'), { recursive: true })
    await fs.mkdir(path.join(procSelf, 'fdinfo'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function setProcIo(writeBytes: number): Promise<void> {
    await fs.writeFile(
      path.join(procSelf, 'io'),
      `rchar: 0\nwchar: 0\nread_bytes: 0\nwrite_bytes: ${writeBytes}\ncancelled_write_bytes: 0\n`,
    )
  }

  async function openFd(fd: number, target: string, flagsOctal = '0100002'): Promise<void> {
    await fs.symlink(target, path.join(procSelf, 'fd', String(fd)))
    await fs.writeFile(path.join(procSelf, 'fdinfo', String(fd)), `flags:\t${flagsOctal}\n`)
  }

  it('is unsupported without a proc layout', () => {
    expect(FileActivityCapture.isSupported(path.join(dir, 'nope'))).toBe(false)
  })

  it('tracks growth, churn, SQLite counters, and the unattributed remainder', async () => {
    const pluginDir = path.join(dataRoot, 'plugin-config-data', 'crowd-depth')
    await fs.mkdir(pluginDir, { recursive: true })
    const db = path.join(pluginDir, 'depth.db')
    const wal = `${db}-wal`
    const shm = `${db}-shm`
    const log = path.join(dataRoot, 'server.log')
    await fs.writeFile(db, Buffer.alloc(4096))
    await fs.writeFile(wal, Buffer.alloc(1000))
    await fs.writeFile(shm, walIndexBuffer({ iChange: 100, mxFrame: 10 }))
    await fs.writeFile(log, 'start\n')
    await setProcIo(0)
    await openFd(3, db)
    await openFd(4, log, '0102101') // append log writer

    expect(FileActivityCapture.isSupported(procSelf)).toBe(true)
    const capture = new FileActivityCapture({
      procSelfDir: procSelf,
      bucketOptions: { dataRoot },
    })
    await capture.sample() // baseline

    // Interval 1: 5 commits / 6 WAL frames, the log grows, WAL rewrites in place.
    await setProcIo(100_000)
    await fs.writeFile(shm, walIndexBuffer({ iChange: 105, mxFrame: 16 }))
    await fs.appendFile(log, 'x'.repeat(500))
    const walPast = await fs.open(wal, 'r+')
    await walPast.write(Buffer.from('y'), 0, 1, 10)
    await walPast.close()
    await capture.sample()

    // Interval 2: a checkpoint resets mxFrame (16 frames flushed), then 2 more frames.
    await setProcIo(300_000)
    await fs.writeFile(shm, walIndexBuffer({ iChange: 107, mxFrame: 2 }))
    await capture.sample()

    const report = capture.buildReport({
      id: 'files-2026-07-29T00-00-00-000Z',
      capturedAt: '2026-07-29T00:00:00.000Z',
      durationMs: 2000,
      sampleIntervalSeconds: 1,
    })

    expect(report.type).toBe('files')
    expect(report.sampleCount).toBe(3)
    expect(report.totals.writeBytes).toBe(300_000)
    expect(report.totals.writeBytesPerSecond).toBe(150_000)

    // The open db fd pulled its -wal/-shm siblings into the watch set.
    const paths = report.files.map((file) => file.path)
    expect(paths).toEqual(expect.arrayContaining([db, wal, shm, log]))

    const logFile = report.files.find((file) => file.path === log)
    expect(logFile).toMatchObject({
      bucket: 'signalk-server (core)',
      mode: 'append',
      kind: 'file',
      growthBytes: 500,
    })
    expect(logFile!.mtimeChanges).toBeGreaterThanOrEqual(1)

    const walFile = report.files.find((file) => file.path === wal)
    expect(walFile).toMatchObject({ kind: 'sqlite-wal', growthBytes: 0 })
    expect(walFile!.inPlaceRewrites).toBeGreaterThanOrEqual(1)

    expect(report.databases).toHaveLength(1)
    const activity = report.databases[0]
    expect(activity).toMatchObject({
      path: db,
      bucket: 'crowd-depth',
      pageSize: 4096,
      commits: 7,
      framesWritten: 8,
      checkpoints: 1,
    })
    // 8 frames × (4096+24) + 16 checkpointed frames × 4096
    expect(activity.estimatedWriteBytes).toBe(8 * 4120 + 16 * 4096)
    expect(activity.commitsPerSecond).toBe(3.5)
    expect(activity.notes[0]).toMatch(/consider batching/)

    // Attribution: db estimate + log growth + honesty-check remainder = total.
    const byName = new Map(report.attribution.map((row) => [row.name, row]))
    expect(byName.get('crowd-depth')?.estimatedWriteBytes).toBe(activity.estimatedWriteBytes)
    expect(byName.get('signalk-server (core)')?.estimatedWriteBytes).toBe(500)
    expect(byName.get('(unattributed)')?.estimatedWriteBytes).toBe(
      300_000 - activity.estimatedWriteBytes - 500,
    )

    const raw = capture.rawCapture()
    expect(raw.samples).toHaveLength(3)
    expect(raw.samples[2].io?.writeBytes).toBe(300_000)
    expect(raw.samples[2].walIndexes[db]).toMatchObject({ iChange: 107, mxFrame: 2 })
    expect(raw.modes?.[log]).toBe('append')

    // Replaying the serialized raw capture (what download → upload does)
    // rebuilds the identical report.
    const replayed = JSON.parse(JSON.stringify(raw)) as FilesRawCapture
    expect(isFilesRawCapture(replayed)).toBe(true)
    expect(
      buildFilesReport(
        replayed,
        {
          id: 'files-2026-07-29T00-00-00-000Z',
          capturedAt: '2026-07-29T00:00:00.000Z',
          durationMs: 2000,
          sampleIntervalSeconds: 1,
        },
        { dataRoot },
      ),
    ).toEqual(report)
  })

  it('keeps previous counters over a torn shm read', async () => {
    const dbDir = path.join(dataRoot, 'plugin-config-data', 'p')
    await fs.mkdir(dbDir, { recursive: true })
    const db = path.join(dbDir, 'x.db')
    await fs.writeFile(db, Buffer.alloc(512))
    await fs.writeFile(`${db}-shm`, walIndexBuffer({ iChange: 1, mxFrame: 1 }))
    await setProcIo(0)
    await openFd(3, db)

    const capture = new FileActivityCapture({ procSelfDir: procSelf, bucketOptions: { dataRoot } })
    await capture.sample()

    const torn = walIndexBuffer({ iChange: 9, mxFrame: 9 })
    torn.writeUInt32LE(8, 8) // first copy disagrees with the second
    await fs.writeFile(`${db}-shm`, torn)
    await capture.sample()

    await fs.writeFile(`${db}-shm`, walIndexBuffer({ iChange: 3, mxFrame: 3 }))
    await capture.sample()

    const report = capture.buildReport({
      id: 'files-2026-07-29T00-00-00-000Z',
      capturedAt: '2026-07-29T00:00:00.000Z',
      durationMs: 2000,
      sampleIntervalSeconds: 1,
    })
    expect(report.databases[0]).toMatchObject({ commits: 2, framesWritten: 2, checkpoints: 0 })
  })
})

describe('raw capture shape and metadata inference', () => {
  const sample = (offsetMs: number) => ({ offsetMs, io: null, files: {}, walIndexes: {} })

  it('recognizes saved captures and rejects other JSON', () => {
    expect(isFilesRawCapture({ samples: [sample(0), sample(1000)] })).toBe(true)
    expect(isFilesRawCapture({ samples: [] })).toBe(false)
    expect(isFilesRawCapture({ samples: ['x'] })).toBe(false)
    expect(isFilesRawCapture({ samples: [{ offsetMs: 'zero' }] })).toBe(false)
    expect(isFilesRawCapture({ nodes: [] })).toBe(false)
    expect(isFilesRawCapture(null)).toBe(false)
    expect(isFilesRawCapture('samples')).toBe(false)
  })

  it('infers duration and sample interval from the offsets', () => {
    expect(inferFilesCaptureMeta({ samples: [sample(0), sample(1000), sample(2100)] })).toEqual({
      durationMs: 2100,
      sampleIntervalSeconds: 1.1,
    })
    // A single sample can infer no interval; fall back to the 1s default.
    expect(inferFilesCaptureMeta({ samples: [sample(0)] })).toEqual({
      durationMs: 0,
      sampleIntervalSeconds: 1,
    })
  })
})
