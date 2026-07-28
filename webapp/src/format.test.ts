import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatBytesRate,
  formatDuration,
  formatMs,
  formatPercent,
  formatRate,
} from './format'

describe('formatMs', () => {
  it('renders seconds-valued delays as milliseconds with fixed precision', () => {
    expect(formatMs(0.0123)).toBe('12.3 ms')
    expect(formatMs(0.2)).toBe('200.0 ms')
    expect(formatMs(1.5)).toBe('1,500.0 ms')
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

describe('formatRate', () => {
  it('renders per-second rates with fixed precision', () => {
    expect(formatRate(3.4)).toBe('3.4/s')
    expect(formatRate(0)).toBe('0.0/s')
    expect(formatRate(1234.56)).toBe('1,234.6/s')
  })
})

describe('formatBytes', () => {
  it('scales through kB, MB and GB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(88_300_544)).toBe('84.2 MB')
    expect(formatBytes(2_147_483_648)).toBe('2.0 GB')
  })
})

describe('formatBytesRate', () => {
  it('renders byte rates with the same scaling', () => {
    expect(formatBytesRate(0)).toBe('0 B/s')
    expect(formatBytesRate(46_285)).toBe('45.2 kB/s')
    expect(formatBytesRate(1_572_864)).toBe('1.5 MB/s')
  })
})

describe('formatDuration', () => {
  it('renders capture durations', () => {
    expect(formatDuration(30000)).toBe('30 s')
    expect(formatDuration(500)).toBe('500 ms')
  })
})
