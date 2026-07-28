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

  return (
    <div className="report">
      <p className="report-meta">
        {report.type === 'cpu' ? 'CPU profile' : 'Allocation profile'} ·{' '}
        {formatDateTime(report.capturedAt)} · {Math.round(report.durationMs / 1000)}s
        {report.type === 'cpu'
          ? ` · sampled every ${report.samplingIntervalUs} µs`
          : ` · sampled every ${formatBytes(report.samplingIntervalBytes)}`}
      </p>
      <table className="report-table">
        <thead>
          <tr>
            <th scope="col">Bucket</th>
            <th scope="col" className="num">
              {report.type === 'cpu' ? 'Self time' : 'Self alloc'}
            </th>
            <th scope="col" className="num">
              %
            </th>
            <th scope="col" className="bar-col">
              <span className="visually-hidden">Share</span>
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
                        className="expander"
                        aria-expanded={isExpanded}
                        onClick={() => toggle(row.name)}
                      >
                        <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span> {row.name}
                      </button>
                    ) : (
                      row.name
                    )}
                  </td>
                  <td className="num">{formatSelf(row.self)}</td>
                  <td className="num">{row.percent.toFixed(1)}%</td>
                  <td className="bar-col">
                    <div
                      className="bar"
                      style={{ width: `${Math.min(row.percent, 100)}%` }}
                      role="presentation"
                    />
                  </td>
                </tr>
                {isExpanded
                  ? row.topFunctions.map((fn) => (
                      <tr key={`${row.name}:${fn.name}:${fn.url}`} className="fn-row">
                        <td className="fn-name">
                          <code>{fn.name}</code>
                          <span className="fn-url">{fn.url}</span>
                        </td>
                        <td className="num">{formatSelf(fn.self)}</td>
                        <td className="num" />
                        <td className="bar-col" />
                      </tr>
                    ))
                  : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
