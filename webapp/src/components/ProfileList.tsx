import type { CSSProperties } from 'react'
import type { ProfileListEntry, ProfileType } from '../../../src/shared/types'
import { rawProfileUrl } from '../api'
import { formatBytes, formatDateTime, formatDuration } from '../format'

/**
 * Soft badge per profile type. Warning/error slots stay reserved for real
 * problems; CPU reuses the theme's violet badge tokens since no daisyUI
 * semantic slot is purple.
 */
const TYPE_BADGE: Record<ProfileType, { label: string; className: string; style?: CSSProperties }> =
  {
    heap: { label: 'Memory', className: 'badge-info badge-soft' },
    files: { label: 'Filesystem', className: 'badge-success badge-soft' },
    cpu: {
      label: 'CPU',
      className: 'border-transparent',
      style: { backgroundColor: 'var(--badge-violet-bg)', color: 'var(--badge-violet)' },
    },
  }

function TypeBadge({ type }: { type: ProfileType }) {
  const { label, className, style } = TYPE_BADGE[type]
  return (
    <span className={`badge badge-sm font-medium ${className}`} style={style}>
      {label}
    </span>
  )
}

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
              <td>
                <TypeBadge type={profile.type} />
              </td>
              <td>{formatDuration(profile.durationMs)}</td>
              <td>{formatBytes(profile.rawSizeBytes)}</td>
              <td>
                <div className="flex justify-end gap-1.5">
                  <button
                    type="button"
                    className="btn btn-xs btn-info btn-outline"
                    onClick={() => onSelect(profile.id)}
                  >
                    View
                  </button>
                  <a
                    className="btn btn-xs btn-success btn-outline"
                    href={rawProfileUrl(profile.id)}
                    download
                  >
                    Download
                  </a>
                  <button
                    type="button"
                    className="btn btn-xs btn-error btn-outline"
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
