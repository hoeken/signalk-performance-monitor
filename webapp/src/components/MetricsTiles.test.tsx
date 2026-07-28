import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { metricsFixture } from '../fixtures'
import { MetricsTiles } from './MetricsTiles'

describe('MetricsTiles', () => {
  it('renders every metric tile with formatted values', () => {
    render(<MetricsTiles metrics={metricsFixture} />)

    expect(screen.getByText('Loop delay p99')).toBeInTheDocument()
    expect(screen.getByText('12.3 ms')).toBeInTheDocument()
    expect(screen.getByText(/p50 2\.1 ms/)).toBeInTheDocument()

    expect(screen.getByText('Loop utilization')).toBeInTheDocument()
    expect(screen.getByText('42.0%')).toBeInTheDocument()

    expect(screen.getByText('CPU')).toBeInTheDocument()
    expect(screen.getByText('37.0%')).toBeInTheDocument()

    expect(screen.getByText('GC pause / interval')).toBeInTheDocument()
    expect(screen.getByText('3.1 ms')).toBeInTheDocument()

    expect(screen.getByText('Heap used')).toBeInTheDocument()
    expect(screen.getByText('84.2 MB')).toBeInTheDocument()
    expect(screen.getByText(/RSS 149\.0 MB/)).toBeInTheDocument()
  })
})
