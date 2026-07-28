import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { cpuReportFixture, heapReportFixture } from '../fixtures'
import { FlameGraph } from './FlameGraph'

const cpuFlame = cpuReportFixture.flame!
const heapFlame = heapReportFixture.flame!

describe('FlameGraph', () => {
  it('renders one frame per node, sized by its share of the view', () => {
    render(<FlameGraph root={cpuFlame} type="cpu" />)

    const frames = screen.getAllByTestId('flame-frame')
    expect(frames).toHaveLength(6)

    const idle = screen.getByRole('button', { name: /\(idle\)/ })
    expect(idle.style.width).toBe('61.2%')
    const core = screen.getByRole('button', { name: /processDeltas/ })
    expect(core.style.width).toBe('17.4%')
  })

  it('describes each frame with bucket, value, and share', () => {
    render(<FlameGraph root={cpuFlame} type="cpu" />)
    expect(
      screen.getByRole('button', {
        name: 'recalculate — signalk-derived-data — 4.20 s (14.0% of capture)',
      }),
    ).toBeInTheDocument()
  })

  it('formats heap frames in bytes', () => {
    render(<FlameGraph root={heapFlame} type="heap" />)
    expect(
      screen.getByRole('button', {
        name: 'allocateBuffers — plugin-x — 4.0 MB (100.0% of capture)',
      }),
    ).toBeInTheDocument()
  })

  it('zooms to a clicked frame and back via reset', async () => {
    const user = userEvent.setup()
    render(<FlameGraph root={cpuFlame} type="cpu" />)

    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /processDeltas/ }))

    // The zoomed frame spans the view; its subtree is rescaled to it.
    expect(screen.getByRole('button', { name: /processDeltas/ }).style.width).toBe('100%')
    const child = screen.getByRole('button', { name: /buildFullFromDeltas .*10\.3% of capture/ })
    expect(child.style.width).toBe('59.387%')
    // Frames outside the zoom are gone; the root stays as clickable context.
    expect(screen.queryByRole('button', { name: /recalculate/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Reset zoom' }))
    expect(screen.getByRole('button', { name: /recalculate/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reset zoom' })).not.toBeInTheDocument()
  })

  it('zooms back out when an ancestor frame is clicked', async () => {
    const user = userEvent.setup()
    render(<FlameGraph root={cpuFlame} type="cpu" />)

    await user.click(screen.getByRole('button', { name: /processDeltas/ }))
    await user.click(screen.getByRole('button', { name: /\(root\)/ }))
    expect(screen.getByRole('button', { name: /recalculate/ })).toBeInTheDocument()
  })

  it('shows a legend keyed by bucket plus the neutral fills', () => {
    render(<FlameGraph root={cpuFlame} type="cpu" />)
    const legendOf = (text: string) => screen.getByText(text, { selector: 'span' })
    expect(legendOf('signalk-server (core)')).toBeInTheDocument()
    expect(legendOf('signalk-derived-data')).toBeInTheDocument()
    expect(legendOf('runtime & system')).toBeInTheDocument()
    expect(legendOf('(idle)')).toBeInTheDocument()
  })

  it('shows a tooltip with value, name, bucket, and url on hover', () => {
    render(<FlameGraph root={cpuFlame} type="cpu" />)

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.mouseMove(screen.getByRole('button', { name: /recalculate/ }), {
      clientX: 40,
      clientY: 30,
    })

    const tooltip = screen.getByRole('status')
    expect(tooltip).toHaveTextContent('4.20 s · 14.0% of view · 14.0% of capture')
    expect(tooltip).toHaveTextContent('recalculate')
    expect(tooltip).toHaveTextContent('signalk-derived-data · self 4.20 s')
    expect(tooltip).toHaveTextContent(
      '/home/pi/.signalk/node_modules/signalk-derived-data/index.js',
    )
  })

  it('shows the same tooltip on keyboard focus and hides it on blur', () => {
    render(<FlameGraph root={cpuFlame} type="cpu" />)

    const frame = screen.getByRole('button', { name: /recalculate/ })
    fireEvent.focus(frame)
    expect(screen.getByRole('status')).toHaveTextContent('recalculate')
    fireEvent.blur(frame)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('labels only the frames wide enough for their full name', () => {
    // jsdom has no layout; simulate a 1000px-wide container.
    const spy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    try {
      render(<FlameGraph root={cpuFlame} type="cpu" />)
      // (idle) spans 612px — its name fits inline.
      expect(screen.getByRole('button', { name: /\(idle\)/ })).toHaveTextContent('(idle)')
      // buildFullFromDeltas spans ~103px, too narrow for 19 characters —
      // no inline label; the tooltip and aria-label carry it instead.
      expect(screen.getByRole('button', { name: /buildFullFromDeltas/ })).toHaveTextContent('')
    } finally {
      spy.mockRestore()
    }
  })

  it('never overlaps frames or lets a child escape its parent row span', () => {
    render(<FlameGraph root={cpuFlame} type="cpu" />)

    const rects = screen.getAllByTestId('flame-frame').map((el) => ({
      top: parseFloat(el.style.top),
      left: parseFloat(el.style.left),
      width: parseFloat(el.style.width),
    }))
    const byRow = new Map<number, { left: number; width: number }[]>()
    for (const rect of rects) {
      const row = byRow.get(rect.top) ?? []
      row.push(rect)
      byRow.set(rect.top, row)
    }
    for (const row of byRow.values()) {
      row.sort((a, b) => a.left - b.left)
      for (let i = 1; i < row.length; i++) {
        expect(row[i]!.left + 0.01).toBeGreaterThanOrEqual(row[i - 1]!.left + row[i - 1]!.width)
      }
      for (const rect of row) {
        expect(rect.left + rect.width).toBeLessThanOrEqual(100.01)
      }
    }
  })
})
