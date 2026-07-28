/**
 * On-disk storage for captured profiles inside the plugin's data directory.
 *
 * Each capture is two files: `<id>.cpuprofile` / `<id>.heapprofile` (the raw
 * V8 output, openable in Chrome DevTools or speedscope) and
 * `<id>.report.json` (the aggregated per-plugin report). The most recent
 * `maxStored` captures per type are kept; older ones are deleted.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProfileListEntry, ProfileReport, ProfileType } from './shared/types'

const ID_PATTERN = /^(cpu|heap)-[A-Za-z0-9][A-Za-z0-9-]*$/
const REPORT_SUFFIX = '.report.json'

export function isValidProfileId(id: string): boolean {
  return ID_PATTERN.test(id)
}

export function profileTypeOf(id: string): ProfileType {
  return id.startsWith('heap-') ? 'heap' : 'cpu'
}

export function rawExtension(type: ProfileType): string {
  return type === 'cpu' ? '.cpuprofile' : '.heapprofile'
}

export function makeProfileId(type: ProfileType, date: Date): string {
  return `${type}-${date.toISOString().replace(/[:.]/g, '-')}`
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
    await fs.writeFile(this.rawPath(report.id), JSON.stringify(raw))
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
