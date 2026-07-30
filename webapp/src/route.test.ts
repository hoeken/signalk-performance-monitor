import { describe, expect, it } from 'vitest'
import { routeFromHash, routeHref } from './route'

describe('routeFromHash', () => {
  it('reads the known pages', () => {
    expect(routeFromHash('#/monitor')).toBe('monitor')
    expect(routeFromHash('#/load-test')).toBe('load-test')
    expect(routeFromHash('#load-test')).toBe('load-test')
  })

  it('falls back to the monitor page', () => {
    expect(routeFromHash('')).toBe('monitor')
    expect(routeFromHash('#/nope')).toBe('monitor')
  })

  it('round-trips its own hrefs', () => {
    expect(routeFromHash(routeHref('load-test'))).toBe('load-test')
  })
})
