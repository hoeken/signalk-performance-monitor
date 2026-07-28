import type {
  MetricsSnapshot,
  ProfileListResponse,
  ProfileReport,
  ProfileType,
  StartProfileResponse,
} from '../../src/shared/types'

export const API_BASE = '/plugins/signalk-performance-monitor'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
  })
  if (!response.ok) {
    let message = `request failed (${response.status})`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // non-JSON error body
    }
    if (response.status === 401 || response.status === 403) {
      message = 'Admin login required — sign in to the Signal K admin UI'
    }
    throw new ApiError(response.status, message)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const getMetrics = () => request<MetricsSnapshot>('/metrics')

export const getProfiles = () => request<ProfileListResponse>('/profile')

export const startProfile = (type: ProfileType, durationSeconds: number) =>
  request<StartProfileResponse>(type === 'cpu' ? '/profile' : '/heap-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration: durationSeconds }),
  })

// Sent as octet-stream so JSON body-parser size limits don't apply to
// multi-megabyte profiles; the filename lets the server restore the
// original id and capture time of a re-uploaded download.
export const uploadProfile = (file: File) =>
  request<StartProfileResponse>(`/profile/upload?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })

export const getReport = (id: string) => request<ProfileReport>(`/profile/${id}/report`)

export const deleteProfile = (id: string) => request<void>(`/profile/${id}`, { method: 'DELETE' })

export const rawProfileUrl = (id: string) => `${API_BASE}/profile/${id}/raw`
