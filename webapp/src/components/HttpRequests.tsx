import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import type {
  HttpPathStats,
  HttpRequestsResponse,
  RecentHttpRequest,
} from '../../../src/shared/types'
import { formatBytes, formatDateTime, formatMillis } from '../format'

/**
 * Tabbed request log: the last 100 requests (query strings kept) and
 * cumulative per-path aggregates (query strings stripped). Sorting and
 * searching run client-side via the headless TanStack table.
 */

const PAGE_SIZE = 15

/** This plugin's own polling would otherwise dominate the latest-requests view. */
const SELF_PREFIXES = ['/plugins/signalk-performance-monitor', '/signalk-performance-monitor']

function isSelfRequest(path: string): boolean {
  return SELF_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/**
 * Numbered pager items: first, last, and current ±1, with 'gap' filling the
 * jumps (e.g. 1 … 4 [5] 6 … 21). Aggregate can reach 500 paths = 20 pages.
 */
function pageItems(current: number, count: number): (number | 'gap')[] {
  const pages = [...new Set([0, count - 1, current - 1, current, current + 1])]
    .filter((page) => page >= 0 && page < count)
    .sort((a, b) => a - b)
  const items: (number | 'gap')[] = []
  for (const [i, page] of pages.entries()) {
    if (i > 0 && page - pages[i - 1]! > 1) items.push('gap')
    items.push(page)
  }
  return items
}

/** Marks a column as right-aligned numeric via TanStack's free-form `meta`. */
const NUMERIC = { numeric: true }

function cellClass(meta: unknown): string | undefined {
  return (meta as typeof NUMERIC | undefined)?.numeric
    ? 'text-right tabular-nums whitespace-nowrap'
    : undefined
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
 * other methods and the synthetic "(other)" row stay plain text.
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

const recentColumns: ColumnDef<RecentHttpRequest>[] = [
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

/** Lets the parent's Download button read the current view without owning the table. */
type ExportRef = MutableRefObject<(() => unknown[]) | null>

interface RequestTableProps<T> {
  data: T[]
  columns: ColumnDef<T>[]
  initialSorting: SortingState
  globalFilter: string
  emptyMessage: string
  exportRef: ExportRef
}

function RequestTable<T>({
  data,
  columns,
  initialSorting,
  globalFilter,
  emptyMessage,
  exportRef,
}: RequestTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PAGE_SIZE })
  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    globalFilterFn: 'includesString',
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    // The 5s poll replaces `data` on every tick; snapping back to page 1
    // each time would make later pages unreadable.
    autoResetPageIndex: false,
  })

  // Jump back to the first page when the search or sort order changes…
  useEffect(() => {
    setPagination((current) => ({ ...current, pageIndex: 0 }))
  }, [globalFilter, sorting])

  // Keep the parent's Download button pointed at the current sorted+filtered
  // view (all pages); re-assigned every render so it never goes stale.
  useEffect(() => {
    exportRef.current = () => table.getPrePaginationRowModel().rows.map((row) => row.original)
  })

  // …and clamp to the last page when rows disappear from under us.
  const pageCount = table.getPageCount()
  useEffect(() => {
    if (pageCount > 0 && pagination.pageIndex >= pageCount) {
      setPagination((current) => ({ ...current, pageIndex: pageCount - 1 }))
    }
  }, [pageCount, pagination.pageIndex])

  const rows = table.getRowModel().rows
  if (rows.length === 0) {
    return <p className="text-sm text-base-content/60">{emptyMessage}</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const sorted = header.column.getIsSorted()
                return (
                  <th
                    key={header.id}
                    scope="col"
                    className={cellClass(header.column.columnDef.meta)}
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                  >
                    <button
                      type="button"
                      className="cursor-pointer whitespace-nowrap font-semibold hover:text-base-content"
                      onClick={header.column.getToggleSortingHandler()}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <span aria-hidden="true">
                        {sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className={cellClass(cell.column.columnDef.meta)}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {pageCount > 1 ? (
        <div className="mt-2 flex items-center justify-end gap-3">
          <span className="text-xs text-base-content/60">
            {table.getFilteredRowModel().rows.length.toLocaleString()} rows
          </span>
          <div className="join">
            <button
              type="button"
              className="btn join-item btn-xs"
              aria-label="Previous page"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              «
            </button>
            {pageItems(pagination.pageIndex, pageCount).map((item, index) =>
              item === 'gap' ? (
                <button
                  key={`gap-${index}`}
                  type="button"
                  className="btn join-item btn-xs"
                  disabled
                >
                  …
                </button>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={`btn join-item btn-xs ${item === pagination.pageIndex ? 'btn-active' : ''}`}
                  aria-label={`Page ${item + 1}`}
                  aria-current={item === pagination.pageIndex ? 'page' : undefined}
                  onClick={() => table.setPageIndex(item)}
                >
                  {item + 1}
                </button>
              ),
            )}
            <button
              type="button"
              className="btn join-item btn-xs"
              aria-label="Next page"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              »
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

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
    const rows = exportRef.current?.() ?? []
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    // Same filesystem-safe timestamp style as the stored profile ids.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    anchor.download = `http-requests-${tab === 'recent' ? 'latest' : 'aggregate'}-${stamp}.json`
    anchor.click()
    URL.revokeObjectURL(url)
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
              <RequestTable
                key="recent"
                data={recent}
                columns={recentColumns}
                initialSorting={[{ id: 'timestamp', desc: true }]}
                globalFilter={search}
                emptyMessage="No requests recorded yet."
                exportRef={exportRef}
              />
            ) : (
              <RequestTable
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
                ? 'The last 100 requests handled by the server (all consumers, not just this webapp). Size is the response Content-Length; streamed responses don’t declare one.'
                : 'Cumulative per path since the plugin started, query strings stripped; Duration and Size are per-request averages. Click a column header to sort.'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
