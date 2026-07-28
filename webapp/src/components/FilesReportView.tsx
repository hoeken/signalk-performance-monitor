import { useMemo, useRef, useState } from 'react'
import { type ColumnDef } from '@tanstack/react-table'
import type { FileActivityFile, FilesReport } from '../../../src/shared/types'
import { DataTable, downloadJson, NUMERIC, type ExportRef } from './DataTable'
import { formatBytes, formatBytesRate, formatDateTime } from '../format'

const num = 'text-right tabular-nums whitespace-nowrap'

function PathCell({ path }: { path: string }) {
  return <code className="text-xs break-all">{path}</code>
}

/** Copies the full file path; shows a checkmark briefly after copying. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs shrink-0 px-1"
      aria-label="Copy file path"
      title={copied ? 'Copied' : 'Copy full path'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="h-3.5 w-3.5"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        {copied ? (
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        ) : (
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 4h8a2 2 0 012 2v8a2 2 0 01-2 2h-8a2 2 0 01-2-2v-8a2 2 0 012-2z"
          />
        )}
      </svg>
    </button>
  )
}

/**
 * Truncating path cell for the sortable table: a copy button holding the
 * full path, then the path with the config root trimmed (full path in the
 * tooltip).
 */
function FilePathCell({ path, display }: { path: string; display: string }) {
  return (
    <span className="flex items-center gap-1">
      <CopyButton text={path} />
      <span className="block max-w-xs truncate font-mono text-xs" title={path}>
        {display}
      </span>
    </span>
  )
}

function makeFileColumns(dataRoot: string | undefined): ColumnDef<FileActivityFile>[] {
  const display = (filePath: string) =>
    dataRoot && filePath.startsWith(`${dataRoot}/`) ? filePath.slice(dataRoot.length + 1) : filePath
  return [
    {
      accessorKey: 'path',
      header: 'File',
      cell: ({ row }) => (
        <FilePathCell path={row.original.path} display={display(row.original.path)} />
      ),
    },
    { accessorKey: 'bucket', header: 'Bucket' },
    { accessorKey: 'mode', header: 'Mode' },
    { accessorKey: 'kind', header: 'Kind' },
    {
      accessorKey: 'sizeBytes',
      header: 'Size',
      meta: NUMERIC,
      cell: ({ row }) => formatBytes(row.original.sizeBytes),
    },
    {
      accessorKey: 'growthBytes',
      header: 'Growth',
      meta: NUMERIC,
      cell: ({ row }) =>
        row.original.growthBytes > 0 ? formatBytes(row.original.growthBytes) : '—',
    },
    {
      accessorKey: 'mtimeChanges',
      header: 'Changes',
      meta: NUMERIC,
      cell: ({ row }) => (row.original.mtimeChanges > 0 ? row.original.mtimeChanges : '—'),
    },
    {
      accessorKey: 'inPlaceRewrites',
      header: 'In-place',
      meta: NUMERIC,
      cell: ({ row }) => (row.original.inPlaceRewrites > 0 ? row.original.inPlaceRewrites : '—'),
    },
  ]
}

function Summary({ report }: { report: FilesReport }) {
  const activeFiles = report.files.filter(
    (file) => file.growthBytes > 0 || file.mtimeChanges > 0 || file.inPlaceRewrites > 0,
  )
  const idleFiles = report.files.length - activeFiles.length

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        The process wrote <strong>{formatBytes(report.totals.writeBytes)}</strong> to storage (
        {formatBytesRate(report.totals.writeBytesPerSecond)}) and read{' '}
        <strong>{formatBytes(report.totals.readBytes)}</strong> (
        {formatBytesRate(report.totals.readBytesPerSecond)}) during the capture, as counted by the
        kernel.
      </p>

      <div>
        <h3 className="mb-1 text-sm font-semibold">Write attribution</h3>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th scope="col">Bucket</th>
                <th scope="col" className={num}>
                  Est. writes
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
              {report.attribution.map((row) => (
                <tr key={row.name}>
                  <td
                    className={row.name === '(unattributed)' ? 'text-base-content/60' : undefined}
                  >
                    {row.name}
                  </td>
                  <td className={num}>{formatBytes(row.estimatedWriteBytes)}</td>
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
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-base-content/50">
          Per-file estimates (WAL frames, size growth) against the kernel total; the{' '}
          <code>(unattributed)</code> row is what the model can&apos;t explain — fsync
          amplification, filesystem metadata, or writers that closed before being seen. The
          Individual Files tab lists everything that was watched.
        </p>
      </div>

      {report.databases.length > 0 ? (
        <div>
          <h3 className="mb-1 text-sm font-semibold">SQLite databases</h3>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              <thead>
                <tr>
                  <th scope="col">Database</th>
                  <th scope="col">Bucket</th>
                  <th scope="col" className={num}>
                    Commits/s
                  </th>
                  <th scope="col" className={num}>
                    WAL frames
                  </th>
                  <th scope="col" className={num}>
                    Checkpoints
                  </th>
                  <th scope="col" className={num}>
                    Est. writes
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.databases.map((db) => (
                  <tr key={db.path}>
                    <td>
                      <PathCell path={db.path} />
                      {db.notes.map((note) => (
                        <span key={note} className="block text-xs text-warning">
                          {note}
                        </span>
                      ))}
                    </td>
                    <td className="whitespace-nowrap">{db.bucket}</td>
                    <td className={num}>{db.commitsPerSecond.toFixed(2)}</td>
                    <td className={num}>{db.framesWritten.toLocaleString()}</td>
                    <td className={num}>{db.checkpoints}</td>
                    <td className={num}>{formatBytes(db.estimatedWriteBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs text-base-content/50">
            Read passively from each database&apos;s WAL-index (<code>-shm</code>) header — commits
            and WAL frames per capture, without touching the database itself.
          </p>
        </div>
      ) : null}

      <div>
        <h3 className="mb-1 text-sm font-semibold">Open files</h3>
        {activeFiles.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No file changed during the capture ({report.files.length} open files watched).
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Bucket</th>
                    <th scope="col">Mode</th>
                    <th scope="col" className={num}>
                      Size
                    </th>
                    <th scope="col" className={num}>
                      Growth
                    </th>
                    <th scope="col" className={num}>
                      Changes
                    </th>
                    <th scope="col" className={num}>
                      In-place
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {activeFiles.map((file) => (
                    <tr key={file.path}>
                      <td>
                        <PathCell path={file.path} />
                      </td>
                      <td className="whitespace-nowrap">{file.bucket}</td>
                      <td className="whitespace-nowrap">
                        {file.mode}
                        {file.kind !== 'file' ? ` · ${file.kind}` : ''}
                      </td>
                      <td className={num}>{formatBytes(file.sizeBytes)}</td>
                      <td className={num}>{formatBytes(file.growthBytes)}</td>
                      <td className={num}>{file.mtimeChanges}</td>
                      <td className={num}>{file.inPlaceRewrites}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-base-content/50">
              Changes counts samples where the file&apos;s mtime advanced; In-place counts those
              with no size change — the signature of in-place rewrites like a wrapped SQLite WAL.
              {idleFiles > 0
                ? ` ${idleFiles} more open files saw no changes — see the Individual Files tab.`
                : ''}
            </p>
          </>
        )}
      </div>
    </div>
  )
}

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'files', label: 'Individual Files' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * Renders a file activity report in two tabs: the aggregated summary
 * (process totals, per-plugin write attribution with the honesty-check
 * unattributed row, SQLite databases, changed files) and a sortable,
 * searchable table of every watched file with all of its stats.
 */
export function FilesReportView({ report }: { report: FilesReport }) {
  const [tab, setTab] = useState<TabId>('summary')
  const [search, setSearch] = useState('')
  const [hideReadonly, setHideReadonly] = useState(true)
  const exportRef: ExportRef = useRef(null)

  const columns = useMemo(() => makeFileColumns(report.dataRoot), [report.dataRoot])
  const visibleFiles = useMemo(
    () => (hideReadonly ? report.files.filter((file) => file.mode !== 'read') : report.files),
    [report.files, hideReadonly],
  )

  // Summary downloads the whole report; Individual Files downloads the
  // current view (sorted, searched, readonly-filtered — all pages).
  const handleDownload = () => {
    if (tab === 'summary') {
      downloadJson(report, `${report.id}.report.json`)
    } else {
      downloadJson(exportRef.current?.() ?? [], `${report.id}.files.json`)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-base-content/60">
        File activity profile · {formatDateTime(report.capturedAt)} ·{' '}
        {Math.round(report.durationMs / 1000)}s · sampled every {report.sampleIntervalSeconds}s (
        {report.sampleCount} samples)
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" className="tabs tabs-border">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={`tab ${tab === id ? 'tab-active' : ''}`}
                aria-selected={tab === id}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-sm btn-success btn-outline"
            onClick={handleDownload}
          >
            Download
          </button>
        </div>
        {tab === 'files' ? (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={hideReadonly}
                onChange={(event) => setHideReadonly(event.target.checked)}
              />
              Hide readonly files
            </label>
            <input
              type="search"
              className="input input-sm w-48"
              placeholder="Search…"
              aria-label="Search files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        ) : null}
      </div>

      {tab === 'summary' ? (
        <Summary report={report} />
      ) : (
        <>
          <DataTable
            data={visibleFiles}
            columns={columns}
            initialSorting={[{ id: 'growthBytes', desc: true }]}
            globalFilter={search}
            emptyMessage="No open files match the current filters."
            exportRef={exportRef}
          />
          <p className="text-xs text-base-content/60">
            Every regular file the server had open during the capture, including unchanged ones —
            untick &quot;Hide readonly files&quot; to include files only open for reading. Paths are
            shown relative to the Signal K data directory; the copy button copies the full path.
            Growth sums size increases across samples; Changes counts samples where the mtime
            advanced; In-place counts mtime changes with no size change. Click a column header to
            sort.
          </p>
        </>
      )}
    </div>
  )
}
