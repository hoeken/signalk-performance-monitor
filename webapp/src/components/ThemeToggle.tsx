import { useEffect, useState } from 'react'

/**
 * Light/dark toggle. Follows the browser's prefers-color-scheme until the
 * user picks a side, then the choice is stored and wins on later visits
 * (the inline script in index.html re-applies it before first paint).
 * Storage key is origin-scoped and the SignalK server hosts every webapp
 * on one origin, hence the plugin-name prefix.
 */

const STORAGE_KEY = 'signalk-performance-monitor:theme'
const THEME_NAMES = { light: 'perfmon', dark: 'perfmon-dark' } as const

type Mode = keyof typeof THEME_NAMES

function storedMode(): Mode | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

function browserMode(): Mode {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(() => storedMode() ?? browserMode())

  useEffect(() => {
    document.documentElement.dataset.theme = THEME_NAMES[mode]
    // Keep the mobile toolbar tint on the theme's base-100 (see index.html).
    const tint = mode === 'dark' ? '#1a1a19' : '#fcfcfb'
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((meta) => meta.setAttribute('content', tint))
  }, [mode])

  // Track browser preference changes only while the user hasn't chosen.
  useEffect(() => {
    if (storedMode() || !window.matchMedia) return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      if (!storedMode()) setMode(query.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  const toggle = () => {
    const next: Mode = mode === 'dark' ? 'light' : 'dark'
    setMode(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage unavailable (private mode); the toggle still works for this visit.
    }
  }

  const label = mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm btn-circle text-base-content/70"
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      {mode === 'dark' ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  )
}
