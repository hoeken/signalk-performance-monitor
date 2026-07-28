import { useState } from 'react'
import type { ProfileType, RunningCapture } from '../../../src/shared/types'

const DURATIONS = [10, 30, 60, 120]

interface ProfileControlsProps {
  running: RunningCapture | null
  onStart: (type: ProfileType, durationSeconds: number) => void
}

export function ProfileControls({ running, onStart }: ProfileControlsProps) {
  const [duration, setDuration] = useState(30)

  if (running) {
    const progress =
      running.durationSeconds > 0
        ? Math.min(1, 1 - running.remainingSeconds / running.durationSeconds)
        : 0
    return (
      <div className="profile-controls">
        <div className="capture-progress">
          <span>
            {running.type === 'heap' ? 'Heap profiling' : 'CPU profiling'}:{' '}
            {running.remainingSeconds}s remaining
          </span>
          <progress value={progress} max={1} aria-label="Capture progress" />
        </div>
      </div>
    )
  }

  return (
    <div className="profile-controls">
      <label>
        Duration{' '}
        <select
          value={duration}
          onChange={(event) => setDuration(Number(event.target.value))}
          aria-label="Capture duration"
        >
          {DURATIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds}s
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={() => onStart('cpu', duration)}>
        Profile CPU
      </button>
      <button type="button" onClick={() => onStart('heap', duration)}>
        Profile allocations
      </button>
    </div>
  )
}
