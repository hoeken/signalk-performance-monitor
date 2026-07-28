import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ThemeToggle } from './ThemeToggle'

const STORAGE_KEY = 'signalk-performance-monitor:theme'

describe('ThemeToggle', () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    delete document.documentElement.dataset.theme
  })

  it('defaults to light when nothing is stored and no dark preference', () => {
    render(<ThemeToggle />)

    expect(document.documentElement.dataset.theme).toBe('perfmon')
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument()
  })

  it('toggles the theme and persists the choice', async () => {
    render(<ThemeToggle />)

    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark mode' }))
    expect(document.documentElement.dataset.theme).toBe('perfmon-dark')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')

    await userEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }))
    expect(document.documentElement.dataset.theme).toBe('perfmon')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  })

  it('applies a stored dark choice on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'dark')
    render(<ThemeToggle />)

    expect(document.documentElement.dataset.theme).toBe('perfmon-dark')
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument()
  })
})
