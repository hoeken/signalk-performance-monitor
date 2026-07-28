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

  it('styles Summary paths like the files table: trimmed, badged, with a copy button', async () => {
    const user = userEvent.setup()
    render(<FilesReportView report={filesReportFixture} />)

    // Summary renders three tables: attribution, databases, open files.
    const [, dbTable, openTable] = screen.getAllByRole('table')

    // Databases: root-trimmed path, bucket as a badge underneath, note kept.
    const dbCell = within(dbTable!).getAllByRole('cell')[0]!
    expect(dbCell).toHaveTextContent('plugin-config-data/maintenance-tracker/maintenance.db')
    expect(dbCell).not.toHaveTextContent('/data/.signalk')
    expect(within(dbCell).getByText('maintenance-tracker')).toHaveClass('badge')
    expect(within(dbCell).getByRole('alert')).toHaveTextContent(/sustained commits/)
    expect(within(dbCell).getByRole('alert')).toHaveClass('alert-warning', 'alert-soft')

    // Open files: bucket / mode / kind fold into badges inside the File cell.
    const walRow = within(openTable!)
      .getAllByRole('row')
      .find((row) => row.textContent!.includes('maintenance.db-wal'))!
    const fileCell = within(walRow).getAllByRole('cell')[0]!
    expect(within(fileCell).getByText('maintenance-tracker')).toHaveClass('badge')
    expect(within(fileCell).getByText('read-write')).toHaveClass('badge')
    expect(within(fileCell).getByText('sqlite')).toHaveClass('badge')

    // The display is trimmed but the copy button holds the absolute path.
    await user.click(within(dbCell).getByRole('button', { name: 'Copy file path' }))
    expect(await window.navigator.clipboard.readText()).toBe(
      '/data/.signalk/plugin-config-data/maintenance-tracker/maintenance.db',
    )
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
    // is trimmed from the displayed path; bucket/mode/kind render as badges
    // inside the File cell.
    expect(rows[0]![0]).toContain('serverstate/course/courseInfo.json')
    expect(rows[0]![0]).toContain('signalk-server (core)')
    expect(rows[0]![0]).toContain('write')
    expect(rows[0]![0]).not.toContain('sqlite') // no kind badge for plain files
    expect(rows[0]!.slice(1)).toEqual(['812 B', '23.8 kB', '30', '—'])
    const wal = rows.find((row) =>
      row[0]!.includes('plugin-config-data/maintenance-tracker/maintenance.db-wal'),
    )
    expect(wal![0]).toContain('maintenance-tracker')
    expect(wal![0]).toContain('read-write')
    // The kind badge drops the family suffix — the filename already shows it.
    expect(wal![0]).toContain('sqlite')
    expect(wal![0]).not.toContain('sqlite-wal')
    expect(wal!.slice(1)).toEqual(['4.0 MB', '—', '30', '30'])

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
