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
    return <p className="empty">No stored profiles yet. Run a capture to create one.</p>
  }
  return (
    <table className="profile-list">
      <thead>
        <tr>
          <th scope="col">Captured</th>
          <th scope="col">Type</th>
          <th scope="col">Duration</th>
          <th scope="col">Size</th>
          <th scope="col">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {profiles.map((profile) => (
          <tr key={profile.id} className={profile.id === selectedId ? 'selected' : undefined}>
            <td>{formatDateTime(profile.capturedAt)}</td>
            <td>{profile.type === 'heap' ? 'Allocation' : 'CPU'}</td>
            <td>{formatDuration(profile.durationMs)}</td>
            <td>{formatBytes(profile.rawSizeBytes)}</td>
            <td className="actions">
              <button type="button" onClick={() => onSelect(profile.id)}>
                Report
              </button>
              <a href={rawProfileUrl(profile.id)} download>
                Raw
              </a>
              <button type="button" className="danger" onClick={() => onDelete(profile.id)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
