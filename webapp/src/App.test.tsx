import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileListResponse } from '../../src/shared/types'
import { App } from './App'
import {
  cpuReportFixture,
  httpRequestsFixture,
  metricsFixture,
  profileListFixture,
} from './fixtures'

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
      if (url.endsWith('/http-requests')) return Promise.resolve(jsonResponse(httpRequestsFixture))
      if (url.includes('/profile/upload') && method === 'POST') {
        return Promise.resolve(jsonResponse({ id: 'cpu-uploaded' }))
      }
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
    expect(await screen.findByText('Memory', { selector: 'td' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Documentation' })).toBeInTheDocument()
  })

  it('shows the HTTP requests section', async () => {
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'HTTP Requests' })).toBeInTheDocument()
    expect(await screen.findByText('/signalk/v1/api/vessels/self?depth=1')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Aggregate' })).toBeInTheDocument()
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

    const reportButtons = await screen.findAllByRole('button', { name: 'View' })
    await user.click(reportButtons[0]!)

    expect(await screen.findByRole('heading', { name: 'Report' })).toBeInTheDocument()
    // The bucket name appears in both the flame graph legend and the table.
    expect(screen.getAllByText('signalk-server (core)').length).toBeGreaterThan(0)
    expect(screen.getByText('61.2%')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Flame graph' })).toBeInTheDocument()

    await user.click(reportButtons[0]!)
    expect(screen.queryByRole('heading', { name: 'Report' })).not.toBeInTheDocument()
  })

  it('surfaces admin-authentication errors', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: 'unauthorized' }, 401)),
    )
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Admin login required/)
  })

  it('uploads a profile JSON and shows its report', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('button', { name: 'Upload Profile' })).toBeInTheDocument()
    const file = new File(
      [JSON.stringify({ nodes: [], startTime: 0, endTime: 1 })],
      'cpu-2026-07-28T10-00-00-000Z.json',
      { type: 'application/json' },
    )
    await user.upload(screen.getByLabelText('Upload profile JSON'), file)

    const uploadCall = fetchMock.mock.calls.find(([target]) =>
      String(target).includes('/profile/upload'),
    )
    expect(uploadCall).toBeDefined()
    expect(String(uploadCall![0])).toContain('filename=cpu-2026-07-28T10-00-00-000Z.json')
    const init = uploadCall![1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream' })
    expect(init.body).toBe(file)

    expect(await screen.findByRole('heading', { name: 'Report' })).toBeInTheDocument()
  })

  it('links raw downloads to the raw profile route', async () => {
    render(<App />)
    const rawLinks = await screen.findAllByRole('link', { name: 'Download' })
    expect(rawLinks[0]).toHaveAttribute(
      'href',
      '/plugins/signalk-performance-monitor/profile/cpu-2026-07-28T10-00-00-000Z/raw',
    )
  })
})
