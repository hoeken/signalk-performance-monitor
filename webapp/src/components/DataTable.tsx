import { useEffect, useState, type MutableRefObject } from 'react'
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

/**
 * Shared sortable, searchable, paginated table on the headless TanStack
 * core — the machinery behind the HTTP request tables and the file activity
 * table, so every data table in the app behaves identically.
 */

const PAGE_SIZE = 15

/**
 * Numbered pager items: first, last, and current ±1, with 'gap' filling the
 * jumps (e.g. 1 … 4 [5] 6 … 21).
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
export const NUMERIC = { numeric: true }

/**
 * Marks the column that soaks up all remaining table width. The `max-w-0`
 * is the standard auto-layout trick that lets cell contents truncate
 * instead of stretching the column — contents must bring their own
 * `truncate`/`min-w-0`.
 */
export const EXPAND = { expand: true }

export function cellClass(meta: unknown): string | undefined {
  const flags = meta as { numeric?: boolean; expand?: boolean } | undefined
  if (flags?.numeric) return 'text-right tabular-nums whitespace-nowrap'
  if (flags?.expand) return 'w-full max-w-0'
  return undefined
}

/** Lets the parent's Download button read the current view without owning the table. */
export type ExportRef = MutableRefObject<(() => unknown[]) | null>

export interface DataTableProps<T> {
  data: T[]
  columns: ColumnDef<T>[]
  initialSorting: SortingState
  globalFilter: string
  emptyMessage: string
  exportRef: ExportRef
}

export function DataTable<T>({
  data,
  columns,
  initialSorting,
  globalFilter,
  emptyMessage,
  exportRef,
}: DataTableProps<T>) {
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
    // Polled consumers replace `data` on every tick; snapping back to page 1
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
                      className="cursor-pointer font-semibold whitespace-nowrap hover:text-base-content"
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

/** Serialize rows to a pretty JSON file and trigger a browser download. */
export function downloadJson(rows: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
