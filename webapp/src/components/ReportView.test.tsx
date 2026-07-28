import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { cpuReportFixture } from '../fixtures'
import { ReportView } from './ReportView'

describe('ReportView', () => {
  it('renders one row per bucket with self time and percent', () => {
    render(<ReportView report={cpuReportFixture} />)

    expect(screen.getByText('(idle)')).toBeInTheDocument()
    expect(screen.getByText('61.2%')).toBeInTheDocument()
    expect(screen.getByText('signalk-server (core)')).toBeInTheDocument()
    expect(screen.getByText('17.4%')).toBeInTheDocument()
    expect(screen.getByText('signalk-derived-data')).toBeInTheDocument()
    expect(screen.getByText('node runtime')).toBeInTheDocument()
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

    expect(screen.queryByText('buildFullFromDeltas')).not.toBeInTheDocument()

    const expander = screen.getByRole('button', { name: /signalk-server \(core\)/ })
    expect(expander).toHaveAttribute('aria-expanded', 'false')
    await user.click(expander)

    expect(expander).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('buildFullFromDeltas')).toBeInTheDocument()
    expect(screen.getByText('processDeltas')).toBeInTheDocument()
    expect(
      screen.getByText('file:///usr/lib/node_modules/signalk-server/lib/fullsignalk.js'),
    ).toBeInTheDocument()

    await user.click(expander)
    expect(screen.queryByText('buildFullFromDeltas')).not.toBeInTheDocument()
  })

  it('offers no expander for buckets without top functions', () => {
    render(<ReportView report={cpuReportFixture} />)
    expect(screen.queryByRole('button', { name: /\(idle\)/ })).not.toBeInTheDocument()
  })

  it('sizes the share bar from the bucket percent', () => {
    const { container } = render(<ReportView report={cpuReportFixture} />)
    const bars = container.querySelectorAll('.bar')
    expect(bars).toHaveLength(cpuReportFixture.buckets.length)
    expect((bars[0] as HTMLElement).style.width).toBe('61.2%')
  })
})
