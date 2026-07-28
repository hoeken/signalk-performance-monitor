import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Documentation } from './Documentation'

describe('Documentation', () => {
  it('renders the three help panels, collapsed by default', () => {
    render(<Documentation />)

    for (const title of [
      'How to use this plugin',
      'What the terms mean',
      'How to interpret the data',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument()
    }
    for (const details of document.querySelectorAll('details')) {
      expect(details.open).toBe(false)
    }
  })

  it('defines every metric tile term once expanded', () => {
    render(<Documentation />)
    for (const details of document.querySelectorAll('details')) {
      details.open = true
    }

    for (const term of [
      'Loop delay (p50 / p99 / max)',
      'Loop utilization',
      'CPU',
      'GC pause / interval',
      'Heap used / RSS',
      'CPU profile',
      'Memory profile',
      'Bucket',
      'Self time / self memory',
      'Flame graph',
    ]) {
      expect(screen.getByText(term, { selector: 'dt' })).toBeInTheDocument()
    }
  })
})
