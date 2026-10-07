/** Renders one location in a general JSON document. */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { JsonSourceNumber, useJsonSourceLiterals } from '../../source-literals.js'
import { useJsonViewsRegistries } from '../../../widget-registry.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../primitives/tooltip.js'
import type { UiSize } from '../../../lib/ui-size.js'
import { cn } from '../../../lib/cn.js'
import {
  ExpandValueButton,
  TABULAR_DATA_FRAME_CLASS,
  TabularObjectArrayView,
  ValueCell,
  ValueCellContent,
} from '../../../tabular-data-view.js'
import { getDictOfObjectsInfo, isPlainObject, type DictTableInfo } from './json-flatten.js'
import {
  AtomicValueEditor,
  StructuredValueCellFrame,
} from '../../../structured-data/atomic-value-editor.js'
import { isEditableAtomicValue } from '../../../structured-data/atomic-value.js'
import { inferJsonViewRecordTitleKey, isJsonViewTableCandidate, type ValuePath } from '@script-it/json-views-core'
import type { JsonViewSchemaDescriptor } from '@script-it/json-views-core'
import {
  JsonViewSchemaValueDisplay,
  JsonViewSchemaValueCell,
  type JsonViewSchemaExternalWidgetRenderer,
} from '../../schema-value.js'

export interface GeneralJsonAtomicEditing {
  canReplace?: (path: ValuePath) => boolean
  clear: (path: ValuePath) => Promise<void>
  commit: (path: ValuePath, value: unknown) => Promise<void>
  /** Removes several values as one commit (one file write). Positional paths
   * must arrive deepest-index-first so earlier removals don't shift them. */
  removeMany: (paths: ValuePath[]) => Promise<void>
  saving: boolean
}

export type GeneralJsonNavigateTo = (
  key: string,
  relativePath?: ValuePath,
  record?: { titleKey?: string },
) => void

export interface GeneralJsonNodeViewProps {
  node: unknown
  navigateTo: GeneralJsonNavigateTo
  filePath?: string
  currentPathKey: string
  currentJsonPath: ValuePath
  currentLabel: string
  renderAsMarkdown: boolean
  getTableCellPosition?: (path: string) => { row: number; col: string } | undefined
  setTableCellPosition?: (path: string, cell: { row: number; col: string }) => void
  renderMarkdown?: (content: string) => ReactNode
  uiSize?: UiSize
  fillHeight?: boolean
  atomicEditing?: GeneralJsonAtomicEditing
  schemaForPath?: (path: ValuePath) => JsonViewSchemaDescriptor | undefined
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  onVisibleSourcePathsChange?: (paths?: readonly ValuePath[]) => void
}

export function GeneralJsonNodeView(props: GeneralJsonNodeViewProps) {
  return <AnnotatedJsonNodeView key={props.currentPathKey} {...props} />
}

function AnnotatedJsonNodeView({ currentPathKey, ...props }: GeneralJsonNodeViewProps) {
  const [expanded, setExpanded] = useState(false)
  const { widgets } = useJsonViewsRegistries()
  const descriptor = props.schemaForPath?.(props.currentJsonPath)
  const container = props.node !== null && typeof props.node === 'object'
  const registered = descriptor && (widgets.get(descriptor.type) || widgets.getDisplay(descriptor.type) || props.renderExternalWidget)
  if (container && descriptor && registered && !expanded) {
    const editing = props.atomicEditing?.canReplace?.(props.currentJsonPath) === false ? undefined : props.atomicEditing
    return <JsonViewSchemaValueCell
      sourcePath={props.currentJsonPath}
      descriptor={descriptor}
      label={descriptor.title ?? props.currentLabel}
      value={props.node}
      onOpen={() => setExpanded(true)}
      onCommit={editing ? (value) => editing.commit(props.currentJsonPath, value) : undefined}
      onClear={editing ? () => editing.clear(props.currentJsonPath) : undefined}
      renderExternalWidget={props.renderExternalWidget}
      renderMarkdown={props.renderMarkdown}
      saving={editing?.saving}
    />
  }
  return <>
    {expanded && <button type="button" className="mb-2 w-fit rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setExpanded(false)}>Back to annotated value</button>}
    <NodeView {...props} currentPath={currentPathKey} />
  </>
}

/** Seams every nested view forwards unchanged down to the leaves. */
interface ViewSeams {
  renderMarkdown?: (content: string) => ReactNode
  uiSize?: UiSize
  atomicEditing?: GeneralJsonAtomicEditing
  schemaForPath?: (path: ValuePath) => JsonViewSchemaDescriptor | undefined
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  onVisibleSourcePathsChange?: (paths?: readonly ValuePath[]) => void
}

function GeneralJsonValueCell({
  atomicEditing,
  compact = false,
  label,
  navigateTo,
  path,
  renderMarkdown,
  renderExternalWidget,
  schemaForPath,
  value,
}: {
  atomicEditing?: ViewSeams['atomicEditing']
  compact?: boolean
  label: string
  navigateTo: () => void
  path: ValuePath | null
  renderMarkdown?: (content: string) => ReactNode
  renderExternalWidget?: ViewSeams['renderExternalWidget']
  schemaForPath?: ViewSeams['schemaForPath']
  value: unknown
}) {
  if (path && atomicEditing?.canReplace?.(path) === false) atomicEditing = undefined
  const descriptor = path ? schemaForPath?.(path) : undefined
  if (descriptor && path) {
    return (
      <JsonViewSchemaValueCell
        sourcePath={path}
        compact={compact}
        descriptor={descriptor}
        inputKey={String(path[path.length - 1] ?? label)}
        label={descriptor.title ?? label}
        onClear={atomicEditing ? () => atomicEditing.clear(path) : undefined}
        onCommit={atomicEditing ? (nextValue) => atomicEditing.commit(path, nextValue) : undefined}
        onOpen={navigateTo}
        renderExternalWidget={renderExternalWidget}
        renderMarkdown={renderMarkdown}
        saving={atomicEditing?.saving}
        value={value}
      />
    )
  }
  const editable = atomicEditing !== undefined && path !== null && isEditableAtomicValue(value)
  if (!editable || !atomicEditing || path === null) return <ValueCell sourcePath={path ?? undefined} value={value} onOpen={navigateTo} />

  return (
    <AtomicValueEditor
      actions={<ExpandValueButton onClick={navigateTo} />}
      label={label}
      multiline={typeof value === 'string' && value.includes('\n')}
      onCommit={(nextValue) => atomicEditing.commit(path, nextValue)}
      saving={atomicEditing.saving}
      value={value}
    >
      <ValueCellContent sourcePath={path ?? undefined} value={value} onOpen={navigateTo} />
    </AtomicValueEditor>
  )
}

interface NodeViewProps extends ViewSeams {
  node: unknown
  navigateTo: GeneralJsonNavigateTo
  filePath?: string
  currentPath: string
  currentJsonPath: ValuePath
  currentLabel: string
  renderAsMarkdown: boolean
  getTableCellPosition?: (path: string) => { row: number; col: string } | undefined
  setTableCellPosition?: (path: string, cell: { row: number; col: string }) => void
  fillHeight?: boolean
}

function NodeView({
  node,
  navigateTo,
  filePath,
  currentPath,
  currentJsonPath,
  currentLabel,
  renderAsMarkdown,
  getTableCellPosition,
  setTableCellPosition,
  renderMarkdown,
  uiSize,
  fillHeight = false,
  atomicEditing,
  schemaForPath,
  renderExternalWidget,
  onVisibleSourcePathsChange,
}: NodeViewProps) {
  const sourceLiteral = useJsonSourceLiterals()(currentJsonPath)
  // A map of similarly-shaped records renders as a flat table (key column +
  // the nested fields); any other object falls back to the key/value view.
  const dictTableInfo = useMemo(
    () => (isPlainObject(node) ? getDictOfObjectsInfo(node) : null),
    [node],
  )

  if (Array.isArray(node)) {
    return (
      <ArrayView
        arr={node}
        navigateTo={navigateTo}
        filePath={filePath}
        currentPath={currentPath}
        currentJsonPath={currentJsonPath}
        getTableCellPosition={getTableCellPosition}
        setTableCellPosition={setTableCellPosition}
        renderMarkdown={renderMarkdown}
        uiSize={uiSize}
        fillHeight={fillHeight}
        atomicEditing={atomicEditing}
        schemaForPath={schemaForPath}
        renderExternalWidget={renderExternalWidget}
        onVisibleSourcePathsChange={onVisibleSourcePathsChange}
      />
    )
  }
  if (dictTableInfo) {
    return (
      <DictObjectTableView
        info={dictTableInfo}
        navigateTo={navigateTo}
        filePath={filePath}
        currentPath={currentPath}
        currentJsonPath={currentJsonPath}
        getTableCellPosition={getTableCellPosition}
        setTableCellPosition={setTableCellPosition}
        renderMarkdown={renderMarkdown}
        uiSize={uiSize}
        fillHeight={fillHeight}
        atomicEditing={atomicEditing}
        schemaForPath={schemaForPath}
        renderExternalWidget={renderExternalWidget}
        onVisibleSourcePathsChange={onVisibleSourcePathsChange}
      />
    )
  }
  if (isPlainObject(node)) {
    return <ObjectView obj={node} navigateTo={navigateTo} currentJsonPath={currentJsonPath} atomicEditing={atomicEditing} renderMarkdown={renderMarkdown} renderExternalWidget={renderExternalWidget} schemaForPath={schemaForPath} />
  }
  if (atomicEditing?.canReplace?.(currentJsonPath) === false) atomicEditing = undefined
  const currentDescriptor = schemaForPath?.(currentJsonPath)
  if (currentDescriptor) {
    return (
      <JsonViewSchemaValueCell
        sourcePath={currentJsonPath}
        descriptor={currentDescriptor}
        label={currentDescriptor.title ?? currentLabel}
        onClear={atomicEditing ? () => atomicEditing.clear(currentJsonPath) : undefined}
        onCommit={atomicEditing ? (nextValue) => atomicEditing.commit(currentJsonPath, nextValue) : undefined}
        onOpen={() => undefined}
        inputKey={String(currentJsonPath[currentJsonPath.length - 1] ?? currentLabel)}
        renderExternalWidget={renderExternalWidget}
        renderMarkdown={renderMarkdown}
        saving={atomicEditing?.saving}
        value={node}
      />
    )
  }
  if (typeof node === 'string') {
    const content = (
      <ExpandedStringValue
        value={node}
        renderAsMarkdown={renderAsMarkdown}
        renderMarkdown={renderMarkdown}
      />
    )
    return atomicEditing ? (
      <AtomicValueEditor
        // Shown as Markdown, the string is a document: Enter breaks the line.
        enterKey={renderAsMarkdown && renderMarkdown ? 'newline' : undefined}
        label={currentLabel}
        multiline={node.includes('\n')}
        onCommit={(nextValue) => atomicEditing.commit(currentJsonPath, nextValue)}
        saving={atomicEditing.saving}
        value={node}
      >
        {content}
      </AtomicValueEditor>
    ) : content
  }
  const content = (
    <div className="whitespace-pre-wrap text-sm text-foreground" style={{ overflowWrap: 'anywhere' }}>
      {sourceLiteral !== undefined ? <JsonSourceNumber literal={sourceLiteral} /> : String(node)}
    </div>
  )
  return atomicEditing && isEditableAtomicValue(node) ? (
    <AtomicValueEditor
      label={currentLabel}
      onCommit={(nextValue) => atomicEditing.commit(currentJsonPath, nextValue)}
      saving={atomicEditing.saving}
      value={node}
    >
      {content}
    </AtomicValueEditor>
  ) : content
}

function ExpandedStringValue({
  value,
  renderAsMarkdown,
  renderMarkdown,
}: {
  value: string
  renderAsMarkdown: boolean
  renderMarkdown?: (content: string) => ReactNode
}) {
  return renderAsMarkdown && renderMarkdown ? (
    renderMarkdown(value)
  ) : (
    <div className="whitespace-pre-wrap text-sm text-foreground" style={{ overflowWrap: 'anywhere' }}>
      {value}
    </div>
  )
}


type TabularInfo =
  | { type: 'objects'; columns: string[] }
  | { type: 'tuples'; length: number }

function getTabularInfo(arr: unknown[]): TabularInfo | null {
  if (arr.length === 0) return null

  const first = arr[0]

  // Check if all items are arrays (tuples) with consistent length
  if (Array.isArray(first)) {
    const tupleLength = first.length
    if (tupleLength === 0) return null

    // Verify all items are arrays with the same length and contain primitives
    for (const item of arr) {
      if (!Array.isArray(item)) return null
      if (item.length !== tupleLength) return null
      // Check that tuple contains only primitives (not nested objects/arrays)
      for (const val of item) {
        if (val !== null && typeof val === 'object') return null
      }
    }

    return { type: 'tuples', length: tupleLength }
  }

  if (!isJsonViewTableCandidate(arr)) return null

  // Collect all unique keys, preserving order of first appearance
  const seenKeys = new Set<string>()
  const columns: string[] = []

  for (const item of arr) {
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        columns.push(key)
      }
    }
  }

  // Only show as table if we have at least one column
  return columns.length > 0 ? { type: 'objects', columns } : null
}

interface ArrayViewProps extends ViewSeams {
  arr: unknown[]
  navigateTo: GeneralJsonNavigateTo
  filePath?: string
  currentPath: string
  currentJsonPath: ValuePath
  getTableCellPosition?: (path: string) => { row: number; col: string } | undefined
  setTableCellPosition?: (path: string, cell: { row: number; col: string }) => void
  fillHeight?: boolean
}

function ArrayView({
  arr,
  navigateTo,
  filePath,
  currentPath,
  currentJsonPath,
  getTableCellPosition,
  setTableCellPosition,
  uiSize,
  fillHeight = false,
  atomicEditing,
  schemaForPath,
  renderMarkdown,
  renderExternalWidget,
  onVisibleSourcePathsChange,
}: ArrayViewProps) {
  const sourceLiteral = useJsonSourceLiterals()
  const getCellSourcePath = useCallback((rowIndex: number, column: string) => [...currentJsonPath, rowIndex, column], [currentJsonPath])
  if (arr.length === 0) return <div className="text-muted-foreground italic">(empty list)</div>

  const tabularInfo = getTabularInfo(arr)
  if (tabularInfo?.type === 'objects') {
    const records = arr as Record<string, unknown>[]
    const titleKey = inferJsonViewRecordTitleKey(records) ?? tabularInfo.columns[0]
    return (
      <TabularObjectArrayView
        arr={records}
        getCellSourcePath={getCellSourcePath}
        columns={[titleKey, ...tabularInfo.columns.filter((column) => column !== titleKey)]}
        filePath={filePath}
        viewStateKey={currentPath}
        onOpenCell={({ rowIndex, column }) => {
          setTableCellPosition?.(currentPath, { row: rowIndex, col: column })
          navigateTo(`${rowIndex}.${column}`, [rowIndex, column])
        }}
        initialCell={getTableCellPosition?.(currentPath)}
        uiSize={uiSize}
        fillHeight={fillHeight}
        onVisibleRowsChange={(indices, filtered) => onVisibleSourcePathsChange?.(filtered
          ? indices.map((index) => [...currentJsonPath, index])
          : undefined)}
        recordNavigation={{
          titleColumn: titleKey,
          getLabel: (rowIndex) => sourceLiteral([...currentJsonPath, rowIndex, titleKey])
            ?? String(records[rowIndex][titleKey] ?? `Item ${rowIndex + 1}`),
          onOpen: (rowIndex) => navigateTo(String(rowIndex), [rowIndex], { titleKey }),
          renderTitle: ({ value, rowIndex }) => {
            const path = [...currentJsonPath, rowIndex, titleKey]
            const descriptor = schemaForPath?.(path)
            return descriptor
              ? <JsonViewSchemaValueDisplay compact decorative passive descriptor={descriptor} onOpen={() => undefined} renderMarkdown={renderMarkdown} sourcePath={path} value={value} />
              : value === undefined
                ? <span className="italic text-muted-foreground">Untitled</span>
                : <ValueCellContent containerInteractive={false} sourcePath={path} value={value} onOpen={() => undefined} />
          },
        }}
        renderCell={({ value, rowIndex, column, open }) => (
          <GeneralJsonValueCell
            atomicEditing={atomicEditing}
            compact
            label={column}
            navigateTo={open}
            path={[...currentJsonPath, rowIndex, column]}
            renderMarkdown={renderMarkdown}
            renderExternalWidget={renderExternalWidget}
            schemaForPath={schemaForPath}
            value={value}
          />
        )}
        onDeleteRows={atomicEditing
          ? (rowIndices) => atomicEditing.removeMany(rowIndices.map((rowIndex) => [...currentJsonPath, rowIndex]))
          : undefined}
        rowDeletionDisabled={atomicEditing?.saving}
      />
    )
  }
  if (tabularInfo?.type === 'tuples') {
    return (
      <TupleArrayView
        arr={arr as unknown[][]}
        tupleLength={tabularInfo.length}
        navigateTo={navigateTo}
        filePath={filePath}
        arrayPath={currentPath}
        currentJsonPath={currentJsonPath}
        uiSize={uiSize}
        fillHeight={fillHeight}
        atomicEditing={atomicEditing}
        schemaForPath={schemaForPath}
        renderMarkdown={renderMarkdown}
        renderExternalWidget={renderExternalWidget}
        onVisibleSourcePathsChange={onVisibleSourcePathsChange}
      />
    )
  }

  return (
    <SingleColumnArrayView
      arr={arr}
      navigateTo={navigateTo}
      filePath={filePath}
      arrayPath={currentPath}
      currentJsonPath={currentJsonPath}
      uiSize={uiSize}
      fillHeight={fillHeight}
      atomicEditing={atomicEditing}
      schemaForPath={schemaForPath}
      renderMarkdown={renderMarkdown}
      renderExternalWidget={renderExternalWidget}
      onVisibleSourcePathsChange={onVisibleSourcePathsChange}
    />
  )
}

function TupleArrayView({
  arr,
  tupleLength,
  navigateTo,
  filePath,
  arrayPath,
  currentJsonPath,
  uiSize,
  fillHeight = false,
  atomicEditing,
  schemaForPath,
  renderMarkdown,
  renderExternalWidget,
  onVisibleSourcePathsChange,
}: {
  arr: unknown[][]
  tupleLength: number
  navigateTo: GeneralJsonNavigateTo
  filePath?: string
  arrayPath: string
  currentJsonPath: ValuePath
  uiSize?: UiSize
  fillHeight?: boolean
  atomicEditing?: ViewSeams['atomicEditing']
  schemaForPath?: ViewSeams['schemaForPath']
  renderMarkdown?: ViewSeams['renderMarkdown']
  renderExternalWidget?: ViewSeams['renderExternalWidget']
  onVisibleSourcePathsChange?: ViewSeams['onVisibleSourcePathsChange']
}) {
  const getCellSourcePath = useCallback((rowIndex: number, column: string) => [...currentJsonPath, rowIndex, Number(column)], [currentJsonPath])
  const columns = useMemo(() => Array.from({ length: tupleLength }, (_, i) => String(i)), [tupleLength])
  const records = useMemo(() => arr.map((tuple) =>
    tuple.reduce<Record<string, unknown>>((record, value, index) => {
      record[String(index)] = value
      return record
    }, {})
  ), [arr])

  return (
    <TabularObjectArrayView
      arr={records}
      getCellSourcePath={getCellSourcePath}
      columns={columns}
      filePath={filePath}
      viewStateKey={arrayPath}
      onOpenCell={({ rowIndex, column }) => {
        navigateTo(`${rowIndex}.${column}`, [rowIndex, Number(column)])
      }}
      uiSize={uiSize}
      fillHeight={fillHeight}
      onVisibleRowsChange={(indices, filtered) => onVisibleSourcePathsChange?.(filtered
        ? indices.map((index) => [...currentJsonPath, index])
        : undefined)}
      renderCell={({ value, rowIndex, column, open }) => (
        <GeneralJsonValueCell
          atomicEditing={atomicEditing}
          compact
          label={column}
          navigateTo={open}
          path={[...currentJsonPath, rowIndex, Number(column)]}
          renderMarkdown={renderMarkdown}
          renderExternalWidget={renderExternalWidget}
          schemaForPath={schemaForPath}
          value={value}
        />
      )}
      onDeleteRows={atomicEditing
        ? (rowIndices) => atomicEditing.removeMany(rowIndices.map((rowIndex) => [...currentJsonPath, rowIndex]))
        : undefined}
      rowDeletionDisabled={atomicEditing?.saving}
    />
  )
}

function SingleColumnArrayView({
  arr,
  navigateTo,
  filePath,
  arrayPath,
  currentJsonPath,
  uiSize,
  fillHeight = false,
  atomicEditing,
  schemaForPath,
  renderMarkdown,
  renderExternalWidget,
  onVisibleSourcePathsChange,
}: {
  arr: unknown[]
  navigateTo: GeneralJsonNavigateTo
  filePath?: string
  arrayPath: string
  currentJsonPath: ValuePath
  uiSize?: UiSize
  fillHeight?: boolean
  atomicEditing?: ViewSeams['atomicEditing']
  schemaForPath?: ViewSeams['schemaForPath']
  renderMarkdown?: ViewSeams['renderMarkdown']
  renderExternalWidget?: ViewSeams['renderExternalWidget']
  onVisibleSourcePathsChange?: ViewSeams['onVisibleSourcePathsChange']
}) {
  const getCellSourcePath = useCallback((rowIndex: number) => [...currentJsonPath, rowIndex], [currentJsonPath])
  const records = useMemo(() => arr.map((item) => ({ Value: item })), [arr])

  return (
    <TabularObjectArrayView
      arr={records}
      getCellSourcePath={getCellSourcePath}
      columns={['Value']}
      filePath={filePath}
      viewStateKey={arrayPath}
      onOpenCell={({ rowIndex }) => navigateTo(String(rowIndex), [rowIndex])}
      uiSize={uiSize}
      fillHeight={fillHeight}
      onVisibleRowsChange={(indices, filtered) => onVisibleSourcePathsChange?.(filtered
        ? indices.map((index) => [...currentJsonPath, index])
        : undefined)}
      renderCell={({ value, rowIndex, open }) => (
        <GeneralJsonValueCell
          atomicEditing={atomicEditing}
          compact
          label="Value"
          navigateTo={open}
          path={[...currentJsonPath, rowIndex]}
          renderMarkdown={renderMarkdown}
          renderExternalWidget={renderExternalWidget}
          schemaForPath={schemaForPath}
          value={value}
        />
      )}
      onDeleteRows={atomicEditing
        ? (rowIndices) => atomicEditing.removeMany(rowIndices.map((rowIndex) => [...currentJsonPath, rowIndex]))
        : undefined}
      rowDeletionDisabled={atomicEditing?.saving}
    />
  )
}

interface DictObjectTableViewProps extends ViewSeams {
  info: DictTableInfo
  navigateTo: GeneralJsonNavigateTo
  filePath?: string
  currentPath: string
  currentJsonPath: ValuePath
  getTableCellPosition?: (path: string) => { row: number; col: string } | undefined
  setTableCellPosition?: (path: string, cell: { row: number; col: string }) => void
  fillHeight?: boolean
}

function DictObjectTableView({
  info,
  navigateTo,
  filePath,
  currentPath,
  currentJsonPath,
  getTableCellPosition,
  setTableCellPosition,
  uiSize,
  fillHeight = false,
  atomicEditing,
  schemaForPath,
  renderMarkdown,
  renderExternalWidget,
  onVisibleSourcePathsChange,
}: DictObjectTableViewProps) {
  const getCellSourcePath = useCallback((rowIndex: number, column: string) => column === info.keyColumn ? undefined : [...currentJsonPath, info.keys[rowIndex], column], [currentJsonPath, info])
  // Rows are keyed by their original map key (not row index). The key column
  // drills into the whole record (`obj[key]`); every other column drills into
  // `obj[key].<field>`. Keying both the node and the path off the map key means
  // a click and a later replay land on the same node.
  // The key column shows the map key as text but has no field of its own, so a
  // click drills into the record object rather than the (dead-end) key string.
  return (
    <TabularObjectArrayView
      arr={info.records}
      getCellSourcePath={getCellSourcePath}
      columns={info.columns}
      filePath={filePath}
      viewStateKey={currentPath}
      onOpenCell={({ rowIndex, column }) => {
        const key = info.keys[rowIndex]
        const navigationKey = column === info.keyColumn ? key : `${key}.${column}`
        const relativePath = column === info.keyColumn ? [key] : [key, column]
        setTableCellPosition?.(currentPath, { row: rowIndex, col: column })
        navigateTo(navigationKey, relativePath)
      }}
      initialCell={getTableCellPosition?.(currentPath)}
      uiSize={uiSize}
      fillHeight={fillHeight}
      onVisibleRowsChange={(indices, filtered) => onVisibleSourcePathsChange?.(filtered
        ? indices.map((index) => [...currentJsonPath, info.keys[index]])
        : undefined)}
      recordNavigation={{
        titleColumn: info.keyColumn,
        getLabel: (rowIndex) => info.keys[rowIndex],
        onOpen: (rowIndex) => navigateTo(info.keys[rowIndex], [info.keys[rowIndex]], {}),
        renderTitle: ({ value }) => <span className="min-w-0 truncate">{String(value)}</span>,
      }}
      renderCell={({ value, rowIndex, column, open }) => (
        <GeneralJsonValueCell
          atomicEditing={atomicEditing}
          compact
          label={column}
          navigateTo={open}
          path={column === info.keyColumn ? null : [...currentJsonPath, info.keys[rowIndex], column]}
          renderMarkdown={renderMarkdown}
          renderExternalWidget={renderExternalWidget}
          schemaForPath={schemaForPath}
          value={value}
        />
      )}
      onDeleteRows={atomicEditing
        ? (rowIndices) => atomicEditing.removeMany(rowIndices.map((rowIndex) => [...currentJsonPath, info.keys[rowIndex]]))
        : undefined}
      rowDeletionDisabled={atomicEditing?.saving}
    />
  )
}

interface ObjectViewProps extends ViewSeams {
  obj: Record<string, unknown>
  navigateTo: GeneralJsonNavigateTo
  currentJsonPath: ValuePath
}

function ObjectView({ obj, navigateTo, currentJsonPath, atomicEditing, renderMarkdown, renderExternalWidget, schemaForPath }: ObjectViewProps) {
  return (
    // `shrink-0`: when the viewer fills a bounded viewport its scroller is a
    // flex column, and this frame is a scroll container, so its `min-height:
    // auto` resolves to 0 — without the guard a tall object is squeezed and
    // clipped with no scrollbar of its own.
    <div className={cn(TABULAR_DATA_FRAME_CLASS, 'shrink-0')}>
      {/* `@container` so the key column below reacts to the width this table
          actually gets — an embed in a trigger card, a popup, or a phone, not
          the viewport. Safe here because this wrapper is parent-sized
          (`max-w-full` inside a block frame); `container-type: inline-size`
          would collapse a content-sized host. */}
      <div className="@container max-w-full overflow-x-auto overscroll-x-none [word-break:normal] [overflow-wrap:normal]">
        <table className="mb-0 w-full table-fixed border-separate border-spacing-0 text-sm">
          <tbody>
            {Object.entries(obj).map(([k, v], i, arr) => (
              <tr key={k}>
                {/* The key column shares the table's width instead of
                    reserving a fixed slice of it. `table-fixed` means content
                    cannot influence a column, so one hardcoded width squeezes
                    the value column to nothing in a narrow container and
                    truncates every value. Three stops, because fixed layout
                    honours a pure length or a pure percentage but silently
                    IGNORES a mixed `clamp()`/`min()`/`max()` and falls back to
                    equal columns: 12rem once there is room for it (the
                    comfortable width), a 45% share while there isn't, and a
                    6rem floor below which the key is all ellipsis. The stops
                    are continuous: 45% of each breakpoint equals the
                    neighbouring fixed width. */}
                <th
                  className={`w-[6rem] @[208px]:w-[45%] @[432px]:w-[12rem] border-r border-border bg-background px-4 py-1.5 text-left align-top font-normal text-muted-foreground ${i < arr.length - 1 ? 'border-b' : ''}`}
                >
                  {/* One line, clipped with an ellipsis — the themed tooltip
                      carries the full key on hover, matching the column-header
                      tooltips in `tabular-data-view`. A wrapped key would push
                      its row taller than the value beside it and misalign the
                      table. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex min-h-7 items-center leading-5">
                        <span className="block min-w-0 truncate">{k}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">{k}</TooltipContent>
                  </Tooltip>
                </th>
                <td className={`min-w-0 overflow-hidden break-words px-4 py-1.5 align-top transition-colors hover:bg-accent/50 ${i < arr.length - 1 ? 'border-b border-border' : ''}`}>
                  {k === 'content'
                    && typeof v === 'string'
                    && renderMarkdown
                    && !schemaForPath?.([...currentJsonPath, k]) ? (() => {
                    const open = () => navigateTo(k, [k])
                    const expandAction = <ExpandValueButton onClick={open} />
                    const content = renderMarkdown(v)
                    const jsonPath = [...currentJsonPath, k]
                    if (!atomicEditing || atomicEditing.canReplace?.(jsonPath) === false) {
                      return (
                        <StructuredValueCellFrame actions={expandAction}>
                          {content}
                        </StructuredValueCellFrame>
                      )
                    }
                    return (
                      <AtomicValueEditor
                        actions={expandAction}
                        enterKey="newline"
                        label={k}
                        multiline
                        onCommit={(nextValue) => atomicEditing.commit(jsonPath, nextValue)}
                        saving={atomicEditing.saving}
                        value={v}
                      >
                        {content}
                      </AtomicValueEditor>
                    )
                  })() : (
                    <GeneralJsonValueCell
                      atomicEditing={atomicEditing}
                      label={k}
                      navigateTo={() => navigateTo(k, [k])}
                      path={[...currentJsonPath, k]}
                      renderMarkdown={renderMarkdown}
                      renderExternalWidget={renderExternalWidget}
                      schemaForPath={schemaForPath}
                      value={v}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
