import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpRequests } from './HttpRequests'
import { httpRequestsFixture } from '../fixtures'

/** jsdom's Blob has no .text(), so read it the old way. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error as Error)
    reader.readAsText(blob)
  })
}

const noop = () => Promise.resolve()

function rowTexts(): string[][] {
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

describe('HttpRequests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads the current view as JSON, respecting search but not pagination', async () => {
    const user = userEvent.setup()
    // jsdom implements neither object URLs nor navigation on anchor click.
    const createObjectURL = vi
      .fn<(blob: Blob | MediaSource) => string>()
      .mockReturnValue('blob:mock')
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = vi.fn()
    let downloadName = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadName = this.download
    })
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(downloadName).toMatch(/^http-requests-latest-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
    let json = JSON.parse(await blobText(createObjectURL.mock.calls[0]![0] as Blob)) as {
      path: string
    }[]
    // Self-filtered and sorted newest-first, like the view.
    expect(json.map((row) => row.path)).toEqual([
      '/signalk/v1/api/vessels/self?depth=1',
      '/signalk/v1/api/vessels/self/steering/autopilot',
    ])

    await user.type(screen.getByRole('searchbox', { name: 'Search requests' }), 'autopilot')
    await user.click(screen.getByRole('button', { name: 'Download' }))
    json = JSON.parse(await blobText(createObjectURL.mock.calls.at(-1)![0] as Blob)) as typeof json
    expect(json.map((row) => row.path)).toEqual(['/signalk/v1/api/vessels/self/steering/autopilot'])
  })

  it('invokes the reset handler from the Reset button', async () => {
    const user = userEvent.setup()
    const onReset = vi.fn(() => Promise.resolve())
    render(<HttpRequests data={httpRequestsFixture} onReset={onReset} />)

    await user.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('shows a waiting message before the first response arrives', () => {
    render(<HttpRequests data={null} onReset={noop} />)
    expect(screen.getByText(/Waiting for request data/)).toBeInTheDocument()
  })

  it('explains when recording is disabled instead of rendering the tables', () => {
    render(<HttpRequests data={{ recent: [], aggregate: [], enabled: false }} onReset={noop} />)
    expect(screen.getByText(/recording is turned off/)).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
  })

  it('lists recent requests newest-first and hides this plugin by default', () => {
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    const rows = rowTexts()
    expect(rows).toHaveLength(2)
    expect(rows[0]![3]).toBe('/signalk/v1/api/vessels/self?depth=1')
    // GET paths link to the live URL; other methods stay plain text.
    expect(
      screen.getByRole('link', { name: '/signalk/v1/api/vessels/self?depth=1' }),
    ).toHaveAttribute('href', '/signalk/v1/api/vessels/self?depth=1')
    expect(
      screen.queryByRole('link', { name: '/signalk/v1/api/vessels/self/steering/autopilot' }),
    ).not.toBeInTheDocument()
    expect(rows[0]![5]).toBe('4.2 ms')
    expect(rows[0]![6]).toBe('1.8 kB')
    expect(rows[1]![4]).toBe('405')
    expect(rows[1]![6]).toBe('—')
    expect(screen.queryByText(/performance-monitor\/metrics/)).not.toBeInTheDocument()
  })

  it('shows this plugin’s own requests when the hide toggle is off', async () => {
    const user = userEvent.setup()
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    await user.click(screen.getByRole('checkbox', { name: /Hide this plugin/ }))
    expect(rowTexts()).toHaveLength(3)
    expect(screen.getByText('/plugins/signalk-performance-monitor/metrics')).toBeInTheDocument()
  })

  it('filters rows through the search box', async () => {
    const user = userEvent.setup()
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    await user.type(screen.getByRole('searchbox', { name: 'Search requests' }), 'autopilot')
    const rows = rowTexts()
    expect(rows).toHaveLength(1)
    expect(rows[0]![3]).toContain('autopilot')
  })

  it('expands a request’s headers behind the inspect toggle', async () => {
    const user = userEvent.setup()
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    const inspect = screen.getByRole('button', {
      name: 'Inspect GET /signalk/v1/api/vessels/self?depth=1',
    })
    expect(screen.queryByText('referer')).not.toBeInTheDocument()

    await user.click(inspect)
    expect(inspect).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('referer')).toBeInTheDocument()
    expect(screen.getByText('http://boat.local/admin/')).toBeInTheDocument()
    expect(screen.getByText('(redacted)')).toBeInTheDocument()

    // Entries recorded before headers were tracked degrade gracefully.
    await user.click(
      screen.getByRole('button', {
        name: 'Inspect PUT /signalk/v1/api/vessels/self/steering/autopilot',
      }),
    )
    expect(screen.getByText('No request headers captured.')).toBeInTheDocument()

    await user.click(inspect)
    expect(screen.queryByText('referer')).not.toBeInTheDocument()
  })

  it('sorts by a column when its header is clicked', async () => {
    const user = userEvent.setup()
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    // Numeric columns sort descending first: slowest requests on top.
    await user.click(screen.getByRole('button', { name: /Duration/ }))
    expect(rowTexts().map((row) => row[5])).toEqual(['4.2 ms', '1.1 ms'])
    await user.click(screen.getByRole('button', { name: /Duration/ }))
    expect(rowTexts().map((row) => row[5])).toEqual(['1.1 ms', '4.2 ms'])
  })

  it('highlights slow durations by tier', async () => {
    const user = userEvent.setup()
    const tiers = {
      aggregate: [
        {
          method: 'GET',
          path: '/slow-avg',
          count: 2,
          totalMs: 500, // 250ms average
          maxMs: 300,
          errorCount: 0,
          totalBytes: 0,
          lastSeen: '2026-07-28T10:15:00.000Z',
        },
      ],
      recent: [10, 30, 60, 150, 250].map((durationMs, i) => ({
        timestamp: `2026-07-28T10:15:0${i}.000Z`,
        method: 'GET',
        path: `/req/${durationMs}`,
        statusCode: 200,
        durationMs,
      })),
    }
    render(<HttpRequests data={tiers} onReset={noop} />)

    expect(screen.getByText('10.0 ms')).toHaveClass('text-success')
    expect(screen.getByText('30.0 ms')).toHaveClass('text-info')
    expect(screen.getByText('60.0 ms')).toHaveClass('text-warning')
    expect(screen.getByText('150.0 ms')).toHaveClass('text-orange-600')
    expect(screen.getByText('250.0 ms')).toHaveClass('text-error')

    await user.click(screen.getByRole('tab', { name: 'Aggregate' }))
    expect(screen.getByText('250.0 ms')).toHaveClass('text-error')
  })

  it('renders methods as soft pills and color-codes statuses by hundred-block', () => {
    const requests = [
      { method: 'GET', statusCode: 200 },
      { method: 'POST', statusCode: 302 },
      { method: 'PUT', statusCode: 404 },
      { method: 'DELETE', statusCode: 503 },
      { method: 'OPTIONS', statusCode: 101 },
    ].map((request, i) => ({
      timestamp: `2026-07-28T10:15:0${i}.000Z`,
      path: `/req/${i}`,
      durationMs: 1,
      ...request,
    }))
    render(<HttpRequests data={{ recent: requests, aggregate: [] }} onReset={noop} />)

    expect(screen.getByText('GET')).toHaveClass('badge', 'badge-info', 'badge-soft')
    expect(screen.getByText('POST')).toHaveClass('badge-success')
    expect(screen.getByText('PUT')).toHaveClass('badge-warning')
    expect(screen.getByText('DELETE')).toHaveClass('badge-error')
    // Methods outside the color map still get a pill, just an uncolored one.
    expect(screen.getByText('OPTIONS')).toHaveClass('badge', 'badge-ghost')

    expect(screen.getByText('200')).toHaveClass('text-success')
    expect(screen.getByText('302')).toHaveClass('text-info')
    expect(screen.getByText('404')).toHaveClass('text-warning')
    expect(screen.getByText('503')).toHaveClass('text-error')
    expect(screen.getByText('101')).not.toHaveAttribute('class')
  })

  it('paginates at 15 rows per page', async () => {
    const user = userEvent.setup()
    const many = {
      aggregate: [],
      recent: Array.from({ length: 20 }, (_, i) => ({
        timestamp: `2026-07-28T10:15:${String(i).padStart(2, '0')}.000Z`,
        method: 'GET',
        path: `/req/${i}`,
        statusCode: 200,
        durationMs: 1,
      })),
    }
    render(<HttpRequests data={many} onReset={noop} />)

    expect(rowTexts()).toHaveLength(15)
    expect(screen.getByText('20 rows')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')

    await user.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(rowTexts()).toHaveLength(5)
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(rowTexts()).toHaveLength(15)

    // Re-sorting from a later page snaps back to page 1.
    await user.click(screen.getByRole('button', { name: 'Page 2' }))
    await user.click(screen.getByRole('button', { name: /Duration/ }))
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page')
    expect(rowTexts()).toHaveLength(15)
  })

  it('shows per-path aggregates with computed averages on the Aggregate tab', async () => {
    const user = userEvent.setup()
    render(<HttpRequests data={httpRequestsFixture} onReset={noop} />)

    await user.click(screen.getByRole('tab', { name: 'Aggregate' }))
    const rows = rowTexts()
    // Sorted by request count descending by default; the plugin's own
    // 500-request row is hidden.
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual([
      'GET',
      '/signalk/v1/api/vessels/self',
      '240',
      '0',
      '4.2 ms', // 1008ms / 240
      '1.8 kB', // 439,680 bytes / 240
    ])
    expect(rows[1]![3]).toBe('3') // error count
  })
})
