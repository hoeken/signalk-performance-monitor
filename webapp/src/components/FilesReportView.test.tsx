import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FilesReportView } from './FilesReportView'
import { filesReportFixture } from '../fixtures'

/** jsdom's Blob has no .text(), so read it the old way. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error as Error)
    reader.readAsText(blob)
  })
}

function fileRows(): string[][] {
  const [table] = screen.getAllByRole('table')
  return within(table!)
    .getAllByRole('row')
    .slice(1) // skip the header row
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent ?? ''),
    )
}

function mockDownload() {
  const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>().mockReturnValue('blob:mock')
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = vi.fn()
  let downloadName = ''
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadName = this.download
  })
  return { createObjectURL, lastName: () => downloadName }
}

describe('FilesReportView', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens on the Summary tab without the individual files table', () => {
    render(<FilesReportView report={filesReportFixture} />)

    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Write attribution' })).toBeInTheDocument()
    // The idle settings.json only appears on the Individual Files tab.
    expect(screen.queryByText(/settings\.json/)).not.toBeInTheDocument()
  })

  it('lists watched files with data-root-relative paths, hiding readonly ones by default', async () => {
    const user = userEvent.setup()
    render(<FilesReportView report={filesReportFixture} />)

    await user.click(screen.getByRole('tab', { name: 'Individual Files' }))

    // settings.json is only open for reading, so it starts hidden.
    let rows = fileRows()
    expect(rows).toHaveLength(3)
    expect(rows.some((row) => row[0]!.includes('settings.json'))).toBe(false)

    // Sorted by growth descending: the append writer leads. The data root
    // is trimmed from the displayed path.
    expect(rows[0]![0]).toBe('serverstate/course/courseInfo.json')
    expect(rows[0]!.slice(1)).toEqual([
      'signalk-server (core)',
      'write',
      'file',
      '812 B',
      '23.8 kB',
      '30',
      '—',
    ])
    const wal = rows.find((row) =>
      row[0]!.includes('plugin-config-data/maintenance-tracker/maintenance.db-wal'),
    )
    expect(wal!.slice(1)).toEqual([
      'maintenance-tracker',
      'read-write',
      'sqlite-wal',
      '4.0 MB',
      '—',
      '30',
      '30',
    ])

    // Unticking the filter reveals the readonly file.
    await user.click(screen.getByRole('checkbox', { name: 'Hide readonly files' }))
    rows = fileRows()
    expect(rows).toHaveLength(filesReportFixture.files.length)
    expect(rows.some((row) => row[0]!.includes('settings.json'))).toBe(true)
  })

  it('copies the full path from the copy button', async () => {
    const user = userEvent.setup()
    render(<FilesReportView report={filesReportFixture} />)
    await user.click(screen.getByRole('tab', { name: 'Individual Files' }))

    const copyButtons = screen.getAllByRole('button', { name: 'Copy file path' })
    await user.click(copyButtons[0]!)

    // The first row displays the trimmed path but copies the absolute one.
    expect(await window.navigator.clipboard.readText()).toBe(
      '/data/.signalk/serverstate/course/courseInfo.json',
    )
  })

  it('searches the files table', async () => {
    const user = userEvent.setup()
    render(<FilesReportView report={filesReportFixture} />)
    await user.click(screen.getByRole('tab', { name: 'Individual Files' }))

    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'sqlite-wal')
    const rows = fileRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]![0]).toContain('maintenance.db-wal')
  })

  it('downloads the current files view or the full report as JSON', async () => {
    const user = userEvent.setup()
    const download = mockDownload()
    render(<FilesReportView report={filesReportFixture} />)

    // Summary tab: the whole report.
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(download.lastName()).toBe(`${filesReportFixture.id}.report.json`)
    const report = JSON.parse(
      await blobText(download.createObjectURL.mock.calls[0]![0] as Blob),
    ) as unknown
    expect(report).toEqual(filesReportFixture)

    // Individual Files tab: the filtered+searched rows. settings.json is
    // readonly, so the filter has to come off before it can be exported.
    await user.click(screen.getByRole('tab', { name: 'Individual Files' }))
    await user.click(screen.getByRole('checkbox', { name: 'Hide readonly files' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search files' }), 'settings')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(download.lastName()).toBe(`${filesReportFixture.id}.files.json`)
    const rows = JSON.parse(
      await blobText(download.createObjectURL.mock.calls.at(-1)![0] as Blob),
    ) as { path: string }[]
    expect(rows.map((row) => row.path)).toEqual(['/data/.signalk/settings.json'])
  })
})
