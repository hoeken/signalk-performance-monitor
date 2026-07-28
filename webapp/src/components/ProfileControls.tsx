import { useRef, useState } from 'react'
import type { ProfileType, RunningCapture } from '../../../src/shared/types'

const DURATIONS = [10, 30, 60, 120]

interface ProfileControlsProps {
  running: RunningCapture | null
  onStart: (type: ProfileType, durationSeconds: number) => void
  onUpload: (file: File) => void
}

export function ProfileControls({ running, onStart, onUpload }: ProfileControlsProps) {
  const [duration, setDuration] = useState(30)
  const fileInput = useRef<HTMLInputElement>(null)

  if (running) {
    const progress =
      running.durationSeconds > 0
        ? Math.min(1, 1 - running.remainingSeconds / running.durationSeconds)
        : 0
    return (
      <div className="flex w-full items-center gap-3">
        <span className="text-sm whitespace-nowrap">
          {running.type === 'heap' ? 'Memory profiling' : 'CPU profiling'}:{' '}
          {running.remainingSeconds}s remaining
        </span>
        <progress
          className="progress progress-primary flex-1"
          value={progress}
          max={1}
          aria-label="Capture progress"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-sm">
        Duration{' '}
        <select
          className="select select-sm w-20"
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
      <button
        type="button"
        className="btn btn-sm btn-primary btn-outline"
        onClick={() => onStart('cpu', duration)}
      >
        Profile CPU
      </button>
      <button
        type="button"
        className="btn btn-sm btn-primary btn-outline"
        onClick={() => onStart('heap', duration)}
      >
        Profile Memory
      </button>
      <button
        type="button"
        className="btn btn-sm btn-success btn-outline"
        onClick={() => fileInput.current?.click()}
      >
        Upload
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json,.cpuprofile,.heapprofile,application/json"
        className="hidden"
        aria-label="Upload profile JSON"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onUpload(file)
          // reset so re-selecting the same file fires onChange again
          event.target.value = ''
        }}
      />
    </div>
  )
}
