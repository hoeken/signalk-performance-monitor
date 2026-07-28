/**
 * On-demand file activity capture from the Linux proc filesystem — no
 * strace, no ptrace, no library hooks:
 *
 *  - `/proc/self/io` — kernel-counted bytes the process caused to hit
 *    storage; the anchor every per-file estimate is checked against (and the
 *    source of the always-on disk byte rates in `MetricsCollector`).
 *  - `/proc/self/fd` + `/proc/self/fdinfo` — every open regular file with
 *    its open flags: you can't write to a file without a descriptor.
 *  - per-file `stat` deltas — size growth catches append writers; mtime
 *    advancing without growth is the signature of in-place churn (a wrapped
 *    SQLite WAL).
 *  - SQLite WAL-index (`-shm`) headers — plain-readable without locks or an
 *    SQLite library: a transaction counter and the WAL frame count, diffed
 *    per sample into commits/s, frames/s, and checkpoints.
 *
 * All sources are passive reads; the capture never opens, locks, or writes
 * the files it watches.
 */
import { existsSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { bucketForDataPath, type DataPathBucketOptions } from './attribution'
import type {
  FileActivityFile,
  FilesAttributionRow,
  FilesReport,
  SqliteActivity,
} from './shared/types'

export const PROC_SELF = '/proc/self'
export const UNATTRIBUTED_BUCKET = '(unattributed)'

/** WAL frame = 24-byte header + one page. */
const WAL_FRAME_HEADER_BYTES = 24
/** Sustained commit rate above this gets a "consider batching" note. */
const HIGH_COMMIT_RATE_PER_SECOND = 1

// --- /proc/self/io -----------------------------------------------------

export interface ProcIoCounters {
  /** bytes passed to read syscalls (includes sockets and page cache) */
  rchar: number
  /** bytes passed to write syscalls (includes sockets and page cache) */
  wchar: number
  /** bytes actually fetched from the storage layer */
  readBytes: number
  /** bytes the process caused to be written to the storage layer */
  writeBytes: number
  /** write bytes credited back by truncation before they hit storage */
  cancelledWriteBytes: number
}

const PROC_IO_FIELDS: Record<string, keyof ProcIoCounters> = {
  rchar: 'rchar',
  wchar: 'wchar',
  read_bytes: 'readBytes',
  write_bytes: 'writeBytes',
  cancelled_write_bytes: 'cancelledWriteBytes',
}

export function parseProcIo(text: string): ProcIoCounters | null {
  const counters: Partial<ProcIoCounters> = {}
  for (const line of text.split('\n')) {
    const match = /^(\w+):\s*(\d+)/.exec(line)
    if (!match?.[1] || !match[2]) continue
    const field = PROC_IO_FIELDS[match[1]]
    if (field) counters[field] = Number(match[2])
  }
  if (counters.readBytes === undefined || counters.writeBytes === undefined) return null
  return {
    rchar: counters.rchar ?? 0,
    wchar: counters.wchar ?? 0,
    readBytes: counters.readBytes,
    writeBytes: counters.writeBytes,
    cancelledWriteBytes: counters.cancelledWriteBytes ?? 0,
  }
}

/**
 * Current process I/O counters, or null where /proc is unavailable
 * (non-Linux). Synchronous by design: procfs reads are served from kernel
 * memory, and the metrics sampler that shares this is a sync API.
 */
export function readProcIo(procSelfDir: string = PROC_SELF): ProcIoCounters | null {
  try {
    return parseProcIo(readFileSync(path.join(procSelfDir, 'io'), 'utf8'))
  } catch {
    return null
  }
}

// --- /proc/self/fd inventory -------------------------------------------

export interface OpenFileInfo {
  fd: number
  path: string
  readable: boolean
  writable: boolean
  append: boolean
}

const O_ACCMODE = 0o3
const O_WRONLY = 0o1
const O_RDWR = 0o2
const O_APPEND = 0o2000

/**
 * Every open regular file of the process, with open flags from fdinfo.
 * Sockets, pipes, anon inodes, devices, and deleted files are skipped.
 */
export async function listOpenFiles(procSelfDir: string = PROC_SELF): Promise<OpenFileInfo[]> {
  const fdDir = path.join(procSelfDir, 'fd')
  let names: string[]
  try {
    names = await fs.readdir(fdDir)
  } catch {
    return []
  }
  const out: OpenFileInfo[] = []
  for (const name of names) {
    const fd = Number(name)
    if (!Number.isInteger(fd)) continue
    let target: string
    try {
      target = await fs.readlink(path.join(fdDir, name))
    } catch {
      continue // closed between readdir and readlink
    }
    if (!target.startsWith('/') || target.endsWith(' (deleted)')) continue
    try {
      if (!(await fs.stat(target)).isFile()) continue
    } catch {
      continue
    }
    const info: OpenFileInfo = { fd, path: target, readable: true, writable: false, append: false }
    try {
      const fdinfo = await fs.readFile(path.join(procSelfDir, 'fdinfo', name), 'utf8')
      const match = /^flags:\s*([0-7]+)/m.exec(fdinfo)
      if (match?.[1]) {
        const flags = parseInt(match[1], 8)
        const access = flags & O_ACCMODE
        info.readable = access !== O_WRONLY
        info.writable = access === O_WRONLY || access === O_RDWR
        info.append = (flags & O_APPEND) !== 0
      }
    } catch {
      // fdinfo unreadable; keep the read-only default
    }
    out.push(info)
  }
  return out
}

// --- SQLite WAL-index header -------------------------------------------

export interface WalIndexHeader {
  /** incremented once per committed transaction */
  iChange: number
  /** WAL frames written since the last checkpoint */
  mxFrame: number
  /** database page size in bytes */
  pageSize: number
  /** database size in pages */
  nPage: number
}

/**
 * Parse the first copy of the WAL-index header from a `-shm` file. The
 * header exists in two copies (bytes 0–47 and 48–95) that SQLite writes
 * around a memory barrier; a mismatch means we read mid-update, so return
 * null and let the caller keep its previous sample.
 */
export function parseWalIndexHeader(buf: Buffer): WalIndexHeader | null {
  if (buf.length < 96) return null
  if (!buf.subarray(0, 48).equals(buf.subarray(48, 96))) return null // torn read
  if (buf.readUInt8(12) !== 1) return null // isInit not set yet
  // szPage is a u16 encoding page sizes 512..65536: (raw&0xfe00) | ((raw&1)<<16)
  const rawPage = buf.readUInt16LE(14)
  const pageSize = (rawPage & 0xfe00) + ((rawPage & 0x0001) << 16)
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return null
  return {
    iChange: buf.readUInt32LE(8),
    mxFrame: buf.readUInt32LE(16),
    pageSize,
    nPage: buf.readUInt32LE(20),
  }
}

// --- capture ------------------------------------------------------------

type FileKind = FileActivityFile['kind']

interface WatchedFile {
  path: string
  /** seen among the process's open fds (vs discovered as a SQLite sibling) */
  seenOpen: boolean
  readable: boolean
  writable: boolean
  append: boolean
}

interface FileSampleRecord {
  size: number | null
  mtimeMs: number | null
}

/** One raw sample, stored verbatim in the downloadable capture file. */
export interface FileActivitySample {
  /** milliseconds since capture start */
  offsetMs: number
  io: ProcIoCounters | null
  files: Record<string, FileSampleRecord>
  walIndexes: Record<string, WalIndexHeader>
}

/**
 * The downloadable raw capture: the full sample series plus the merged
 * open mode observed per path (which only exists while the fds are live).
 * Everything in the report is reconstructible from this, which is what
 * makes download → upload lossless.
 */
export interface FilesRawCapture {
  samples: FileActivitySample[]
  modes?: Record<string, string>
}

/** Shape check for uploads: a raw file activity capture we saved. */
export function isFilesRawCapture(raw: unknown): raw is FilesRawCapture {
  const capture = raw as Partial<FilesRawCapture> | null
  if (typeof capture !== 'object' || capture === null) return false
  if (!Array.isArray(capture.samples) || capture.samples.length === 0) return false
  return capture.samples.every(
    (sample) =>
      typeof sample === 'object' &&
      sample !== null &&
      typeof (sample as FileActivitySample).offsetMs === 'number' &&
      typeof (sample as FileActivitySample).files === 'object' &&
      (sample as FileActivitySample).files !== null &&
      typeof (sample as FileActivitySample).walIndexes === 'object' &&
      (sample as FileActivitySample).walIndexes !== null,
  )
}

export interface FileActivityCaptureOptions {
  procSelfDir?: string
  bucketOptions?: DataPathBucketOptions
}

export interface FilesReportMeta {
  id: string
  capturedAt: string
  durationMs: number
  sampleIntervalSeconds: number
}

/**
 * Capture metadata recovered from the samples themselves, for imports of
 * files that lost their embedded metadata.
 */
export function inferFilesCaptureMeta(raw: FilesRawCapture): {
  durationMs: number
  sampleIntervalSeconds: number
} {
  const offsets = raw.samples.map((sample) => sample.offsetMs)
  const gaps = offsets
    .slice(1)
    .map((offset, i) => offset - (offsets[i] ?? 0))
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b)
  const median = gaps[Math.floor(gaps.length / 2)]
  return {
    durationMs: Math.max(offsets[offsets.length - 1] ?? 0, 0),
    sampleIntervalSeconds: median ? Math.round(median) / 1000 : 1,
  }
}

const uint32Delta = (current: number, previous: number) => (current - previous) >>> 0

function sqliteKindOf(filePath: string): { kind: FileKind; dbPath: string } {
  if (filePath.endsWith('-wal')) return { kind: 'sqlite-wal', dbPath: filePath.slice(0, -4) }
  if (filePath.endsWith('-shm')) return { kind: 'sqlite-shm', dbPath: filePath.slice(0, -4) }
  return { kind: 'file', dbPath: filePath }
}

interface FileAggregate {
  lastSize: number | null
  lastMtimeMs: number | null
  growthBytes: number
  mtimeChanges: number
  inPlaceRewrites: number
}

interface DbAggregate {
  pageSize: number
  commits: number
  framesWritten: number
  checkpoints: number
  checkpointedFrames: number
  last: WalIndexHeader | null
}

/**
 * Build the aggregated report by replaying the raw sample series — the one
 * code path shared by live captures and re-uploaded downloads, so both
 * produce identical reports.
 */
export function buildFilesReport(
  raw: FilesRawCapture,
  meta: FilesReportMeta,
  bucketOptions: DataPathBucketOptions = {},
): FilesReport {
  const modes = raw.modes ?? {}
  const durationSeconds = Math.max(meta.durationMs / 1000, 1e-3)
  const perSecond = (value: number) => Math.round((value / durationSeconds) * 10) / 10

  let firstIo: ProcIoCounters | null = null
  let lastIo: ProcIoCounters | null = null
  const fileAggs = new Map<string, FileAggregate>()
  const dbAggs = new Map<string, DbAggregate>()

  for (const sample of raw.samples) {
    if (sample.io) {
      firstIo ??= sample.io
      lastIo = sample.io
    }

    for (const [filePath, record] of Object.entries(sample.files)) {
      let agg = fileAggs.get(filePath)
      if (!agg) {
        agg = {
          lastSize: null,
          lastMtimeMs: null,
          growthBytes: 0,
          mtimeChanges: 0,
          inPlaceRewrites: 0,
        }
        fileAggs.set(filePath, agg)
      }
      const { size, mtimeMs } = record
      if (size !== null && agg.lastSize !== null) {
        agg.growthBytes += Math.max(size - agg.lastSize, 0)
      }
      if (mtimeMs !== null && agg.lastMtimeMs !== null && mtimeMs > agg.lastMtimeMs) {
        agg.mtimeChanges += 1
        if (size !== null && size === agg.lastSize) agg.inPlaceRewrites += 1
      }
      if (size !== null) agg.lastSize = size
      if (mtimeMs !== null) agg.lastMtimeMs = mtimeMs
    }

    for (const [dbPath, header] of Object.entries(sample.walIndexes)) {
      let db = dbAggs.get(dbPath)
      if (!db) {
        db = {
          pageSize: 0,
          commits: 0,
          framesWritten: 0,
          checkpoints: 0,
          checkpointedFrames: 0,
          last: null,
        }
        dbAggs.set(dbPath, db)
      }
      if (db.last) {
        db.commits += uint32Delta(header.iChange, db.last.iChange)
        if (header.mxFrame >= db.last.mxFrame) {
          db.framesWritten += header.mxFrame - db.last.mxFrame
        } else {
          // The frame counter reset: a checkpoint copied the WAL into the
          // main database and the WAL restarted from the beginning.
          db.checkpoints += 1
          db.checkpointedFrames += db.last.mxFrame
          db.framesWritten += header.mxFrame
        }
      }
      db.pageSize = header.pageSize
      db.last = header
    }
  }

  // A database registers when its -shm sibling was watched, even if the
  // header never parsed (matching the live capture's zero-count rows).
  const dbPaths = new Set<string>(dbAggs.keys())
  for (const filePath of fileAggs.keys()) {
    if (filePath.endsWith('-shm')) dbPaths.add(filePath.slice(0, -4))
  }
  const kindOf = (filePath: string): FileKind => {
    const { kind } = sqliteKindOf(filePath)
    if (kind !== 'file') return kind
    return dbPaths.has(filePath) ? 'sqlite-db' : 'file'
  }

  const writeBytes = firstIo && lastIo ? Math.max(lastIo.writeBytes - firstIo.writeBytes, 0) : 0
  const readBytes = firstIo && lastIo ? Math.max(lastIo.readBytes - firstIo.readBytes, 0) : 0

  const files: FileActivityFile[] = [...fileAggs.entries()]
    .map(([filePath, agg]) => ({
      path: filePath,
      bucket: bucketForDataPath(filePath, bucketOptions),
      mode: modes[filePath] ?? 'watched',
      kind: kindOf(filePath),
      sizeBytes: agg.lastSize ?? 0,
      growthBytes: agg.growthBytes,
      mtimeChanges: agg.mtimeChanges,
      inPlaceRewrites: agg.inPlaceRewrites,
    }))
    .sort((a, b) => b.growthBytes - a.growthBytes || a.path.localeCompare(b.path))

  const databases: SqliteActivity[] = [...dbPaths]
    .map((dbPath) => {
      const db = dbAggs.get(dbPath) ?? {
        pageSize: 0,
        commits: 0,
        framesWritten: 0,
        checkpoints: 0,
        checkpointedFrames: 0,
        last: null,
      }
      const commitsPerSecond = Math.round((db.commits / durationSeconds) * 100) / 100
      const estimatedWriteBytes =
        db.framesWritten * (db.pageSize + WAL_FRAME_HEADER_BYTES) +
        db.checkpointedFrames * db.pageSize
      const notes: string[] = []
      if (commitsPerSecond >= HIGH_COMMIT_RATE_PER_SECOND) {
        notes.push(
          `${commitsPerSecond}/s sustained commits — each one costs an fsync; consider batching writes`,
        )
      }
      return {
        path: dbPath,
        bucket: bucketForDataPath(dbPath, bucketOptions),
        pageSize: db.pageSize,
        commits: db.commits,
        commitsPerSecond,
        framesWritten: db.framesWritten,
        checkpoints: db.checkpoints,
        estimatedWriteBytes,
        notes,
      }
    })
    .sort((a, b) => b.estimatedWriteBytes - a.estimatedWriteBytes)

  // Attribute estimated writes per bucket: WAL math covers the SQLite
  // family (db + wal + shm), size growth covers plain files. Whatever the
  // process-wide counter saw beyond that is reported, not hidden.
  const byBucket = new Map<string, number>()
  const add = (bucket: string, bytes: number) => {
    if (bytes > 0) byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + bytes)
  }
  for (const db of databases) add(db.bucket, db.estimatedWriteBytes)
  for (const file of files) {
    if (file.kind === 'file') add(file.bucket, file.growthBytes)
  }
  const attributed = [...byBucket.values()].reduce((sum, bytes) => sum + bytes, 0)
  const percentOf = (bytes: number) =>
    writeBytes > 0 ? Math.round((10000 * bytes) / writeBytes) / 100 : 0
  const attribution: FilesAttributionRow[] = [...byBucket.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, bytes]) => ({
      name,
      estimatedWriteBytes: bytes,
      percent: percentOf(bytes),
    }))
  const unattributed = Math.max(writeBytes - attributed, 0)
  if (unattributed > 0 || attribution.length === 0) {
    attribution.push({
      name: UNATTRIBUTED_BUCKET,
      estimatedWriteBytes: unattributed,
      percent: percentOf(unattributed),
    })
  }

  return {
    id: meta.id,
    type: 'files',
    capturedAt: meta.capturedAt,
    durationMs: meta.durationMs,
    sampleIntervalSeconds: meta.sampleIntervalSeconds,
    sampleCount: raw.samples.length,
    ...(bucketOptions.dataRoot ? { dataRoot: bucketOptions.dataRoot } : {}),
    totals: {
      writeBytes,
      readBytes,
      writeBytesPerSecond: perSecond(writeBytes),
      readBytesPerSecond: perSecond(readBytes),
    },
    files,
    databases,
    attribution,
  }
}

/**
 * Collects one sample per call (drive it on a timer); the first call is the
 * baseline. The class only gathers raw samples — `buildReport` replays them
 * through `buildFilesReport`, the same path an uploaded download takes.
 */
export class FileActivityCapture {
  private readonly procSelfDir: string
  private readonly bucketOptions: DataPathBucketOptions
  private readonly files = new Map<string, WatchedFile>()
  /** main database path → its -shm sibling */
  private readonly dbs = new Map<string, string>()
  private readonly samples: FileActivitySample[] = []
  private startedAtMs: number | null = null

  constructor(options: FileActivityCaptureOptions = {}) {
    this.procSelfDir = options.procSelfDir ?? PROC_SELF
    this.bucketOptions = options.bucketOptions ?? {}
  }

  static isSupported(procSelfDir: string = PROC_SELF): boolean {
    return existsSync(path.join(procSelfDir, 'io')) && existsSync(path.join(procSelfDir, 'fd'))
  }

  async sample(): Promise<void> {
    const now = Date.now()
    if (this.startedAtMs === null) this.startedAtMs = now
    const record: FileActivitySample = {
      offsetMs: now - this.startedAtMs,
      io: readProcIo(this.procSelfDir),
      files: {},
      walIndexes: {},
    }

    // Refresh the fd inventory every sample: files opened mid-capture join
    // the watch set, and repeated sightings merge access flags.
    for (const open of await listOpenFiles(this.procSelfDir)) {
      const watched = this.watch(open.path, true)
      watched.seenOpen = true
      watched.readable ||= open.readable
      watched.writable ||= open.writable
      watched.append ||= open.append
    }

    for (const watched of this.files.values()) {
      let size: number | null = null
      let mtimeMs: number | null = null
      try {
        const st = await fs.stat(watched.path)
        size = st.size
        mtimeMs = st.mtimeMs
      } catch {
        // deleted or replaced; counters just stop advancing
      }
      record.files[watched.path] = { size, mtimeMs }
    }

    for (const [dbPath, shmPath] of this.dbs) {
      try {
        const header = parseWalIndexHeader(await fs.readFile(shmPath))
        // A torn read is skipped; the replay keeps the previous counters.
        if (header) record.walIndexes[dbPath] = header
      } catch {
        // shm gone (db closed); counters just stop advancing
      }
    }

    this.samples.push(record)
  }

  /** Register a path for watching; discovers SQLite siblings on first sight. */
  private watch(filePath: string, discoverSiblings: boolean): WatchedFile {
    const existing = this.files.get(filePath)
    if (existing) return existing

    const { kind, dbPath } = sqliteKindOf(filePath)
    const isDb = kind === 'file' && existsSync(`${filePath}-shm`)

    const watched: WatchedFile = {
      path: filePath,
      seenOpen: false,
      readable: false,
      writable: false,
      append: false,
    }
    this.files.set(filePath, watched)

    if ((kind !== 'file' || isDb) && discoverSiblings) {
      const base = isDb ? filePath : dbPath
      if (!this.dbs.has(base) && existsSync(`${base}-shm`)) {
        this.dbs.set(base, `${base}-shm`)
      }
      for (const sibling of [base, `${base}-wal`, `${base}-shm`]) {
        if (!this.files.has(sibling) && existsSync(sibling)) this.watch(sibling, false)
      }
    }
    return watched
  }

  buildReport(meta: FilesReportMeta): FilesReport {
    return buildFilesReport(this.rawCapture(), meta, this.bucketOptions)
  }

  /** The full sample series + open modes, stored as the downloadable raw file. */
  rawCapture(): FilesRawCapture {
    const modes: Record<string, string> = {}
    for (const watched of this.files.values()) {
      modes[watched.path] = !watched.seenOpen
        ? 'watched'
        : watched.append
          ? 'append'
          : watched.writable
            ? watched.readable
              ? 'read-write'
              : 'write'
            : 'read'
    }
    return { samples: this.samples, modes }
  }
}
