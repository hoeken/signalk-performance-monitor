/**
 * On-disk storage for captured profiles inside the plugin's data directory.
 *
 * Each capture is two files: `<id>.cpuprofile` / `<id>.heapprofile` (the raw
 * V8 output plus an EMBEDDED_META_KEY entry, still openable in Chrome
 * DevTools or speedscope) and `<id>.report.json` (the aggregated per-plugin
 * report). The most recent `maxStored` captures per type are kept; older
 * ones are deleted.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProfileListEntry, ProfileReport, ProfileType } from './shared/types'

const ID_PATTERN = /^(cpu|heap|files)-[A-Za-z0-9][A-Za-z0-9-]*$/
const REPORT_SUFFIX = '.report.json'

export function isValidProfileId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function profileTypeOf(id: string): ProfileType {
  if (id.startsWith('heap-')) return 'heap'
  if (id.startsWith('files-')) return 'files'
  return 'cpu'
}

export function rawExtension(type: ProfileType): string {
  if (type === 'cpu') return '.cpuprofile'
  if (type === 'heap') return '.heapprofile'
  return '.filesprofile'
}

export function makeProfileId(type: ProfileType, date: Date): string {
  return `${type}-${date.toISOString().replace(/[:.]/g, '-')}`
}

/** Inverse of makeProfileId: the capture timestamp embedded in an id, if any. */
export function capturedAtFromProfileId(id: string): string | null {
  const match = /^(?:cpu|heap|files)-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id)
  if (!match) return null
  const iso = `${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`
  return Number.isNaN(Date.parse(iso)) ? null : iso
}

/**
 * Capture metadata embedded in saved raw profiles under this key. The raw
 * V8 format doesn't record when or how a profile was captured, so without
 * it that information would be lost on download and re-upload. Foreign
 * tools (Chrome DevTools, speedscope) ignore unknown top-level keys.
 */
export const EMBEDDED_META_KEY = 'signalk-performance-monitor'

export interface EmbeddedProfileMeta {
  id: string
  type: ProfileType
  capturedAt: string
  durationMs: number
  samplingIntervalUs?: number
  samplingIntervalBytes?: number
  sampleIntervalSeconds?: number
}

/** The fields of a raw profile's embedded metadata that validate. */
export function embeddedProfileMetaOf(raw: unknown): Partial<EmbeddedProfileMeta> {
  if (!raw || typeof raw !== 'object') return {}
  const value = (raw as Record<string, unknown>)[EMBEDDED_META_KEY]
  if (!value || typeof value !== 'object') return {}
  const meta = value as Record<string, unknown>
  const out: Partial<EmbeddedProfileMeta> = {}
  if (typeof meta.id === 'string' && isValidProfileId(meta.id)) out.id = meta.id
  if (typeof meta.capturedAt === 'string' && !Number.isNaN(Date.parse(meta.capturedAt))) {
    out.capturedAt = meta.capturedAt
  }
  if (typeof meta.durationMs === 'number' && meta.durationMs >= 0) out.durationMs = meta.durationMs
  if (typeof meta.samplingIntervalUs === 'number' && meta.samplingIntervalUs > 0) {
    out.samplingIntervalUs = meta.samplingIntervalUs
  }
  if (typeof meta.samplingIntervalBytes === 'number' && meta.samplingIntervalBytes > 0) {
    out.samplingIntervalBytes = meta.samplingIntervalBytes
  }
  if (typeof meta.sampleIntervalSeconds === 'number' && meta.sampleIntervalSeconds > 0) {
    out.sampleIntervalSeconds = meta.sampleIntervalSeconds
  }
  return out
}

function withEmbeddedMeta(report: ProfileReport, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const meta: EmbeddedProfileMeta = {
    id: report.id,
    type: report.type,
    capturedAt: report.capturedAt,
    durationMs: report.durationMs,
    ...(report.type === 'cpu'
      ? { samplingIntervalUs: report.samplingIntervalUs }
      : report.type === 'heap'
        ? { samplingIntervalBytes: report.samplingIntervalBytes }
        : { sampleIntervalSeconds: report.sampleIntervalSeconds }),
  }
  return { ...raw, [EMBEDDED_META_KEY]: meta }
}

export class ProfileStore {
  private ready: Promise<void> | null = null

  constructor(
    private readonly dir: string,
    private readonly maxStored: number,
  ) {}

  private ensureDir(): Promise<void> {
    if (!this.ready) {
      this.ready = fs.mkdir(this.dir, { recursive: true }).then(() => undefined)
    }
    return this.ready
  }

  private rawPath(id: string): string {
    return path.join(this.dir, `${id}${rawExtension(profileTypeOf(id))}`)
  }

  private reportPath(id: string): string {
    return path.join(this.dir, `${id}${REPORT_SUFFIX}`)
  }

  async save(report: ProfileReport, raw: unknown): Promise<void> {
    if (!isValidProfileId(report.id)) {
      throw new Error(`invalid profile id: ${report.id}`)
    }
    await this.ensureDir()
    await fs.writeFile(this.rawPath(report.id), JSON.stringify(withEmbeddedMeta(report, raw)))
    await fs.writeFile(this.reportPath(report.id), JSON.stringify(report, null, 2))
    await this.rotate(report.type)
  }

  private async rotate(type: ProfileType): Promise<void> {
    const entries = await this.list()
    const excess = entries.filter((entry) => entry.type === type).slice(this.maxStored)
    for (const entry of excess) {
      await this.delete(entry.id)
    }
  }

  /** Stored profiles, most recent first. */
  async list(): Promise<ProfileListEntry[]> {
    await this.ensureDir()
    const files = await fs.readdir(this.dir)
    const entries: ProfileListEntry[] = []
    for (const file of files) {
      if (!file.endsWith(REPORT_SUFFIX)) continue
      const id = file.slice(0, -REPORT_SUFFIX.length)
      if (!isValidProfileId(id)) continue
      try {
        const report = JSON.parse(await fs.readFile(this.reportPath(id), 'utf8')) as ProfileReport
        const rawStat = await fs.stat(this.rawPath(id))
        entries.push({
          id,
          type: report.type,
          capturedAt: report.capturedAt,
          durationMs: report.durationMs,
          rawSizeBytes: rawStat.size,
        })
      } catch {
        // A partially written or deleted capture; skip it.
      }
    }
    return entries.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  }

  async getReport(id: string): Promise<ProfileReport | null> {
    if (!isValidProfileId(id)) return null
    await this.ensureDir()
    try {
      return JSON.parse(await fs.readFile(this.reportPath(id), 'utf8')) as ProfileReport
    } catch {
      return null
    }
  }

  async getRaw(id: string): Promise<Buffer | null> {
    if (!isValidProfileId(id)) return null
    await this.ensureDir()
    try {
      return await fs.readFile(this.rawPath(id))
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidProfileId(id)) return false
    await this.ensureDir()
    let deleted = false
    for (const file of [this.rawPath(id), this.reportPath(id)]) {
      try {
        await fs.unlink(file)
        deleted = true
      } catch {
        // already gone
      }
    }
    return deleted
  }
}
