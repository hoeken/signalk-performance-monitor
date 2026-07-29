import { Fragment, useMemo, useRef, useState } from 'react'
import { type ColumnDef } from '@tanstack/react-table'
import type {
  HttpPathStats,
  HttpRequestsResponse,
  RecentHttpRequest,
} from '../../../src/shared/types'
import { DataTable, downloadJson, NUMERIC, type ExportRef } from './DataTable'
import { formatBytes, formatDateTime, formatMillis } from '../format'

/**
 * Tabbed request log: the last 200 requests (query strings kept, request
 * headers behind a per-row inspect toggle) and cumulative per-path
 * aggregates (query strings stripped). Sorting and searching run
 * client-side via the shared DataTable.
 */

/** This plugin's own polling would otherwise dominate the latest-requests view. */
const SELF_PREFIXES = ['/plugins/signalk-performance-monitor', '/signalk-performance-monitor']

function isSelfRequest(path: string): boolean {
  return SELF_PREFIXES.some((prefix) => path.startsWith(prefix))
}

function StatusCell({ statusCode }: { statusCode: number }) {
  return (
    <span className={statusCode >= 400 ? 'font-medium text-error' : undefined}>{statusCode}</span>
  )
}

/**
 * Duration heat scale, worst tier first; under 25 ms is green. The orange-red
 * step uses a fixed Tailwind orange since the theme has nothing between
 * warning and error.
 */
const DURATION_TIERS: [number, string][] = [
  [200, 'text-error'],
  [100, 'text-orange-600'],
  [50, 'text-warning'],
  [25, 'text-info'],
]

function DurationCell({ ms }: { ms: number }) {
  const tier = DURATION_TIERS.find(([threshold]) => ms > threshold)
  return (
    <span className={`font-medium ${tier ? tier[1] : 'text-success'}`}>{formatMillis(ms)}</span>
  )
}

/**
 * GET paths link to the live URL (a browser click repeats the same request);
 * other methods and non-path targets (e.g. `OPTIONS *`) stay plain text.
 * Long paths truncate with an ellipsis (full path in the tooltip) so a giant
 * query string can't stretch the row; `block` makes `truncate` effective.
 */
const PATH_CLASS = 'block max-w-md truncate font-mono text-xs'

function PathCell({ path, method }: { path: string; method: string }) {
  if (method !== 'GET' || !path.startsWith('/')) {
    return (
      <span className={PATH_CLASS} title={path}>
        {path}
      </span>
    )
  }
  return (
    <a className={`link ${PATH_CLASS}`} href={path} target="_blank" rel="noreferrer" title={path}>
      {path}
    </a>
  )
}

/** The expanded detail row: every request header, one per line. */
function RequestDetail({ request }: { request: RecentHttpRequest }) {
  const headers = Object.entries(request.requestHeaders ?? {})
  if (headers.length === 0) {
    return <p className="px-2 py-1 text-xs text-base-content/60">No request headers captured.</p>
  }
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 px-2 py-1 font-mono text-xs">
      {headers.map(([name, value]) => (
        <Fragment key={name}>
          <dt className="text-base-content/60">{name}</dt>
          <dd className="break-all">{value}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

/**
 * Identity for expansion state: polling replaces the data array every tick,
 * so index-based row ids would drift as new requests push rows down.
 */
function recentRowId(request: RecentHttpRequest): string {
  return `${request.timestamp} ${request.method} ${request.path} ${request.durationMs}`
}

const recentColumns: ColumnDef<RecentHttpRequest>[] = [
  {
    id: 'inspect',
    header: '',
    enableSorting: false,
    cell: ({ row }) => (
      <button
        type="button"
        className="btn btn-ghost btn-xs px-1"
        aria-label={`Inspect ${row.original.method} ${row.original.path}`}
        aria-expanded={row.getIsExpanded()}
        onClick={row.getToggleExpandedHandler()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
    ),
  },
  {
    accessorKey: 'timestamp',
    header: 'Time',
    cell: ({ row }) => (
      <span className="whitespace-nowrap">{formatDateTime(row.original.timestamp)}</span>
    ),
  },
  { accessorKey: 'method', header: 'Method' },
  {
    accessorKey: 'path',
    header: 'Path',
    cell: ({ row }) => <PathCell path={row.original.path} method={row.original.method} />,
  },
  {
    accessorKey: 'statusCode',
    header: 'Status',
    meta: NUMERIC,
    cell: ({ row }) => <StatusCell statusCode={row.original.statusCode} />,
  },
  {
    accessorKey: 'durationMs',
    header: 'Duration',
    meta: NUMERIC,
    cell: ({ row }) => <DurationCell ms={row.original.durationMs} />,
  },
  {
    accessorKey: 'responseBytes',
    header: 'Size',
    meta: NUMERIC,
    cell: ({ row }) =>
      row.original.responseBytes === undefined ? '—' : formatBytes(row.original.responseBytes),
  },
]

const aggregateColumns: ColumnDef<HttpPathStats>[] = [
  { accessorKey: 'method', header: 'Method' },
  {
    accessorKey: 'path',
    header: 'Path',
    cell: ({ row }) => <PathCell path={row.original.path} method={row.original.method} />,
  },
  {
    accessorKey: 'count',
    header: 'Requests',
    meta: NUMERIC,
    cell: ({ row }) => row.original.count.toLocaleString(),
  },
  {
    id: 'avgMs',
    accessorFn: (row) => (row.count > 0 ? row.totalMs / row.count : 0),
    header: 'Duration',
    meta: NUMERIC,
    cell: ({ row }) => (
      <DurationCell ms={row.original.count > 0 ? row.original.totalMs / row.original.count : 0} />
    ),
  },
  {
    id: 'avgBytes',
    accessorFn: (row) => (row.count > 0 ? row.totalBytes / row.count : 0),
    header: 'Size',
    meta: NUMERIC,
    cell: ({ row }) =>
      row.original.totalBytes > 0 ? formatBytes(row.original.totalBytes / row.original.count) : '—',
  },
  {
    accessorKey: 'errorCount',
    header: 'Errors',
    meta: NUMERIC,
    cell: ({ row }) =>
      row.original.errorCount > 0 ? (
        <span className="font-medium text-error">{row.original.errorCount.toLocaleString()}</span>
      ) : (
        '0'
      ),
  },
]

const TABS = [
  { id: 'recent', label: 'Latest' },
  { id: 'aggregate', label: 'Aggregate' },
] as const

type TabId = (typeof TABS)[number]['id']

export function HttpRequests({ data }: { data: HttpRequestsResponse | null }) {
  const [tab, setTab] = useState<TabId>('recent')
  const [search, setSearch] = useState('')
  const [hideSelf, setHideSelf] = useState(true)
  const exportRef: ExportRef = useRef(null)

  // The current view as shown: sorted, searched, self-filtered — but not paginated.
  const handleDownload = () => {
    // Same filesystem-safe timestamp style as the stored profile ids.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    downloadJson(
      exportRef.current?.() ?? [],
      `http-requests-${tab === 'recent' ? 'latest' : 'aggregate'}-${stamp}.json`,
    )
  }

  const recent = useMemo(
    () => (data?.recent ?? []).filter((entry) => !hideSelf || !isSelfRequest(entry.path)),
    [data, hideSelf],
  )
  const aggregate = useMemo(
    () => (data?.aggregate ?? []).filter((entry) => !hideSelf || !isSelfRequest(entry.path)),
    [data, hideSelf],
  )

  return (
    <div className="card border border-base-300 bg-base-100 shadow-sm">
      <div className="card-body gap-3 p-5">
        {data === null ? (
          <p className="text-sm text-base-content/60">Waiting for request data…</p>
        ) : (
          <>
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
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm"
                    checked={hideSelf}
                    onChange={(event) => setHideSelf(event.target.checked)}
                  />
                  Hide this plugin
                </label>
                <input
                  type="search"
                  className="input input-sm w-48"
                  placeholder="Search…"
                  aria-label="Search requests"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
            </div>
            {/* Keyed so each tab keeps its own sort/page state instead of inheriting the other's. */}
            {tab === 'recent' ? (
              <DataTable
                key="recent"
                data={recent}
                columns={recentColumns}
                initialSorting={[{ id: 'timestamp', desc: true }]}
                globalFilter={search}
                emptyMessage="No requests recorded yet."
                exportRef={exportRef}
                renderDetail={(request) => <RequestDetail request={request} />}
                getRowId={recentRowId}
              />
            ) : (
              <DataTable
                key="aggregate"
                data={aggregate}
                columns={aggregateColumns}
                initialSorting={[{ id: 'count', desc: true }]}
                globalFilter={search}
                emptyMessage="No requests recorded yet."
                exportRef={exportRef}
              />
            )}
            <p className="text-xs text-base-content/60">
              {tab === 'recent'
                ? 'The last 200 requests handled by the server (all consumers, not just this webapp). The magnifier expands a request’s headers. Size is the response Content-Length; streamed responses don’t declare one.'
                : 'Cumulative per path since the plugin started — query strings stripped, and resource requests (chart tiles, routes, …) grouped under their resource type. Duration and Size are per-request averages. Click a column header to sort.'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
