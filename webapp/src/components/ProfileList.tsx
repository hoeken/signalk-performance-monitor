import type { ProfileListEntry } from '../../../src/shared/types'
import { rawProfileUrl } from '../api'
import { formatBytes, formatDateTime, formatDuration } from '../format'

interface ProfileListProps {
  profiles: ProfileListEntry[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

export function ProfileList({ profiles, selectedId, onSelect, onDelete }: ProfileListProps) {
  if (profiles.length === 0) {
    return (
      <p className="text-sm text-base-content/60">
        No stored profiles yet. Run a capture to create one.
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          <tr>
            <th scope="col">Captured</th>
            <th scope="col">Type</th>
            <th scope="col">Duration</th>
            <th scope="col">Size</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr key={profile.id} className={profile.id === selectedId ? 'bg-base-200' : undefined}>
              <td>{formatDateTime(profile.capturedAt)}</td>
              <td>{profile.type === 'heap' ? 'Memory' : 'CPU'}</td>
              <td>{formatDuration(profile.durationMs)}</td>
              <td>{formatBytes(profile.rawSizeBytes)}</td>
              <td>
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    className="btn btn-xs btn-primary btn-soft"
                    onClick={() => onSelect(profile.id)}
                  >
                    Report
                  </button>
                  <a className="btn btn-xs btn-soft" href={rawProfileUrl(profile.id)} download>
                    JSON
                  </a>
                  <button
                    type="button"
                    className="btn btn-xs btn-error btn-soft"
                    onClick={() => onDelete(profile.id)}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
