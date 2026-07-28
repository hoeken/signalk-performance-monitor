import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { cpuReportFixture, filesReportFixture } from '../fixtures'
import { ReportView } from './ReportView'

// Bucket names also appear in the flame graph's legend and frames, so
// table assertions are scoped to the table.
const bucketTable = () => within(screen.getByRole('table'))

describe('ReportView', () => {
  it('renders one row per bucket with self time and percent', () => {
    render(<ReportView report={cpuReportFixture} />)

    const table = bucketTable()
    expect(table.getByText('(idle)')).toBeInTheDocument()
    expect(table.getByText('61.2%')).toBeInTheDocument()
    expect(table.getByText('signalk-server (core)')).toBeInTheDocument()
    expect(table.getByText('17.4%')).toBeInTheDocument()
    expect(table.getByText('signalk-derived-data')).toBeInTheDocument()
    expect(table.getByText('node runtime')).toBeInTheDocument()
  })

  it('shows capture metadata', () => {
    render(<ReportView report={cpuReportFixture} />)
    expect(screen.getByText(/CPU profile/)).toBeInTheDocument()
    expect(screen.getByText(/30s/)).toBeInTheDocument()
    expect(screen.getByText(/1000 µs/)).toBeInTheDocument()
  })

  it('expands a bucket to reveal its top functions', async () => {
    const user = userEvent.setup()
    render(<ReportView report={cpuReportFixture} />)

    const table = bucketTable()
    expect(table.queryByText('buildFullFromDeltas')).not.toBeInTheDocument()

    const expander = table.getByRole('button', { name: /signalk-server \(core\)/ })
    expect(expander).toHaveAttribute('aria-expanded', 'false')
    await user.click(expander)

    expect(expander).toHaveAttribute('aria-expanded', 'true')
    expect(table.getByText('buildFullFromDeltas')).toBeInTheDocument()
    expect(table.getByText('processDeltas')).toBeInTheDocument()
    expect(
      table.getByText('file:///usr/lib/node_modules/signalk-server/lib/fullsignalk.js'),
    ).toBeInTheDocument()

    await user.click(expander)
    expect(table.queryByText('buildFullFromDeltas')).not.toBeInTheDocument()
  })

  it('offers no expander for buckets without top functions', () => {
    render(<ReportView report={cpuReportFixture} />)
    expect(bucketTable().queryByRole('button', { name: /\(idle\)/ })).not.toBeInTheDocument()
  })

  it('sizes the share bar from the bucket percent', () => {
    render(<ReportView report={cpuReportFixture} />)
    const bars = screen.getAllByTestId('share-bar')
    expect(bars).toHaveLength(cpuReportFixture.buckets.length)
    expect(bars[0]!.style.width).toBe('61.2%')
  })

  it('renders a flame graph when the report carries a flame tree', () => {
    render(<ReportView report={cpuReportFixture} />)
    expect(screen.getByRole('group', { name: 'Flame graph' })).toBeInTheDocument()
    expect(screen.getAllByTestId('flame-frame').length).toBeGreaterThan(0)
  })

  it('explains the missing flame graph on reports from older versions', () => {
    render(<ReportView report={{ ...cpuReportFixture, flame: undefined }} />)
    expect(screen.queryByRole('group', { name: 'Flame graph' })).not.toBeInTheDocument()
    expect(screen.getByText(/predates flame graphs/)).toBeInTheDocument()
  })

  it('renders a file activity report with totals, attribution, and databases', () => {
    render(<ReportView report={filesReportFixture} />)

    expect(screen.getByText(/File activity profile/)).toBeInTheDocument()
    expect(screen.getByText('1.5 MB')).toBeInTheDocument() // process write total

    const attribution = within(
      screen.getByRole('heading', { name: 'Write attribution' }).parentElement as HTMLElement,
    )
    expect(attribution.getByText('maintenance-tracker')).toBeInTheDocument()
    expect(attribution.getByText('67.7%')).toBeInTheDocument()
    expect(within(attribution.getByRole('table')).getByText('(unattributed)')).toBeInTheDocument()

    const databases = within(
      screen.getByRole('heading', { name: 'SQLite databases' }).parentElement as HTMLElement,
    )
    expect(databases.getByText(/maintenance\.db$/)).toBeInTheDocument()
    expect(databases.getByText('8.00')).toBeInTheDocument() // commits/s
    expect(databases.getByText(/consider batching/)).toBeInTheDocument()

    const files = within(
      screen.getByRole('heading', { name: 'Open files' }).parentElement as HTMLElement,
    )
    expect(files.getByText(/maintenance\.db-wal/)).toBeInTheDocument()
    expect(files.getByText(/courseInfo\.json/)).toBeInTheDocument()
    // settings.json and the idle main db file fold into the idle count.
    expect(files.queryByText(/settings\.json/)).not.toBeInTheDocument()
    expect(
      files.getByText(
        (_, element) =>
          element?.tagName === 'P' &&
          /2 more open files saw no changes/.test(element.textContent ?? ''),
      ),
    ).toBeInTheDocument()

    // No flame graph or top-function machinery for file reports.
    expect(screen.queryByRole('group', { name: 'Flame graph' })).not.toBeInTheDocument()
  })
})
