import { Fragment, useState } from 'react'
import type { ProfileReport } from '../../../src/shared/types'
import { formatBytes, formatDateTime } from '../format'

interface ReportRow {
  name: string
  self: number
  percent: number
  topFunctions: { name: string; url: string; self: number }[]
}

function toRows(report: ProfileReport): ReportRow[] {
  if (report.type === 'cpu') {
    return report.buckets.map((bucket) => ({
      name: bucket.name,
      self: bucket.selfTimeMs,
      percent: bucket.percent,
      topFunctions: (bucket.topFunctions ?? []).map((fn) => ({
        name: fn.name,
        url: fn.url,
        self: fn.selfTimeMs,
      })),
    }))
  }
  return report.buckets.map((bucket) => ({
    name: bucket.name,
    self: bucket.selfBytes,
    percent: bucket.percent,
    topFunctions: (bucket.topFunctions ?? []).map((fn) => ({
      name: fn.name,
      url: fn.url,
      self: fn.selfBytes,
    })),
  }))
}

export function ReportView({ report }: { report: ProfileReport }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (name: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const formatSelf = (value: number) =>
    report.type === 'cpu' ? `${value.toLocaleString()} ms` : formatBytes(value)

  const num = 'text-right tabular-nums whitespace-nowrap'

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-base-content/60">
        {report.type === 'cpu' ? 'CPU profile' : 'Allocation profile'} ·{' '}
        {formatDateTime(report.capturedAt)} · {Math.round(report.durationMs / 1000)}s
        {report.type === 'cpu'
          ? ` · sampled every ${report.samplingIntervalUs} µs`
          : ` · sampled every ${formatBytes(report.samplingIntervalBytes)}`}
      </p>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th scope="col">Bucket</th>
              <th scope="col" className={num}>
                {report.type === 'cpu' ? 'Self time' : 'Self alloc'}
              </th>
              <th scope="col" className={num}>
                %
              </th>
              <th scope="col" className="w-[30%] min-w-[120px]">
                <span className="sr-only">Share</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {toRows(report).map((row) => {
              const isExpanded = expanded.has(row.name)
              return (
                <Fragment key={row.name}>
                  <tr>
                    <td>
                      {row.topFunctions.length > 0 ? (
                        <button
                          type="button"
                          className="inline-flex cursor-pointer items-center gap-1 text-left"
                          aria-expanded={isExpanded}
                          onClick={() => toggle(row.name)}
                        >
                          <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span> {row.name}
                        </button>
                      ) : (
                        row.name
                      )}
                    </td>
                    <td className={num}>{formatSelf(row.self)}</td>
                    <td className={num}>{row.percent.toFixed(1)}%</td>
                    <td>
                      <div
                        className="h-2.5 min-w-px rounded-r bg-primary"
                        style={{ width: `${Math.min(row.percent, 100)}%` }}
                        role="presentation"
                        data-testid="share-bar"
                      />
                    </td>
                  </tr>
                  {isExpanded
                    ? row.topFunctions.map((fn) => (
                        <tr key={`${row.name}:${fn.name}:${fn.url}`} className="border-0">
                          <td className="py-0.5 pl-8">
                            <code className="text-xs">{fn.name}</code>
                            <span className="block text-xs break-all text-base-content/60">
                              {fn.url}
                            </span>
                          </td>
                          <td className={`py-0.5 ${num}`}>{formatSelf(fn.self)}</td>
                          <td className="py-0.5" />
                          <td className="py-0.5" />
                        </tr>
                      ))
                    : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
