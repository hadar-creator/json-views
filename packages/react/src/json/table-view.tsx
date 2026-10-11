import { isLongText } from './long-text.js'
import { useJsonSourceLiterals } from './source-literals.js'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useJsonViewsRegistries } from '../widget-registry.js'
import type { UiSize } from '../lib/ui-size.js'
import { AtomicValueEditor } from '../structured-data/atomic-value-editor.js'
import { isEditableAtomicValue } from '../structured-data/atomic-value.js'
import { TabularObjectArrayView, ValueCell, ValueCellContent } from '../tabular-data-view.js'
import { type ValuePath } from '@script-it/json-views-core'
import { JSON_VIEW_PATH_MISSING, resolveJsonViewRowPath, schemaForJsonViewPath, type CompiledJsonViewMetadata, type CompiledJsonViewView } from '@script-it/json-views-core'
import { JsonViewSchemaValueCell, JsonViewSchemaValueDisplay, withColumnOptionColors, type JsonViewSchemaExternalWidgetRenderer } from './schema-value.js'
import { projectJsonViewCollection } from '@script-it/json-views-core'
import { GeneralJsonView } from './viewers/general/general-json-view.js'
import { type JsonViewJsonEditing, type JsonViewerProps } from './view-types.js'
import { matchesSearch, titleForRow, titleFieldForRow, rowAtSourcePath, sameJsonViewPath } from './view-model.js'
import { blankRow, removalOrder, rowFieldPath } from './row-mutations.js'
import { GeneralRecordView, RecordView } from './record-view.js'
import { jsonRowsCopyText, jsonRowsReferenceText } from './copy-json.js'
import type { ColumnFilterOperatorOption, ColumnFilterRule } from '../structured-data/table-types.js'

const FILTER_OPERATORS: readonly ColumnFilterOperatorOption[] = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'in', label: 'is any of' },
  { value: 'notIn', label: 'is none of' },
  { value: 'gt', label: 'is greater than' },
  { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' },
  { value: 'lte', label: 'is at most' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
]

const DATE_FILTER_OPERATORS: readonly ColumnFilterOperatorOption[] = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'lt', label: 'is before' },
  { value: 'lte', label: 'is on or before' },
  { value: 'gt', label: 'is after' },
  { value: 'gte', label: 'is on or after' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
]

export function ProjectedTableView({
  compiled,
  editing,
  filePath,
  copyFileName,
  fillHeight,
  onSaveView,
  onCurrentPathChange,
  query,
  rawView,
  renderExternalWidget,
  renderMarkdown,
  uiSize,
  view,
}: {
  compiled: CompiledJsonViewMetadata
  editing?: JsonViewJsonEditing
  filePath?: string
  copyFileName: string
  fillHeight: boolean
  onSaveView?: (value: Record<string, unknown>) => Promise<void>
  onCurrentPathChange?: JsonViewerProps['onCurrentPathChange']
  query: string
  rawView?: Record<string, unknown>
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  renderMarkdown?: (content: string) => ReactNode
  uiSize?: UiSize
  view: CompiledJsonViewView
}) {
  const { types } = useJsonViewsRegistries()
  const sourceLiteral = useJsonSourceLiterals()
  const [editPath, setEditPath] = useState<ValuePath>()
  const [openRowPath, setOpenRowPath] = useState<ValuePath>()
  const [openCell, setOpenCell] = useState<{ fieldLabel: string; path: ValuePath; rowLabel: string }>()
  const completeProjection = useMemo(() => projectJsonViewCollection(compiled.root, view, compiled.schema, types, sourceLiteral), [compiled.root, compiled.schema, view, types, types.version, sourceLiteral])
  // Without a filter, the complete projection already is the unfiltered one.
  const unfilteredProjection = useMemo(() => view.filter
    ? projectJsonViewCollection(compiled.root, { ...view, filter: undefined }, compiled.schema, types, sourceLiteral)
    : completeProjection, [compiled.root, compiled.schema, completeProjection, view, types, types.version, sourceLiteral])
  // The first record with a schema match decides each column's descriptor. This
  // does not depend on the search query, unlike the rest of the table model.
  const columnDescriptors = useMemo(() => Object.fromEntries(completeProjection.columns.map((column) => {
    for (const row of unfilteredProjection.rows) {
      const schema = schemaForJsonViewPath(compiled.schema, resolveJsonViewRowPath(compiled.root, row, column.path).sourcePath)
      if (schema) return [column.id, schema.descriptor]
    }
    return [column.id, compiled.schema.find((schema) => sameJsonViewPath(schema.path, column.path))?.descriptor]
  })), [compiled.root, compiled.schema, completeProjection.columns, unfilteredProjection])
  const projected = useMemo(() => {
    const indices = completeProjection.rows.flatMap((row, index) => matchesSearch(row.value, query) ? [index] : [])
    return {
      columns: completeProjection.columns,
      rows: indices.map((index) => completeProjection.rows[index]),
      records: indices.map((index) => completeProjection.records[index]),
    }
  }, [completeProjection, query])
  const tableModel = useMemo(() => {
    const visibleColumns = [...completeProjection.columns]
    const fieldOccurrences = new Map<string, number>()
    const stateKeys = Object.fromEntries(visibleColumns.map((column) => {
      const field = JSON.stringify(column.path.segments)
      const occurrence = fieldOccurrences.get(field) ?? 0
      fieldOccurrences.set(field, occurrence + 1)
      return [column.id, JSON.stringify([field, occurrence])]
    }))
    const columnFilterOperators = Object.fromEntries(visibleColumns.map((column) => {
      const descriptor = columnDescriptors[column.id]
      const defaults = descriptor?.type === 'date' ? DATE_FILTER_OPERATORS : FILTER_OPERATORS
      const declared = descriptor ? types.filterOperators(descriptor) : undefined
      return [column.id, declared ? [
        ...defaults.filter((operator) => declared.includes(operator.value)),
        ...declared.filter((value) => !defaults.some((operator) => operator.value === value)).map((value) => ({ value, label: value })),
      ] : defaults]
    }))
    return {
      visibleColumns,
      records: projected.records.map((record) => Object.fromEntries(visibleColumns.flatMap((column) => column.id in record ? [[column.id, record[column.id]]] : []))),
      labels: Object.fromEntries(visibleColumns.map((column) => [column.id, column.label])),
      stateKeys,
      columnFilterOperators,
      columnFilterValues: Object.fromEntries(visibleColumns.map((column) => [
        column.id,
        unfilteredProjection.records.flatMap((record) => column.id in record ? [record[column.id]] : []),
      ])),
      titleColumn: visibleColumns[0],
    }
  }, [columnDescriptors, completeProjection, projected.records, types, unfilteredProjection])
  const declaredColumnActions = rawView && onSaveView ? {
    activeFilters: view.filter?.rules.flatMap((rule) => {
      const column = tableModel.visibleColumns.find((candidate) => sameJsonViewPath(candidate.path, rule.path))
      return column ? [{
        column: column.id,
        operator: rule.operator,
        ...(rule.value === undefined ? {} : { value: rule.value }),
      }] : []
    }) ?? [],
    activeSort: (() => {
      for (const sort of view.sort) {
        const column = tableModel.visibleColumns.find((candidate) => sameJsonViewPath(candidate.path, sort.path))
        if (column) return { column: column.id, direction: sort.direction }
      }
      return null
    })(),
    rename: async (columnId: string, label: string) => {
      const columns = tableModel.visibleColumns.map((column) => ({
        label: column.id === columnId ? label : column.label,
        path: column.path.source,
      }))
      await onSaveView({ ...rawView, columns })
    },
    hide: async (columnId: string) => {
      const columns = tableModel.visibleColumns
        .filter((column) => column.id !== columnId)
        .map((column) => ({ label: column.label, path: column.path.source }))
      if (columns.length === 0) throw new Error('Keep at least one column visible')
      await onSaveView({ ...rawView, columns })
    },
    move: async (columnId: string, targetId: string, position: 'before' | 'after') => {
      if (columnId === targetId) return
      const columns = [...tableModel.visibleColumns]
      const sourceIndex = columns.findIndex((column) => column.id === columnId)
      const targetIndex = columns.findIndex((column) => column.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return
      const [moved] = columns.splice(sourceIndex, 1)
      const updatedTargetIndex = columns.findIndex((column) => column.id === targetId)
      columns.splice(updatedTargetIndex + (position === 'after' ? 1 : 0), 0, moved)
      await onSaveView({ ...rawView, columns: columns.map((column) => ({ label: column.label, path: column.path.source })) })
    },
    filter: async (columnId: string, filter: ColumnFilterRule | null) => {
      const target = tableModel.visibleColumns.find((column) => column.id === columnId)
      if (!target) return
      const replacement = filter ? {
        path: target.path.source,
        operator: filter.operator,
        ...((filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty') ? {} : { value: filter.value }),
      } : undefined
      let inserted = false
      const rules = (view.filter?.rules ?? []).flatMap((rule) => {
        if (!sameJsonViewPath(rule.path, target.path)) return [{
          path: rule.path.source,
          operator: rule.operator,
          ...((rule.operator === 'isEmpty' || rule.operator === 'isNotEmpty') ? {} : { value: rule.value }),
        }]
        if (!replacement || inserted) return []
        inserted = true
        return [replacement]
      })
      if (replacement && !inserted) rules.push(replacement)
      const next = { ...rawView }
      if (rules.length > 0) next.filter = {
        ...(view.filter?.match === 'any' ? { match: 'any' } : {}),
        rules,
      }
      else delete next.filter
      await onSaveView(next)
    },
    sort: async (columnId: string, direction: 'asc' | 'desc' | null) => {
      const target = tableModel.visibleColumns.find((column) => column.id === columnId)
      if (!target) return
      const remaining = view.sort
        .filter((sort) => !sameJsonViewPath(sort.path, target.path))
        .map((sort) => ({ path: sort.path.source, direction: sort.direction }))
      const next = { ...rawView }
      const sort = direction ? [{ path: target.path.source, direction }, ...remaining] : remaining
      if (sort.length > 0) next.sort = sort
      else delete next.sort
      await onSaveView(next)
    },
  } : undefined
  const getCellSourcePath = useCallback((rowIndex: number, columnId: string) => {
    const column = tableModel.visibleColumns.find((candidate) => candidate.id === columnId)
    return column && resolveJsonViewRowPath(compiled.root, projected.rows[rowIndex], column.path).sourcePath
  }, [compiled.root, projected.rows, tableModel.visibleColumns])
  const openRow = rowAtSourcePath(compiled.root, openRowPath)
  const reportedPath = openRow?.sourcePath ?? openCell?.path ?? view.sourcePath
  const reportedPathKey = JSON.stringify(reportedPath)
  useEffect(() => {
    if (openRow || openCell) onCurrentPathChange?.(reportedPath)
  }, [onCurrentPathChange, reportedPathKey, Boolean(openRow), Boolean(openCell)])
  const reportVisibleRows = useCallback((indices: readonly number[], filtered: boolean) => {
    const narrowed = filtered || Boolean(view.filter?.rules.length) || query.trim().length > 0
    onCurrentPathChange?.(view.sourcePath, narrowed
      ? indices.map((index) => projected.rows[index].sourcePath)
      : undefined)
  }, [onCurrentPathChange, projected.rows, query, view.filter, view.sourcePath])
  if (openRow) return <RecordView editPath={editPath} compiled={compiled} editing={editing} filePath={filePath} copyFileName={copyFileName} fillHeight={fillHeight} onBack={() => { setOpenRowPath(undefined); setEditPath(undefined) }} onCurrentPathChange={onCurrentPathChange} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} row={openRow} uiSize={uiSize} view={view} />
  if (openCell) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <GeneralJsonView breadcrumb={{ ancestors: [view.name, openCell.rowLabel], backLabel: `Back to ${view.name} table`, onBack: () => setOpenCell(undefined) }} root={compiled.root} initialPath={openCell.path} defaultKey={openCell.fieldLabel} filePath={`${filePath ?? 'json'}#${view.id}:cell:${JSON.stringify(openCell.path)}`} editing={editing} onCurrentPathChange={onCurrentPathChange} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} schemaForPath={(path) => schemaForJsonViewPath(compiled.schema, path)?.descriptor} uiSize={uiSize} fillHeight={fillHeight} renderRecord={(target) => <GeneralRecordView {...target} compiled={compiled} copyFileName={copyFileName} editing={editing} filePath={filePath} fillHeight={fillHeight} name={view.name} onCurrentPathChange={onCurrentPathChange} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} uiSize={uiSize} />} />
      </div>
    )
  }
  const { columnFilterOperators, columnFilterValues, labels, records, stateKeys, titleColumn, visibleColumns } = tableModel
  const collection = view.value
  const addRow = editing && Array.isArray(collection) ? async () => {
    const sourcePath: ValuePath = [...view.sourcePath, collection.length]
    await editing.append(view.sourcePath, blankRow(compiled, view))
    editing.registerDraftRow?.(sourcePath)
    setOpenRowPath(sourcePath)
  } : undefined
  const addColumn = editing?.addColumn && rawView && view.declarationIndex >= 0 && Array.isArray(collection) ? async ({ label, type }: { label: string; type: 'text' | 'markdown' | 'html' | 'number' | 'checkbox' | 'date' | 'select' | 'multi-select' }) => {
    let base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'property'
    if (/^[0-9]/.test(base)) base = `property_${base}`
    const existing = new Set(collection.flatMap((row) => row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : []))
    let property = base
    let suffix = 2
    while (existing.has(property)) property = `${base}_${suffix++}`
    const schemaPath = `${view.path.source}[*].${property}`
    const descriptor: Record<string, unknown> = { type, title: label }
    if (type === 'select' || type === 'multi-select') descriptor.options = []
    await editing.addColumn!(view.sourcePath, property, schemaPath, descriptor, view.declarationIndex)
  } : undefined
  const deleteColumn = editing?.deleteColumn && rawView && Array.isArray(collection) ? async (columnId: string) => {
    const column = tableModel.visibleColumns.find((candidate) => candidate.id === columnId)
    const relative = column ? rowFieldPath(view, column.path) : undefined
    if (!column || !relative || relative.length !== 1) throw new Error('Only direct row properties can be deleted')
    await editing.deleteColumn!(view.sourcePath, relative[0], column.path.source)
  } : undefined
  return (
    <TabularObjectArrayView
      arr={records}
      getCellSourcePath={getCellSourcePath}
      rowKeys={projected.rows.map((row) => JSON.stringify(row.sourcePath))}
      onVisibleRowsChange={reportVisibleRows}
      columns={visibleColumns.map(({ id }) => id)}
      columnLabels={labels}
      filePath={filePath}
      columnStateKeys={stateKeys}
      viewStateKey={`jsonView:${view.id}`}
      presentationControls={view.declarationIndex < 0 || compiled.recognized === false}
      activeColumnFilters={declaredColumnActions?.activeFilters}
      activeColumnSort={declaredColumnActions?.activeSort}
      columnFilterOperators={columnFilterOperators}
      columnFilterValues={columnFilterValues}
      onColumnFilter={declaredColumnActions?.filter}
      onColumnRename={declaredColumnActions?.rename}
      onColumnHide={declaredColumnActions?.hide}
      onColumnMove={declaredColumnActions?.move}
      onColumnDelete={deleteColumn}
      onAddColumn={addColumn}
      onColumnSort={declaredColumnActions?.sort}
      fillHeight={fillHeight}
      uiSize={uiSize}
      recordNavigation={titleColumn ? {
        titleColumn: titleColumn.id,
        getLabel: (rowIndex) => {
          const row = projected.rows[rowIndex]
          return sourceLiteral(titleFieldForRow(compiled.root, view, row)?.path) ?? titleForRow(compiled.root, view, row)
        },
        onOpen: (rowIndex) => setOpenRowPath(projected.rows[rowIndex].sourcePath),
        renderTitle: ({ value, rowIndex }) => {
          const row = projected.rows[rowIndex]
          const resolved = resolveJsonViewRowPath(compiled.root, row, titleColumn.path)
          const descriptor = schemaForJsonViewPath(compiled.schema, resolved.sourcePath)?.descriptor
          const coloredDescriptor = descriptor && withColumnOptionColors(descriptor, columnFilterValues[titleColumn.id] ?? [value], visibleColumns.findIndex((candidate) => candidate.id === titleColumn.id))
          if (resolved.value === JSON_VIEW_PATH_MISSING) return <span className="italic text-muted-foreground">Untitled</span>
          return coloredDescriptor
            ? <JsonViewSchemaValueDisplay sourcePath={resolved.sourcePath} compact decorative passive descriptor={coloredDescriptor} value={value} onOpen={() => undefined} renderMarkdown={renderMarkdown} />
            : <ValueCellContent containerInteractive={false} sourcePath={resolved.sourcePath} value={value} onOpen={() => undefined} />
        },
      } : undefined}
      onOpenCell={({ rowIndex, column }) => {
        const displayColumn = visibleColumns.find((candidate) => candidate.id === column)
        const row = projected.rows[rowIndex]
        if (!displayColumn || !row) return
        const resolved = resolveJsonViewRowPath(compiled.root, row, displayColumn.path)
        if (resolved.value !== JSON_VIEW_PATH_MISSING) setOpenCell({
          fieldLabel: displayColumn.label,
          path: resolved.sourcePath,
          rowLabel: titleForRow(compiled.root, view, row),
        })
      }}
      renderCell={({ value, rowIndex, column, open }) => {
        const displayColumn = visibleColumns.find((candidate) => candidate.id === column)
        const row = projected.rows[rowIndex]
        if (!displayColumn || !row) return null
        const resolved = resolveJsonViewRowPath(compiled.root, row, displayColumn.path)
        const schema = schemaForJsonViewPath(compiled.schema, resolved.sourcePath)
        const descriptor = schema?.descriptor
        const coloredDescriptor = descriptor && withColumnOptionColors(descriptor, columnFilterValues[column] ?? [value], visibleColumns.findIndex((candidate) => candidate.id === column))
        if (isLongText(value, descriptor)) return (
          <button type="button" className="block h-full w-full min-w-0 truncate px-1.5 py-1 text-left hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring" aria-label={`Open ${displayColumn.label} in record`} onClick={() => { setEditPath(resolved.sourcePath); setOpenRowPath(row.sourcePath) }}>{value || '—'}</button>
        )
        if (coloredDescriptor) {
          return (
            <JsonViewSchemaValueCell
              sourcePath={resolved.sourcePath}
              descriptor={coloredDescriptor}
              suppressRequiredValidation={editing?.isDraftRow?.(row.sourcePath) === true}
              onOptionColorChange={editing?.setOptionColor && schema ? (optionValue, color) => editing.setOptionColor!(schema.declaration, optionValue, color) : undefined}
              inputKey={String(resolved.sourcePath[resolved.sourcePath.length - 1] ?? displayColumn.label)}
              label={descriptor.title ?? displayColumn.label}
              value={value}
              onOpen={open}
              onClear={editing && resolved.value !== JSON_VIEW_PATH_MISSING ? () => editing.clear(resolved.sourcePath) : undefined}
              onCommit={editing && editing.canReplace?.(resolved.sourcePath) !== false && resolved.value !== JSON_VIEW_PATH_MISSING ? (next) => editing.replace(resolved.sourcePath, next) : undefined}
              renderExternalWidget={renderExternalWidget}
              renderMarkdown={renderMarkdown}
              saving={editing?.saving}
            />
          )
        }
        if (editing && editing.canReplace?.(resolved.sourcePath) !== false && resolved.value !== JSON_VIEW_PATH_MISSING && isEditableAtomicValue(value)) {
          return (
            <AtomicValueEditor label={displayColumn.label} value={value} saving={editing.saving} onCommit={(next) => editing.replace(resolved.sourcePath, next)}>
              <ValueCellContent sourcePath={resolved.sourcePath} value={value} onOpen={open} />
            </AtomicValueEditor>
          )
        }
        return <ValueCell sourcePath={resolved.sourcePath} value={value} onOpen={open} />
      }}
      onAddRow={addRow}
      getRowsCopyText={(rowIndices) => jsonRowsCopyText(rowIndices.flatMap((index) => {
        const row = projected.rows[index]
        return row ? [{ value: row.value, sourcePath: row.sourcePath }] : []
      }), sourceLiteral)}
      getRowsReferenceText={(rowIndices) => jsonRowsReferenceText(copyFileName, rowIndices.flatMap((index) => {
        const row = projected.rows[index]
        return row ? [{ sourcePath: row.sourcePath }] : []
      }))}
      onDeleteRows={editing ? (rowIndices) => editing.removeMany(removalOrder(rowIndices.map((index) => projected.rows[index]?.sourcePath).filter((path): path is ValuePath => path !== undefined))) : undefined}
      rowAdditionDisabled={editing?.saving}
      rowDeletionDisabled={editing?.saving}
    />
  )
}
