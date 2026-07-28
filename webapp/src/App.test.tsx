import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileListResponse } from '../../src/shared/types'
import { App } from './App'
import { cpuReportFixture, metricsFixture, profileListFixture } from './fixtures'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('App', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let profileList: ProfileListResponse

  beforeEach(() => {
    profileList = structuredClone(profileListFixture)
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/metrics')) return Promise.resolve(jsonResponse(metricsFixture))
      if (url.endsWith('/profile') && method === 'GET') {
        return Promise.resolve(jsonResponse(profileList))
      }
      if (url.endsWith('/profile') && method === 'POST') {
        profileList = {
          ...profileList,
          running: {
            id: 'cpu-new',
            type: 'cpu',
            startedAt: '2026-07-28T11:00:00.000Z',
            durationSeconds: 30,
            remainingSeconds: 30,
          },
        }
        return Promise.resolve(jsonResponse({ id: 'cpu-new' }))
      }
      if (url.includes('/report')) return Promise.resolve(jsonResponse(cpuReportFixture))
      if (method === 'DELETE') return Promise.resolve(new Response(null, { status: 204 }))
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows live metrics and the stored profile list', async () => {
    render(<App />)

    expect(await screen.findByText('12.3 ms')).toBeInTheDocument()
    expect(await screen.findByText('Allocation')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Report' })).toHaveLength(2)
  })

  it('starts a CPU capture and switches to progress display', async () => {
    const user = userEvent.setup()
    render(<App />)

    const startButton = await screen.findByRole('button', { name: 'Profile CPU' })
    await user.click(startButton)

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
    )
    expect(postCall).toBeDefined()
    expect(String(postCall![0])).toContain('/plugins/signalk-performance-monitor/profile')
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ duration: 30 })

    expect(await screen.findByText(/CPU profiling: 30s remaining/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Profile CPU' })).not.toBeInTheDocument()
  })

  it('toggles the per-plugin report for a stored profile', async () => {
    const user = userEvent.setup()
    render(<App />)

    const reportButtons = await screen.findAllByRole('button', { name: 'Report' })
    await user.click(reportButtons[0]!)

    expect(await screen.findByText('Per-plugin report')).toBeInTheDocument()
    expect(screen.getByText('signalk-server (core)')).toBeInTheDocument()
    expect(screen.getByText('61.2%')).toBeInTheDocument()

    await user.click(reportButtons[0]!)
    expect(screen.queryByText('Per-plugin report')).not.toBeInTheDocument()
  })

  it('surfaces admin-authentication errors', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)),
    )
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Admin login required/)
  })

  it('links raw downloads to the raw profile route', async () => {
    render(<App />)
    const rawLinks = await screen.findAllByRole('link', { name: 'Raw' })
    expect(rawLinks[0]).toHaveAttribute(
      'href',
      '/plugins/signalk-performance-monitor/profile/cpu-2026-07-28T10-00-00-000Z/raw',
    )
  })
})
