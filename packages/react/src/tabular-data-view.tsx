import { parseFilterValue } from './structured-data/filter-value.js'
import { compareJsonValues, matchesJsonValueFilter, jsonValueText } from '@script-it/json-views-core'
import { useJsonSourceLiterals } from './json/source-literals.js'
import { AddColumnHeader, ColumnHeaderMenu } from './structured-data/column-controls.js'
import { ValueCell } from './structured-data/value-cell.js'
import type { ColumnFilterConfig, ColumnFilterRule, SortConfig, SortDirection, TabularObjectArrayViewProps } from './structured-data/table-types.js'
export type { TabularObjectArrayViewProps } from './structured-data/table-types.js'
export { ExpandValueButton, ValueCell, ValueCellContent } from './structured-data/value-cell.js'
import { useViewerState } from './viewer-state.js'
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual'
import { File, Plus } from 'lucide-react'
import { UI_SIZE_SCALE } from './lib/ui-size.js'
import { Tooltip, TooltipContent, TooltipTrigger } from './primitives/tooltip.js'
import { cn } from './lib/cn.js'
import { Checkbox } from './primitives/checkbox.js'
import { StructuredCellFillContext } from './structured-data/structured-cell-fill-context.js'
import { DeleteSelectedRowsAction } from './structured-data/delete-row-action.js'
import { RowSelectionIcon } from './structured-data/row-selection-icon.js'
import { CopyJsonAction } from './structured-data/copy-json-action.js'
import { useJsonViewsDevice } from './browser-device.js'
import { StructuredValueCellFrame } from './structured-data/atomic-value-editor.js'
import { TabularDataCell } from './structured-data/tabular-data-cell.js'
import { TableCellOptionsContext, resolveTableCellOptions } from './structured-data/table-cell-options.js'
import { useDismiss } from './lib/use-dismiss.js'

const DEFAULT_COLUMN_WIDTH = 200
const MIN_COLUMN_WIDTH = 80
const MAX_CACHED_COLUMN_WIDTH = 4000
const MIN_VISIBLE_COLUMNS = 3
/** Row height at the small (100%) UI size; scaled by the active `UI_SIZE_SCALE`. */
const ROW_HEIGHT = 45
export const TABULAR_DATA_FRAME_CLASS = 'overflow-hidden border-y border-border bg-background'
function normalizeCollapsedColumns(
  hiddenColumns: readonly string[],
  allColumns: string[],
): Set<string> {
  const minimumVisibleColumns = Math.min(MIN_VISIBLE_COLUMNS, allColumns.length)
  const maxHiddenColumns = Math.max(0, allColumns.length - minimumVisibleColumns)
  const normalizedHiddenColumns = allColumns
    .filter((column) => hiddenColumns.includes(column))
    .slice(0, maxHiddenColumns)

  return new Set(normalizedHiddenColumns)
}

function normalizeColumnWidths(
  widths: Record<string, number> | undefined,
  columns: readonly string[],
): Record<string, number> {
  if (!widths) return {}
  return Object.fromEntries(columns.flatMap((column) => {
    const width = widths[column]
    return Number.isFinite(width) && width >= MIN_COLUMN_WIDTH
      ? [[column, Math.min(width, MAX_CACHED_COLUMN_WIDTH)]]
      : []
  }))
}

function restoreSort(sort: SortConfig | undefined, columns: readonly string[], stateKeys?: Readonly<Record<string, string>>): SortConfig {
  if (!sort || (sort.direction !== 'asc' && sort.direction !== 'desc')) return null
  const column = columns.find((candidate) => (stateKeys?.[candidate] ?? candidate) === sort.column)
  return column === undefined ? null : { column, direction: sort.direction }
}

function restoreCollapsedColumns(hidden: readonly string[], columns: string[], stateKeys?: Readonly<Record<string, string>>): Set<string> {
  return normalizeCollapsedColumns(columns.filter((column) => hidden.includes(stateKeys?.[column] ?? column)), columns)
}

function restoreFilters(
  filters: readonly { column: string; operator: string; value?: unknown }[] | undefined,
  columns: readonly string[],
  stateKeys?: Readonly<Record<string, string>>,
): ColumnFilterConfig[] {
  if (!filters) return []
  return filters.flatMap((filter): ColumnFilterConfig[] => {
    const column = columns.find((candidate) => (stateKeys?.[candidate] ?? candidate) === filter.column)
    return column && filter.operator.trim()
      ? [{ column, operator: filter.operator, ...(filter.value === undefined ? {} : { value: filter.value }) }]
      : []
  })
}

function primitiveFilterValue(value: string, sample: readonly unknown[]): unknown {
  const populated = sample.filter((item) => item !== undefined && item !== null)
  const kinds = new Set(populated.map((item) => typeof item))
  return parseFilterValue(value, kinds.size === 1 ? [...kinds][0] : undefined)
}

function parseColumnFilter(filter: ColumnFilterRule, sample: readonly unknown[]): ColumnFilterRule {
  if (filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty') return { operator: filter.operator }
  const text = typeof filter.value === 'string' ? filter.value : jsonValueText(filter.value ?? '')
  if (filter.operator === 'in' || filter.operator === 'notIn') {
    return {
      operator: filter.operator,
      value: text.split(',').map((value) => primitiveFilterValue(value.trim(), sample)).filter((value) => value !== ''),
    }
  }
  return { operator: filter.operator, value: primitiveFilterValue(text, sample) }
}

function filterValueSuggestions(values: readonly unknown[]): unknown[] {
  const suggestions = new Map<string, unknown>()
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue
    const key = `${typeof value}:${String(value)}`
    if (!suggestions.has(key)) suggestions.set(key, value)
    if (suggestions.size > 20) return []
  }
  return Array.from(suggestions.values())
}

export function TabularObjectArrayView({
  arr,
  rowKeys,
  getCellSourcePath,
  columns,
  columnLabels,
  columnStateKeys,
  filePath,
  viewStateKey,
  onOpenCell,
  onVisibleRowsChange,
  renderCell,
  recordNavigation,
  onAddRow,
  onDeleteRows,
  getRowsCopyText,
  getRowsReferenceText,
  rowAdditionDisabled = false,
  rowDeletionDisabled = false,
  initialCell,
  uiSize = 'small',
  fillHeight = false,
  presentationControls = true,
  activeColumnFilters,
  activeColumnSort,
  columnFilterOperators,
  columnFilterValues,
  onColumnFilter,
  onColumnSort,
  onColumnRename,
  onColumnHide,
  onColumnMove,
  onColumnDelete,
  onAddColumn,
}: TabularObjectArrayViewProps) {
  const numberAtPath = useJsonSourceLiterals()
  const { tables: tableState } = useViewerState()
  const compact = useJsonViewsDevice() === 'mobile'
  const cellOptions = resolveTableCellOptions(useContext(TableCellOptionsContext))
  // One selected cell at a time shows its whole value; any press outside it
  // (other than in a popup its editor opened) or Escape puts it back.
  const [revealedCell, setRevealedCell] = useState<{ row: VirtualItem['key']; column: string; height: number }>()
  const revealedCellRef = useRef<HTMLTableCellElement | null>(null)
  useDismiss({
    enabled: revealedCell !== undefined,
    insideRefs: [revealedCellRef],
    ignoreAnchoredPopups: true,
    onDismiss: () => setRevealedCell(undefined),
  })
  const cacheKey = JSON.stringify([filePath, viewStateKey])
  const savedTableState = filePath ? tableState.get(cacheKey) : undefined
  const columnLabel = (column: string) => columnLabels?.[column] ?? column
  const columnStateKey = (column: string) => columnStateKeys?.[column] ?? column
  const savedCollapsedColumns = presentationControls && filePath
    ? (savedTableState?.collapsedColumns ?? [])
    : []
  const [collapsedColumns, setLocalCollapsedColumns] = useState<Set<string>>(
    () => restoreCollapsedColumns(savedCollapsedColumns, columns, columnStateKeys)
  )
  const selectable = onDeleteRows !== undefined || getRowsCopyText !== undefined
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<number>>(() => new Set())
  const [rowAdditionError, setRowAdditionError] = useState<string>()
  // Selected indices address rows of the current source; any content change
  // may reshuffle them, so a new array drops the selection during render
  // (React's "reset state on prop change" pattern) before it can mis-target.
  const [seenArr, setSeenArr] = useState(arr)
  if (seenArr !== arr) {
    setSeenArr(arr)
    if (selectedRows.size > 0) setSelectedRows(new Set())
  }
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => normalizeColumnWidths(savedTableState?.columnWidths, columns.map(columnStateKey)),
  )
  const columnWidthsRef = useRef(columnWidths)
  const [dialogContainer, setDialogContainer] = useState<HTMLDivElement | null>(null)
  const [hiddenRowHeight, setHiddenRowHeight] = useState(0)
  const [draggedColumn, setDraggedColumn] = useState<string>()
  const [dropTarget, setDropTarget] = useState<{ column: string; position: 'before' | 'after' }>()
  const draggedColumnRef = useRef<string | undefined>(undefined)
  const resizeRef = useRef<{ col: string; startX: number; startWidth: number } | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  const hiddenRowRef = useRef<HTMLTableCellElement | null>(null)
  const saveTableState = useCallback((patch: Parameters<typeof tableState.set>[1]) => {
    if (!filePath) return
    tableState.set(cacheKey, { ...tableState.get(cacheKey), ...patch })
  }, [cacheKey, filePath, tableState])

  const onResizeStart = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const th = (e.target as HTMLElement).closest('th')
    if (!th) return

    resizeRef.current = {
      col,
      startX: e.clientX,
      startWidth: th.getBoundingClientRect().width,
    }

    let rafId: number | null = null

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return

      const newWidth = Math.max(
        MIN_COLUMN_WIDTH,
        resizeRef.current.startWidth + (ev.clientX - resizeRef.current.startX)
      )
      columnWidthsRef.current = { ...columnWidthsRef.current, [col]: newWidth }

      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        setColumnWidths(columnWidthsRef.current)
        rafId = null
      })
    }

    const onMouseUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      setColumnWidths(columnWidthsRef.current)
      saveTableState({ columnWidths: columnWidthsRef.current })
      resizeRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      resizeCleanupRef.current = null
    }

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    resizeCleanupRef.current = onMouseUp
  }, [saveTableState])

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.()
    }
  }, [])

  const columnsKey = JSON.stringify([columns, columnStateKeys])
  // Column contents, rather than the caller's array identity, define table state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableColumns = useMemo(() => columns, [columnsKey])

  useEffect(() => {
    setLocalCollapsedColumns(
      restoreCollapsedColumns(
        presentationControls && filePath ? (tableState.get(cacheKey)?.collapsedColumns ?? []) : [],
        stableColumns,
        columnStateKeys,
      )
    )
    const nextWidths = normalizeColumnWidths(filePath ? tableState.get(cacheKey)?.columnWidths : undefined, stableColumns.map(columnStateKey))
    columnWidthsRef.current = nextWidths
    setColumnWidths(nextWidths)
  }, [filePath, presentationControls, stableColumns, columnsKey, cacheKey, tableState])

  const visibleColumns = stableColumns.filter((col) => !collapsedColumns.has(col))
  const visibleTitleColumn = recordNavigation && visibleColumns.includes(recordNavigation.titleColumn)
    ? recordNavigation.titleColumn
    : undefined
  const controlColumn = visibleTitleColumn ?? visibleColumns[0]
  const hiddenColumns = stableColumns.filter((col) => collapsedColumns.has(col))

  useEffect(() => {
    const element = hiddenRowRef.current
    if (!element) {
      setHiddenRowHeight(0)
      return
    }

    const updateHeight = () => {
      setHiddenRowHeight(element.getBoundingClientRect().height)
    }

    updateHeight()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [hiddenColumns.length])

  const toggleColumn = (col: string) => {
    if (!presentationControls) return
    const next = new Set(collapsedColumns)
    if (next.has(col)) next.delete(col)
    else next.add(col)
    const normalized = normalizeCollapsedColumns(Array.from(next), stableColumns)
    setLocalCollapsedColumns(normalized)
    saveTableState({ collapsedColumns: Array.from(normalized, columnStateKey) })
  }

  const [sortConfig, setSortConfig] = useState<SortConfig>(() => (
    presentationControls ? restoreSort(savedTableState?.sort, columns, columnStateKeys) : null
  ))
  const [filterConfig, setFilterConfig] = useState<ColumnFilterConfig[]>(() => (
    presentationControls ? restoreFilters(savedTableState?.filters, columns, columnStateKeys) : []
  ))
  const effectiveSort = activeColumnSort === undefined ? sortConfig : activeColumnSort
  const effectiveFilters = activeColumnFilters === undefined ? filterConfig : activeColumnFilters
  const sortColumn = onColumnSort ?? (presentationControls ? (column: string, direction: SortDirection | null) => {
    const next = direction ? { column, direction } : null
    setSortConfig(next)
    saveTableState({ sort: direction ? { column: columnStateKey(column), direction } : null })
  } : undefined)
  const filterColumn = onColumnFilter ? (column: string, filter: ColumnFilterRule | null) => {
    const sample = (columnFilterValues?.[column] ?? arr.map((row) => row[column]))
    return onColumnFilter(column, filter ? parseColumnFilter(filter, sample) : null)
  } : presentationControls ? (column: string, filter: ColumnFilterRule | null) => {
    const sample = (columnFilterValues?.[column] ?? arr.map((row) => row[column]))
    const next = [
      ...filterConfig.filter((candidate) => candidate.column !== column),
      ...(filter ? [{ column, ...parseColumnFilter(filter, sample) }] : []),
    ]
    setSelectedRows(new Set())
    setFilterConfig(next)
    saveTableState({ filters: next.map((candidate) => ({
      ...candidate,
      column: columnStateKey(candidate.column),
    })) })
  } : undefined
  const hideColumn = onColumnHide ?? (presentationControls ? (column: string) => toggleColumn(column) : undefined)

  useEffect(() => {
    setSortConfig(presentationControls ? restoreSort(tableState.get(cacheKey)?.sort, stableColumns, columnStateKeys) : null)
    setFilterConfig(presentationControls ? restoreFilters(tableState.get(cacheKey)?.filters, stableColumns, columnStateKeys) : [])
  }, [cacheKey, presentationControls, stableColumns, columnsKey, tableState])

  const indexedData = useMemo(() => {
    return arr.map((item, i) => ({ item, originalIndex: i }))
  }, [arr])

  const filteredData = useMemo(() => {
    if (activeColumnFilters !== undefined || filterConfig.length === 0) return indexedData
    return indexedData.filter(({ item, originalIndex }) => filterConfig.every((filter) => matchesJsonValueFilter(Object.hasOwn(item, filter.column) ? item[filter.column] : undefined, filter.operator, filter.value, { numberAtPath, leftPath: getCellSourcePath?.(originalIndex, filter.column) })))
  }, [activeColumnFilters, filterConfig, indexedData, numberAtPath, getCellSourcePath])

  const sortedData = useMemo(() => {
    if (!sortConfig || activeColumnSort !== undefined) return filteredData

    const { column, direction } = sortConfig
    return [...filteredData].sort((a, b) => {
      const aVal = Object.hasOwn(a.item, column) ? a.item[column] : undefined
      const bVal = Object.hasOwn(b.item, column) ? b.item[column] : undefined

      if (aVal == null && bVal == null) return 0
      if (aVal == null) return 1
      if (bVal == null) return -1

      const cmp = compareJsonValues(aVal, bVal, { numberAtPath, leftPath: getCellSourcePath?.(a.originalIndex, column), rightPath: getCellSourcePath?.(b.originalIndex, column) })
      return direction === 'asc' ? cmp : -cmp
    })
  }, [activeColumnSort, filteredData, sortConfig, numberAtPath, getCellSourcePath])

  const hasActiveFilters = effectiveFilters.length > 0
  useEffect(() => {
    onVisibleRowsChange?.(sortedData.map(({ originalIndex }) => originalIndex), hasActiveFilters)
  }, [hasActiveFilters, onVisibleRowsChange, sortedData])

  // Compact widths are a presentation constraint, never persisted over the
  // user's desktop column sizes. Every column and the same editors remain.
  const visibleColumnWidths = visibleColumns.map((col) => compact
    ? Math.min(columnWidths[columnStateKey(col)] ?? DEFAULT_COLUMN_WIDTH, col === controlColumn ? 168 : 184)
    : columnWidths[columnStateKey(col)] ?? DEFAULT_COLUMN_WIDTH)
  const rowCountLabel = `${sortedData.length.toLocaleString()} ${sortedData.length === 1 ? 'row' : 'rows'} · ${stableColumns.length.toLocaleString()} ${stableColumns.length === 1 ? 'field' : 'fields'}`
  const canHideMoreColumns =
    visibleColumns.length > Math.min(MIN_VISIBLE_COLUMNS, stableColumns.length)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingScrollPosition = useRef<{ scrollLeft: number; scrollTop: number } | undefined>(undefined)
  const flushScrollPosition = useCallback(() => {
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
    scrollSaveTimer.current = undefined
    if (!pendingScrollPosition.current) return
    saveTableState(pendingScrollPosition.current)
    pendingScrollPosition.current = undefined
  }, [saveTableState])
  const saveScrollPosition = useCallback(() => {
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current)
    const element = scrollContainerRef.current
    if (!element) return
    pendingScrollPosition.current = { scrollLeft: element.scrollLeft, scrollTop: element.scrollTop }
    scrollSaveTimer.current = setTimeout(flushScrollPosition, 120)
  }, [flushScrollPosition])
  useEffect(() => {
    const element = scrollContainerRef.current
    if (!element || !filePath) return
    const saved = tableState.get(cacheKey)
    const frame = requestAnimationFrame(() => {
      element.scrollLeft = saved?.scrollLeft ?? 0
      element.scrollTop = saved?.scrollTop ?? 0
    })
    return () => cancelAnimationFrame(frame)
  }, [cacheKey, filePath, tableState])
  useEffect(() => {
    window.addEventListener('pagehide', flushScrollPosition, true)
    return () => {
      window.removeEventListener('pagehide', flushScrollPosition, true)
      flushScrollPosition()
    }
  }, [flushScrollPosition])
  // Rows hold rem-sized text, so their height must track the host's UI size.
  const rowHeight = Math.round((compact ? 60 : ROW_HEIGHT) * UI_SIZE_SCALE[uiSize])
  const rowVirtualizer = useVirtualizer({
    count: sortedData.length,
    getItemKey: (index) => rowKeys?.[sortedData[index].originalIndex] ?? sortedData[index].originalIndex,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  })

  useEffect(() => {
    rowVirtualizer.measure()
  }, [rowHeight, rowVirtualizer])

  const virtualItems = rowVirtualizer.getVirtualItems()
  const totalTableWidth = visibleColumnWidths.reduce((sum, width) => sum + width, 0) + (onAddColumn ? 180 : 0)
  const tableColumnCount = visibleColumns.length + (onAddColumn ? 1 : 0)

  const allSelected = selectable && sortedData.length > 0 && sortedData.every(({ originalIndex }) => selectedRows.has(originalIndex))
  const toggleAllRows = () => {
    setSelectedRows((previous) => {
      const next = new Set(previous)
      sortedData.forEach(({ originalIndex }) => {
        if (allSelected) next.delete(originalIndex)
        else next.add(originalIndex)
      })
      return next
    })
  }
  const toggleRow = (index: number) => {
    setSelectedRows((previous) => {
      const next = new Set(previous)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }
  const deleteSelectedRows = async () => {
    if (!onDeleteRows || selectedRows.size === 0) return
    await onDeleteRows(Array.from(selectedRows).sort((a, b) => b - a))
  }
  const selectedRowsInVisibleOrder = () => sortedData.flatMap(({ originalIndex }) => (
    selectedRows.has(originalIndex) ? [originalIndex] : []
  ))
  const addRow = async () => {
    if (!onAddRow) return
    setRowAdditionError(undefined)
    try {
      await onAddRow()
    } catch (error) {
      setRowAdditionError(error instanceof Error ? error.message : 'Could not add a row')
    }
  }

  const [highlightCell, setHighlightCell] = useState(initialCell ?? null)

  useEffect(() => {
    if (!initialCell) return
    rowVirtualizer.scrollToIndex(initialCell.row, { align: 'center' })
    // Scroll column into view
    const colIdx = visibleColumns.indexOf(initialCell.col)
    if (colIdx >= 0 && scrollContainerRef.current) {
      const left = visibleColumnWidths.slice(0, colIdx).reduce((sum, width) => sum + width, 0)
      scrollContainerRef.current.scrollLeft = Math.max(0, left - 50)
    }
    const timeout = setTimeout(() => setHighlightCell(null), 1500)
    return () => clearTimeout(timeout)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={setDialogContainer}
      data-id="tabular-data-dialog-host"
      className={cn(
        'relative isolate',
        fillHeight ? 'flex max-h-full min-h-0 flex-col gap-1' : 'mb-4',
      )}
      style={cellOptions.maxHeight === undefined ? undefined : { '--json-views-table-cell-max-height': cellOptions.maxHeight } as CSSProperties}
    >
      {compact && visibleColumns.length > 1 && <p className="json-views-table-hint">Swipe for more fields · tap a value to open or edit</p>}
      <div
        data-id="tabular-data-frame"
        className={cn(
          TABULAR_DATA_FRAME_CLASS,
          fillHeight && 'flex min-h-0 flex-col',
        )}
      >
        <div
          ref={scrollContainerRef}
          data-id="tabular-scroll-area"
          tabIndex={0}
          role="region"
          aria-label="Scrollable records"
          onScroll={saveScrollPosition}
          className={cn('overflow-auto overscroll-x-none', fillHeight && 'min-h-0')}
          style={fillHeight ? undefined : { maxHeight: 'min(600px, 70vh)' }}
        >
          {/* Data cells are zero-padding; the value frames inside supply the
              padding themselves so their hover wash covers the full cell. */}
          <StructuredCellFillContext.Provider value={true}>
          <table aria-label="JSON records" aria-rowcount={sortedData.length + (hiddenColumns.length > 0 ? 2 : 1)} aria-colcount={tableColumnCount} data-selection-active={selectable && selectedRows.size > 0} className="tabular-data-table w-full table-fixed border-separate border-spacing-0 text-sm" style={{ minWidth: totalTableWidth }}>
            <colgroup>
              {visibleColumns.map((col, index) => (
                <col key={col} style={{ width: visibleColumnWidths[index] }} />
              ))}
              {onAddColumn && <col style={{ width: 180 }} />}
            </colgroup>
            {/* Three stacking tiers, and they must stay in this order: the
                hidden-columns row (30) above the column headers (20) above
                everything a body row paints (unranked). Both header tiers have
                to clear the body, not just tie with it — a `<tbody>` element at
                an equal rank wins on DOM order and paints over the header while
                its row scrolls underneath. Keep body-row decorations out of the
                positioned stack rather than adding a fourth tier. The one
                exception is transient: a revealed cell (15) floats its value
                over later rows and still scrolls under both header tiers. */}
            <thead>
              {hiddenColumns.length > 0 && (
                <tr>
                  <th
                    ref={hiddenRowRef}
                    colSpan={Math.max(tableColumnCount, 1)}
                    className="sticky top-0 z-30 bg-background px-3 py-2 text-left font-normal"
                  >
                    <div className="flex w-full gap-1.5 overflow-x-auto overscroll-x-none whitespace-nowrap">
                      {hiddenColumns.map((col) => (
                        <Tooltip key={col}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => toggleColumn(col)}
                              className="shrink-0 rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                              aria-label={`Show column: ${columnLabel(col)}`}
                            >
                              {columnLabel(col)}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            Show column: {columnLabel(col)}
                          </TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </th>
                </tr>
              )}
              <tr>
                {visibleColumns.map((col, index) => {
                  const width = visibleColumnWidths[index]
                  return (
                    <th
                      key={col}
                      data-id="tabular-column-header"
                      data-column={col}
                      data-pinned={compact && col === controlColumn || undefined}
                      className={`relative sticky z-20 border-r border-b border-border bg-background p-0 text-left font-normal text-muted-foreground whitespace-nowrap last:border-r-0 ${onColumnMove ? 'cursor-grab active:cursor-grabbing' : ''} ${hiddenColumns.length > 0 ? 'border-t border-border' : ''} ${draggedColumn === col ? 'opacity-50' : ''} ${dropTarget?.column === col && dropTarget.position === 'before' ? 'border-l-2 border-l-primary' : ''} ${dropTarget?.column === col && dropTarget.position === 'after' ? 'border-r-2 border-r-primary' : ''}`}
                      style={{
                        top: hiddenColumns.length > 0 ? hiddenRowHeight : 0,
                        width,
                        minWidth: width,
                        maxWidth: width,
                      }}
                      onDragStart={(event) => {
                        if (!onColumnMove || (event.target as HTMLElement).closest('[role="separator"]')) {
                          event.preventDefault()
                          return
                        }
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('application/x-json-views-column', col)
                        draggedColumnRef.current = col
                        setDraggedColumn(col)
                      }}
                      onDragOver={(event) => {
                        const source = draggedColumnRef.current ?? draggedColumn
                        if (!onColumnMove || !source || source === col) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        const bounds = event.currentTarget.getBoundingClientRect()
                        const pointerX = Number.isFinite(event.clientX) ? event.clientX : bounds.left
                        setDropTarget({ column: col, position: pointerX <= bounds.left + bounds.width / 2 ? 'before' : 'after' })
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget === event.target) setDropTarget((current) => current?.column === col ? undefined : current)
                      }}
                      onDragEnd={() => {
                        draggedColumnRef.current = undefined
                        setDraggedColumn(undefined)
                        setDropTarget(undefined)
                      }}
                      onDrop={(event) => {
                        const source = draggedColumnRef.current ?? draggedColumn ?? event.dataTransfer.getData('application/x-json-views-column')
                        if (!onColumnMove || !source || source === col) return
                        event.preventDefault()
                        const bounds = event.currentTarget.getBoundingClientRect()
                        const pointerX = Number.isFinite(event.clientX) ? event.clientX : bounds.left
                        const position = dropTarget?.column === col
                          ? dropTarget.position
                          : pointerX <= bounds.left + bounds.width / 2 ? 'before' : 'after'
                        void onColumnMove(source, col, position)
                        draggedColumnRef.current = undefined
                        setDraggedColumn(undefined)
                        setDropTarget(undefined)
                      }}
                    >
                      <div className="flex items-center">
                        {col === controlColumn && selectable && (
                          <span className="ml-3 flex h-3.5 w-3.5 shrink-0 items-center" data-id="tabular-select-all-slot">
                            <Checkbox
                              aria-label={allSelected ? 'Deselect all rows' : 'Select all rows'}
                              className="tabular-selection-checkbox h-3.5 w-3.5 border-muted-foreground"
                              data-id="tabular-select-all-rows"
                              checked={allSelected ? true : selectedRows.size > 0 ? 'indeterminate' : false}
                              disabled={rowDeletionDisabled || sortedData.length === 0}
                              onCheckedChange={toggleAllRows}
                            />
                          </span>
                        )}
                        <div className={cn('min-w-0 flex-1', col === controlColumn && selectable && '[&>button]:pl-1.5')}>
                          <ColumnHeaderMenu
                            activeFilter={effectiveFilters.find((filter) => filter.column === col)}
                            activeSort={effectiveSort}
                            canHide={onColumnHide ? visibleColumns.length > 1 : canHideMoreColumns}
                            column={col}
                            draggable={onColumnMove !== undefined}
                            dragging={draggedColumn === col}
                            filterOperators={columnFilterOperators?.[col]}
                            filterValues={filterValueSuggestions(columnFilterValues?.[col] ?? arr.map((row) => row[col]))}
                            label={columnLabel(col)}
                            onFilter={filterColumn}
                            onHide={hideColumn}
                            onDelete={onColumnDelete && columns.length > 1 ? onColumnDelete : undefined}
                            onMoveFirst={onColumnMove && index > 0
                              ? () => onColumnMove(col, visibleColumns[0], 'before')
                              : undefined}
                            onRename={onColumnRename}
                            onSort={sortColumn}
                          />
                        </div>
                      </div>
                      <div
                        role="separator"
                        tabIndex={0}
                        aria-label={`Resize ${columnLabel(col)} column`}
                        aria-orientation="vertical"
                        aria-valuemin={MIN_COLUMN_WIDTH}
                        aria-valuenow={Math.round(width)}
                        className="absolute bottom-0 right-0 top-0 w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 focus-visible:bg-primary/40 focus-visible:outline-none"
                        onMouseDown={(e) => onResizeStart(columnStateKey(col), e)}
                        onKeyDown={(event) => {
                          if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
                          event.preventDefault()
                          event.stopPropagation()
                          const next = event.key === 'Home' ? MIN_COLUMN_WIDTH : Math.max(MIN_COLUMN_WIDTH, width + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10))
                          const widths = { ...columnWidthsRef.current, [columnStateKey(col)]: next }
                          columnWidthsRef.current = widths
                          setColumnWidths(widths)
                          saveTableState({ columnWidths: widths })
                        }}
                      />
                    </th>
                  )
                })}
                {onAddColumn && <th className="sticky z-20 border-b border-border bg-background p-0 text-left font-normal" style={{ top: hiddenColumns.length > 0 ? hiddenRowHeight : 0, width: 180 }}><AddColumnHeader onAdd={onAddColumn} /></th>}
              </tr>
            </thead>
            <tbody>
              {visibleColumns.length === 0 ? (
                <tr>
                  <td className="px-3 py-4 text-sm italic text-muted-foreground">All columns are hidden</td>
                </tr>
              ) : (
                <>
                  {virtualItems.length > 0 && (
                    <tr style={{ height: virtualItems[0].start }} aria-hidden>
                      <td colSpan={tableColumnCount} className="border-0 p-0" />
                    </tr>
                  )}
                  {virtualItems.map((virtualRow) => {
                    const { item, originalIndex } = sortedData[virtualRow.index]
                    const isLastRow = virtualRow.index === sortedData.length - 1
                    const rowControl = <RowSelectionIcon
                      icon={visibleTitleColumn ? <File aria-hidden data-id="jsonView-row-page-icon" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      checked={selectedRows.has(originalIndex)}
                      disabled={rowDeletionDisabled}
                      label={`Select row ${originalIndex + 1}`}
                      onToggle={selectable ? () => toggleRow(originalIndex) : undefined}
                    />
                    return (
                      <tr
                        key={virtualRow.key}
                        ref={rowVirtualizer.measureElement}
                        data-index={virtualRow.index}
                        aria-rowindex={virtualRow.index + (hiddenColumns.length > 0 ? 3 : 2)}
                        aria-selected={selectable ? selectedRows.has(originalIndex) : undefined}
                        className="group bg-background hover:bg-accent/40"
                      >
                        {visibleColumns.map((col, colIdx) => {
                          const hasKey = Object.prototype.hasOwnProperty.call(item, col)
                          const width = visibleColumnWidths[colIdx]
                          const value = hasKey ? item[col] : undefined
                          const cellContent = (() => {
                            if (recordNavigation && col === visibleTitleColumn) {
                              return (
                                <StructuredValueCellFrame
                                  leading={rowControl}
                                  actions={<button type="button" data-id="tabular-open-record" aria-label={`Open record ${recordNavigation.getLabel(originalIndex)}`} className="cursor-pointer opacity-0 group-hover/structured-cell:opacity-100 group-focus-within/structured-cell:opacity-100 transition-opacity [@media(hover:none)]:opacity-100 h-6 rounded-sm border border-border bg-background px-2 text-[0.625rem] font-medium tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => recordNavigation.onOpen(originalIndex)}>OPEN</button>}
                                  activationLabel={`Open ${recordNavigation.getLabel(originalIndex)}`}
                                  className="cursor-pointer [&_[data-id=atomic-edit-value]]:cursor-pointer"
                                  onActivate={() => recordNavigation.onOpen(originalIndex)}
                                >
                                  <span className="flex min-w-0 items-center font-medium">
                                    {recordNavigation.renderTitle({ value, rowIndex: originalIndex, column: col })}
                                  </span>
                                </StructuredValueCellFrame>
                              )
                            }
                            if (!hasKey) return <span className="block px-3 py-2 italic text-muted-foreground">—</span>
                            const openCell = () => onOpenCell({
                              value,
                              rowIndex: originalIndex,
                              column: col,
                            })
                            return renderCell
                              ? renderCell({ value, rowIndex: originalIndex, column: col, open: openCell })
                              : <ValueCell value={value} onOpen={openCell} />
                          })()
                          // The title cell's click opens its record, which
                          // already shows the whole value.
                          const revealable = cellOptions.reveal && col !== visibleTitleColumn
                          const revealedHeight = revealable && revealedCell?.row === virtualRow.key && revealedCell.column === col
                            ? revealedCell.height
                            : undefined
                          return (
                            <TabularDataCell
                              key={col}
                              cellRef={revealedHeight === undefined ? undefined : revealedCellRef}
                              clamped={cellOptions.clamp}
                              pinned={compact && col === controlColumn}
                              revealedHeight={revealedHeight}
                              onReveal={revealable ? (height) => setRevealedCell({ row: virtualRow.key, column: col, height }) : undefined}
                              className={`tabular-data-cell border-r border-border p-0 last:border-r-0 ${isLastRow ? '' : 'border-b border-border'} ${highlightCell?.row === originalIndex && highlightCell?.col === col ? 'animate-[highlight-fade_1.5s_ease-out]' : ''}`}
                              style={{ width, minWidth: width, maxWidth: width }}
                            >
                              {col === controlColumn && col !== visibleTitleColumn && selectable ? <div className="relative h-full pl-5">
                                <span className="absolute inset-y-0 left-3 z-10 flex items-center">{rowControl}</span>
                                {cellContent}
                              </div> : cellContent}
                            </TabularDataCell>
                          )
                        })}
                        {onAddColumn && <td aria-hidden className={`${isLastRow ? '' : 'border-b border-border'} p-0`} />}
                      </tr>
                    )
                  })}
                  {virtualItems.length > 0 && (
                    <tr
                      style={{
                        height:
                          rowVirtualizer.getTotalSize() -
                          virtualItems[virtualItems.length - 1].end,
                      }}
                      aria-hidden
                    >
                      <td colSpan={tableColumnCount} className="border-0 p-0" />
                    </tr>
                  )}
                </>
              )}
            </tbody>
          </table>
          </StructuredCellFillContext.Provider>
        </div>
      </div>
      <div
        data-id="tabular-footer"
        className={cn(
          'flex min-h-7 items-center gap-2 pt-1 text-xs text-muted-foreground',
          fillHeight && 'shrink-0',
        )}
      >
        {onAddRow && selectedRows.size === 0 && (
          <button
            type="button"
            data-id="tabular-add-row"
            disabled={rowAdditionDisabled}
            className="flex h-6 items-center gap-1 rounded-md px-3 font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
            onClick={() => { void addRow() }}
          >
            <Plus className="h-3.5 w-3.5" /> Add row
          </button>
        )}
        {selectedRows.size === 0 && rowAdditionError && <span role="alert" className="text-destructive">{rowAdditionError}</span>}
        {selectable && selectedRows.size > 0 && (
          <div data-id="tabular-selection-bar" className="flex items-center gap-1">
            <button
              type="button"
              data-id="tabular-clear-selection"
              aria-label={`Clear ${selectedRows.size.toLocaleString()} selected ${selectedRows.size === 1 ? 'row' : 'rows'}`}
              title="Clear selection"
              className="flex h-6 items-center rounded-md px-1 font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setSelectedRows(new Set())}
            >
              {selectedRows.size.toLocaleString()} selected
            </button>
            {onDeleteRows && (
              <DeleteSelectedRowsAction
                count={selectedRows.size}
                disabled={rowDeletionDisabled}
                portalContainer={dialogContainer}
                onDelete={deleteSelectedRows}
              />
            )}
            {getRowsCopyText && getRowsReferenceText && (
              <CopyJsonAction
                key={Array.from(selectedRows).join(',')}
                dataId="structured-data-copy-selected-rows"
                getPathText={() => getRowsReferenceText(selectedRowsInVisibleOrder())}
                getRecordText={() => getRowsCopyText(selectedRowsInVisibleOrder())}
                label="Copy paths"
                pathLabel="paths"
                recordLabel="records"
                tone="strong"
              />
            )}
          </div>
        )}
        <span className="ml-auto">{rowCountLabel}</span>
      </div>
    </div>
  )
}
