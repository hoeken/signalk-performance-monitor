import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatMs, formatPercent } from './format'

describe('formatMs', () => {
  it('renders seconds-valued delays as milliseconds', () => {
    expect(formatMs(0.0123)).toBe('12.3 ms')
    expect(formatMs(0.2)).toBe('200 ms')
    expect(formatMs(1.5)).toBe('1.50 s')
    expect(formatMs(0)).toBe('0.0 ms')
  })
})

describe('formatPercent', () => {
  it('renders ratios as percentages', () => {
    expect(formatPercent(0.42)).toBe('42.0%')
    expect(formatPercent(0)).toBe('0.0%')
    expect(formatPercent(1)).toBe('100.0%')
  })
})

describe('formatBytes', () => {
  it('scales through kB, MB and GB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(88_300_544)).toBe('84.2 MB')
    expect(formatBytes(2_147_483_648)).toBe('2.00 GB')
  })
})

describe('formatDuration', () => {
  it('renders capture durations', () => {
    expect(formatDuration(30000)).toBe('30 s')
    expect(formatDuration(500)).toBe('500 ms')
  })
})
