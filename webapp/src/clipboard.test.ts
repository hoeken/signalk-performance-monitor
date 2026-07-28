import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    document.execCommand = undefined as unknown as typeof document.execCommand
  })

  it('uses the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    expect(await copyText('/some/path')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('/some/path')
  })

  it('falls back to execCommand when the API is missing (plain-HTTP contexts)', async () => {
    // jsdom has no navigator.clipboard by default — exactly like a browser
    // viewing the server over http://.
    let selected = ''
    document.execCommand = vi.fn(() => {
      const textarea = document.querySelector('textarea')
      selected = textarea?.value ?? ''
      return true
    })

    expect(await copyText('/some/path')).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(selected).toBe('/some/path')
    // The scratch textarea is cleaned up again.
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back to execCommand when the API rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    document.execCommand = vi.fn(() => true)

    expect(await copyText('x')).toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith('copy')
  })

  it('reports failure when no mechanism works', async () => {
    expect(await copyText('x')).toBe(false)
    expect(document.querySelector('textarea')).toBeNull()
  })
})
