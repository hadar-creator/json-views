import { HtmlViewSettings } from './html-view/settings.js'
import { createPortal } from 'react-dom'
import { useAnchoredPosition } from '../lib/use-anchored-position.js'
import { useJsonViewsPortalContainer } from '../surface.js'
import { jsonValueText } from '@script-it/json-views-core'
import { parseFilterValue } from '../structured-data/filter-value.js'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  ChevronDown,
  Columns3,
  Copy,
  GripVertical,
  Plus,
  Settings2,
  Table2,
  Trash2,
} from 'lucide-react'

import { useJsonViewsRegistries } from '../widget-registry.js'
import { Checkbox } from '../primitives/checkbox.js'
import { MenuSelect } from '../primitives/menu-select.js'
import { ConditionalTooltip } from '../primitives/tooltip.js'
import { cn } from '../lib/cn.js'
import { useDismiss } from '../lib/use-dismiss.js'
import {
  getValueAtPath,
  getJsonViewViewRows,
  parseJsonViewPath,
  VALUE_PATH_MISSING,
  type CompiledJsonViewSchema,
  type CompiledJsonViewView,
  type JsonViewFilterOperator,
  type JsonViewPath,
  type JsonViewTypeRegistry,
} from '@script-it/json-views-core'

interface ViewField {
  defaultLabel: string
  direct: boolean
  kind: 'array' | 'boolean' | 'number' | 'object' | 'string' | 'mixed'
  path: string
  values: string[]
  type?: string
}

interface PropertyDraft extends ViewField {
  label: string
  visible: boolean
}

interface FilterDraft { path: string; operator: JsonViewFilterOperator; value: string }
interface SortDraft { path: string; direction: 'asc' | 'desc' }

export interface JsonViewViewPathOption {
  label: string
  path: string
  recordCollection: boolean
}

export interface JsonViewNewViewDraft extends JsonViewViewPathOption {
  display: 'table' | 'kanban'
  groupBy?: string
  name: string
}

const OPERATORS: Array<{ label: string; value: JsonViewFilterOperator }> = [
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

const DATE_OPERATORS: Array<{ label: string; value: JsonViewFilterOperator }> = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'lt', label: 'is before' },
  { value: 'lte', label: 'is on or before' },
  { value: 'gt', label: 'is after' },
  { value: 'gte', label: 'is on or after' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
]

function operatorsFor(field: ViewField | undefined, types: JsonViewTypeRegistry): Array<{ label: string; value: JsonViewFilterOperator }> {
  const defaults = field?.type === 'date' ? DATE_OPERATORS : OPERATORS
  const declared = field?.type ? types.filterOperators({ type: field.type }) : undefined
  return declared ? [
    ...defaults.filter((item) => declared.includes(item.value)),
    ...declared.filter((value) => !defaults.some((item) => item.value === value)).map((value) => ({ value, label: value })),
  ] : defaults
}

const INPUT_CLASS = 'h-8 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring'
const ICON_BUTTON_CLASS = 'grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function friendlyLabel(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value
}

function appendProperty(path: string, key: string): string {
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return `${path}.${key}`
  const escaped = key
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `${path}['${escaped}']`
}

function valueKind(values: unknown[]): ViewField['kind'] {
  const kinds = new Set(values.filter((value) => value !== null && value !== undefined).map((value) => (
    Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value
  )))
  if (kinds.size !== 1) return 'mixed'
  const kind = Array.from(kinds)[0]
  if (kind === 'boolean' || kind === 'number' || kind === 'string' || kind === 'array' || kind === 'object') return kind
  return 'mixed'
}

function primitiveOptions(values: unknown[]): string[] {
  const options = new Set<string>()
  values.forEach((value) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') options.add(String(value))
  })
  return options.size <= 20 ? Array.from(options) : []
}

function viewFieldKeys(view: CompiledJsonViewView, source: CompiledJsonViewView['path']): string[] | undefined {
  const prefixLength = view.path.segments.length
  const samePrefix = view.path.segments.every((segment, index) => {
    const candidate = source.segments[index]
    if (segment.kind !== candidate?.kind) return false
    if (segment.kind === 'property' && candidate.kind === 'property') return segment.key === candidate.key
    if (segment.kind === 'index' && candidate.kind === 'index') return segment.index === candidate.index
    return segment.kind === 'wildcard'
  })
  if (!samePrefix) return undefined
  if (source.segments[prefixLength]?.kind !== 'wildcard') return undefined
  const relative = source.segments.slice(prefixLength + 1)
  if (relative.length === 0 || relative.some((segment) => segment.kind !== 'property')) return undefined
  return relative.map((segment) => segment.kind === 'property' ? segment.key : '')
}

function discoverViewFields(view: CompiledJsonViewView, schema: readonly CompiledJsonViewSchema[]): ViewField[] {
  const rows = getJsonViewViewRows(view)
  const discovered = new Map<string, { labels: string[]; direct: boolean; values: unknown[] }>()
  const visit = (value: Record<string, unknown>, keys: string[]): void => {
    Object.entries(value).forEach(([key, child]) => {
      const childKeys = [...keys, key]
      const path = childKeys.reduce((source, segment) => appendProperty(source, segment), `${view.path.source}[*]`)
      const item = discovered.get(path) ?? {
        labels: childKeys.map(friendlyLabel),
        direct: childKeys.length === 1,
        values: [],
      }
      item.values.push(child)
      discovered.set(path, item)
      if (isRecord(child)) visit(child, childKeys)
    })
  }
  rows.forEach((row) => visit(row.value, []))
  const declaredPaths = [
    ...(view.columns?.map((column) => column.path) ?? []),
    ...(view.filter?.rules.map((rule) => rule.path) ?? []),
    ...view.sort.map((sort) => sort.path),
    ...(view.groupBy ? [view.groupBy] : []),
    ...(view.orderPath ? [view.orderPath] : []),
  ]
  declaredPaths.forEach((path) => {
    if (discovered.has(path.source)) return
    const keys = viewFieldKeys(view, path)
    if (!keys) return
    discovered.set(path.source, {
      labels: keys.map(friendlyLabel),
      direct: keys.length === 1,
      values: [],
    })
  })
  schema.forEach((entry) => {
    if (discovered.has(entry.path.source)) return
    const keys = viewFieldKeys(view, entry.path)
    if (!keys) return
    discovered.set(entry.path.source, {
      labels: keys.map(friendlyLabel),
      direct: keys.length === 1,
      values: [],
    })
  })
  return Array.from(discovered.entries()).map(([path, item]) => ({
    path,
    direct: item.direct,
    defaultLabel: item.labels.join(' › '),
    kind: valueKind(item.values),
    values: primitiveOptions(item.values),
    type: schema.find((entry) => entry.path.source === path)?.descriptor.type,
  }))
}

function rawColumns(raw: Record<string, unknown>): Array<{ label: string; path: string }> | undefined {
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) return undefined
  return raw.columns.flatMap((item) => (
    isRecord(item) && typeof item.label === 'string' && typeof item.path === 'string'
      ? [{ label: item.label, path: item.path }]
      : []
  ))
}

function propertyDrafts(raw: Record<string, unknown>, fields: ViewField[]): PropertyDraft[] {
  const columns = rawColumns(raw)
  const byPath = new Map(fields.map((field) => [field.path, field]))
  const selected = columns
    ? columns.flatMap((column): PropertyDraft[] => {
      const field = byPath.get(column.path)
      return field ? [{ ...field, label: column.label, visible: true }] : []
    })
    : fields.filter((field) => field.direct).map((field) => ({ ...field, label: field.defaultLabel, visible: true }))
  const selectedPaths = new Set(selected.map((field) => field.path))
  return [
    ...selected,
    ...fields.filter((field) => !selectedPaths.has(field.path)).map((field) => ({ ...field, label: field.defaultLabel, visible: false })),
  ]
}

function valueText(value: unknown, operator?: JsonViewFilterOperator): string {
  if ((operator === 'in' || operator === 'notIn') && Array.isArray(value)) return value.map(jsonValueText).join(', ')
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try { return JSON.stringify(value) }
  catch { return jsonValueText(value) }
}

function filtersFrom(raw: Record<string, unknown>): { match: 'all' | 'any'; rules: FilterDraft[] } {
  if (!isRecord(raw.filter)) return { match: 'all', rules: [] }
  const match = raw.filter.match === 'any' ? 'any' : 'all'
  const rules = Array.isArray(raw.filter.rules) ? raw.filter.rules.flatMap((item): FilterDraft[] => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.operator !== 'string') return []
    const operator = item.operator as JsonViewFilterOperator
    return [{ path: item.path, operator, value: valueText(item.value, operator) }]
  }) : []
  return { match, rules }
}

function sortsFrom(raw: Record<string, unknown>): SortDraft[] {
  return Array.isArray(raw.sort) ? raw.sort.flatMap((item): SortDraft[] => (
    isRecord(item) && typeof item.path === 'string' && (item.direction === 'asc' || item.direction === 'desc')
      ? [{ path: item.path, direction: item.direction }]
      : []
  )) : []
}

function filterValue(filter: FilterDraft, fields: ViewField[]): unknown {
  const field = fields.find((candidate) => candidate.path === filter.path)
  if (filter.operator === 'in' || filter.operator === 'notIn') {
    return filter.value.split(',').map((value) => parseFilterValue(value.trim(), field?.kind)).filter((value) => value !== '')
  }
  return parseFilterValue(filter.value, field?.kind)
}

function buildViewDraft({
  configurable,
  display,
  fields,
  filters,
  groupBy,
  match,
  name,
  properties,
  rawView,
  sorts,
}: {
  configurable: boolean
  display: 'adaptive' | 'kanban'
  fields: ViewField[]
  filters: FilterDraft[]
  groupBy: string
  match: 'all' | 'any'
  name: string
  properties: PropertyDraft[]
  rawView: Record<string, unknown>
  sorts: SortDraft[]
}): { error?: string; value?: Record<string, unknown> } {
  const visibleProperties = properties.filter((property) => property.visible)
  if (!name.trim()) return { error: 'Give the view a name' }
  if (configurable && visibleProperties.length === 0) return { error: 'Show at least one property' }
  if (configurable && display === 'kanban' && !groupBy) return { error: 'Choose a property to group the Kanban by' }

  const next: Record<string, unknown> = { ...rawView, name: name.trim() }
  if (configurable) {
    const inferredProperties = fields.filter((field) => field.direct)
    const stillInferred = rawColumns(rawView) === undefined
      && visibleProperties.length === inferredProperties.length
      && visibleProperties.every((property, index) => (
        property.path === inferredProperties[index]?.path && property.label === property.defaultLabel
      ))
    if (stillInferred) delete next.columns
    else next.columns = visibleProperties.map((property) => ({ label: property.label.trim() || property.defaultLabel, path: property.path }))

    if (filters.length > 0) {
      next.filter = {
        ...(match === 'any' ? { match } : {}),
        rules: filters.map((filter) => ({
          path: filter.path,
          operator: filter.operator,
          ...((filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty') ? {} : { value: filterValue(filter, fields) }),
        })),
      }
    } else delete next.filter
    if (sorts.length > 0) next.sort = sorts
    else delete next.sort
    if (display === 'kanban') {
      next.display = 'kanban'
      if (rawView.groupBy !== groupBy) delete next.groupOrder
      next.groupBy = groupBy
      if (next.orderPath === groupBy) delete next.orderPath
    } else {
      delete next.display
      delete next.groupBy
      delete next.groupOrder
      delete next.orderPath
    }
  } else {
    delete next.columns
    delete next.filter
    delete next.sort
    delete next.display
    delete next.groupBy
    delete next.groupOrder
    delete next.orderPath
  }
  return { value: next }
}

function summaryForFilter(filters: FilterDraft[], fields: ViewField[], types: JsonViewTypeRegistry): string {
  if (filters.length === 0) return 'None'
  const filter = filters[0]
  const field = fields.find((candidate) => candidate.path === filter.path)?.defaultLabel ?? 'Property'
  const operator = operatorsFor(fields.find((candidate) => candidate.path === filter.path), types).find((candidate) => candidate.value === filter.operator)?.label ?? filter.operator
  const rule = `${field} ${operator}${filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty' ? '' : ` ${filter.value}`}`
  return filters.length === 1 ? rule : `${rule} +${filters.length - 1}`
}

function OptionsSection({
  children,
  defaultOpen = false,
  summary,
  title,
}: {
  children: ReactNode
  defaultOpen?: boolean
  summary: string
  title: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <details className="group border-t border-border" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-1 text-xs hover:bg-accent">
        <span className="w-20 shrink-0 font-medium text-foreground">{title}</span>
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">{summary}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
      </summary>
      <div className="px-1 pb-3 pt-1">{children}</div>
    </details>
  )
}

function FieldSelect({
  ariaLabel,
  fields,
  includeEmpty = false,
  onChange,
  value,
}: {
  ariaLabel: string
  fields: ViewField[]
  includeEmpty?: boolean
  onChange: (value: string) => void
  value: string
}) {
  return (
    <MenuSelect
      ariaLabel={ariaLabel}
      emptyOptionLabel={includeEmpty ? 'Select a property' : undefined}
      options={fields.map((field) => ({ value: field.path, label: field.defaultLabel }))}
      value={value}
      onChange={onChange}
    />
  )
}

function BuiltInViewSettings({
  disabled = false,
  hasUnsavedChanges = false,
  onDelete,
  onDuplicate,
  onPreview,
  onSave,
  rawView,
  saveMode = 'automatic',
  saveUnavailableReason,
  schema,
  unavailableReason,
  view,
}: {
  disabled?: boolean
  hasUnsavedChanges?: boolean
  onDelete?: () => Promise<void>
  onDuplicate?: () => Promise<void>
  onPreview?: (value: Record<string, unknown> | undefined) => void
  onSave: (value: Record<string, unknown>) => Promise<void>
  rawView: Record<string, unknown>
  saveMode?: 'automatic' | 'explicit'
  saveUnavailableReason?: string
  schema: readonly CompiledJsonViewSchema[]
  unavailableReason?: string
  view: CompiledJsonViewView
}) {
  const { types } = useJsonViewsRegistries()
  const fields = useMemo(() => discoverViewFields(view, schema), [schema, view])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(view.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [properties, setProperties] = useState<PropertyDraft[]>(() => propertyDrafts(rawView, fields))
  const initialFilter = filtersFrom(rawView)
  const [match, setMatch] = useState<'all' | 'any'>(initialFilter.match)
  const [filters, setFilters] = useState<FilterDraft[]>(initialFilter.rules)
  const [sorts, setSorts] = useState<SortDraft[]>(() => sortsFrom(rawView))
  const [display, setDisplay] = useState<'adaptive' | 'kanban'>(view.display === 'html' ? 'adaptive' : view.display)
  const [groupBy, setGroupBy] = useState(typeof rawView.groupBy === 'string' ? rawView.groupBy : '')
  const [error, setError] = useState<string>()
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const portalContainer = useJsonViewsPortalContainer()
  const position = useAnchoredPosition(open, triggerRef, popoverRef, 'bottom', 'end')
  const lastSavedRef = useRef<string | undefined>(JSON.stringify(rawView))
  const pendingKeyRef = useRef<string | undefined>(undefined)
  const skipNextAutomaticSaveRef = useRef(false)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const saveRevisionRef = useRef(0)

  const groupFields = fields.filter((field) => field.kind !== 'array' && field.kind !== 'object')
  const visibleProperties = properties.filter((property) => property.visible)
  const configurable = isRecordCollectionValue(view.value)
  const draft = useMemo(() => {
    try { return buildViewDraft({ configurable, display, fields, filters, groupBy, match, name, properties, rawView, sorts }) }
    catch (cause) { return { error: cause instanceof Error ? cause.message : 'Invalid filter value', value: undefined } }
  }, [configurable, display, fields, filters, groupBy, match, name, properties, rawView, sorts])
  const draftKey = draft.value ? JSON.stringify(draft.value) : undefined

  const reset = () => {
    const nextFilter = filtersFrom(rawView)
    setName(view.name)
    setConfirmDelete(false)
    setProperties(propertyDrafts(rawView, fields))
    setMatch(nextFilter.match)
    setFilters(nextFilter.rules)
    setSorts(sortsFrom(rawView))
    setDisplay(view.display === 'html' ? 'adaptive' : view.display)
    setGroupBy(typeof rawView.groupBy === 'string' ? rawView.groupBy : '')
    setError(undefined)
    setSaveState('idle')
  }

  const openSettings = () => {
    const sourceKey = JSON.stringify(rawView)
    reset()
    lastSavedRef.current = hasUnsavedChanges ? undefined : sourceKey
    pendingKeyRef.current = undefined
    skipNextAutomaticSaveRef.current = true
    setOpen(true)
  }

  const closeWithoutSaving = () => {
    onPreview?.(undefined)
    reset()
    setOpen(false)
  }

  const persistDraft = async (value: Record<string, unknown>, closeAfter = false) => {
    const key = JSON.stringify(value)
    if (saveUnavailableReason) {
      setError(saveUnavailableReason)
      return
    }
    if (key === lastSavedRef.current || key === pendingKeyRef.current) {
      if (closeAfter) {
        try {
          await saveChainRef.current
          onPreview?.(undefined)
          setOpen(false)
        } catch { /* The original save reports the error and keeps this open. */ }
      }
      return
    }
    const revision = ++saveRevisionRef.current
    pendingKeyRef.current = key
    setError(undefined)
    setSaveState('saving')
    const operation = saveChainRef.current.catch(() => {}).then(() => onSave(value))
    saveChainRef.current = operation
    try {
      await operation
      lastSavedRef.current = key
      if (pendingKeyRef.current === key) pendingKeyRef.current = undefined
      if (revision === saveRevisionRef.current) setSaveState('saved')
      if (closeAfter) {
        onPreview?.(undefined)
        setOpen(false)
      }
    } catch (saveError) {
      if (pendingKeyRef.current === key) pendingKeyRef.current = undefined
      if (revision === saveRevisionRef.current) {
        setSaveState('idle')
        setError(saveError instanceof Error ? saveError.message : 'Could not save this view')
      }
    }
  }

  const finishSettings = () => {
    if (saveMode === 'explicit') {
      setOpen(false)
      return
    }
    if (draft.value && draftKey !== lastSavedRef.current) void persistDraft(draft.value, true)
    else {
      onPreview?.(undefined)
      setOpen(false)
    }
  }

  useDismiss({
    enabled: open,
    onDismiss: finishSettings,
    insideRefs: [triggerRef, popoverRef],
    ignoreSelectors: ['[data-jsonviews-metadata-persistence-dialog]'],
  })

  useEffect(() => {
    if (!open) return
    if (skipNextAutomaticSaveRef.current) {
      skipNextAutomaticSaveRef.current = false
      if (!hasUnsavedChanges && draftKey) lastSavedRef.current = draftKey
      return
    }
    onPreview?.(draftKey === lastSavedRef.current ? undefined : draft.value)
    if (disabled) return
    if (saveMode !== 'automatic' || !draft.value || !draftKey || draftKey === lastSavedRef.current || draftKey === pendingKeyRef.current) return
    const timer = window.setTimeout(() => { void persistDraft(draft.value as Record<string, unknown>) }, 300)
    return () => window.clearTimeout(timer)
  }, [disabled, draft.value, draftKey, hasUnsavedChanges, onPreview, open, saveMode])

  const toggleProperty = (path: string, visible: boolean) => setProperties((current) => {
    const changed = current.map((property) => property.path === path ? { ...property, visible } : property)
    return [...changed.filter((property) => property.visible), ...changed.filter((property) => !property.visible)]
  })

  const moveProperty = (sourcePath: string, targetPath: string) => setProperties((current) => {
    const visible = current.filter((property) => property.visible)
    const sourceIndex = visible.findIndex((property) => property.path === sourcePath)
    const targetIndex = visible.findIndex((property) => property.path === targetPath)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current
    const [moved] = visible.splice(sourceIndex, 1)
    visible.splice(targetIndex, 0, moved)
    return [...visible, ...current.filter((property) => !property.visible)]
  })

  const save = async () => {
    if (!draft.value) {
      setError(draft.error ?? 'This view is not valid')
      return
    }
    await persistDraft(draft.value, true)
  }

  const runAction = async (action: () => Promise<void>) => {
    setError(undefined)
    try {
      await action()
      setOpen(false)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Could not update this view')
    }
  }

  const firstField = fields[0]
  return (
    <div className="relative shrink-0">
      <ConditionalTooltip enabled={unavailableReason !== undefined} label={unavailableReason ?? ''} side="bottom" align="end" delayDuration={200}>
        <span className="inline-flex" tabIndex={unavailableReason ? 0 : undefined}>
          <button ref={triggerRef} type="button" data-id="jsonView-edit-view" aria-label="View options" disabled={disabled || unavailableReason !== undefined} className={ICON_BUTTON_CLASS} onClick={openSettings}><Settings2 className="h-3.5 w-3.5" /></button>
        </span>
      </ConditionalTooltip>
      {open && typeof document !== 'undefined' && createPortal(
        <section ref={popoverRef} data-id="view-settings" style={position} className="z-[100] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-card p-2 text-xs text-foreground shadow-lg [transform-origin:top_right]">
          <header className="flex min-h-10 items-center gap-2 px-1 pb-2">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">View options</h3>
              <div className="mt-1 flex min-w-0 items-center gap-0.5">
                <input aria-label="View name" className="h-7 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring" value={name} onChange={(event) => setName(event.target.value)} />
                {onDuplicate && <button type="button" aria-label="Duplicate view" title="Duplicate view" disabled={disabled} className={ICON_BUTTON_CLASS} onClick={() => { void runAction(onDuplicate) }}><Copy className="h-3.5 w-3.5" /></button>}
                {onDelete && <button type="button" aria-label="Delete view" title="Delete view" disabled={disabled} className={`${ICON_BUTTON_CLASS} text-destructive hover:bg-destructive/10 hover:text-destructive`} onClick={() => setConfirmDelete(true)}><Trash2 className="h-3.5 w-3.5" /></button>}
              </div>
            </div>
          </header>

          {confirmDelete && onDelete && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-destructive/10 px-2 py-2 text-destructive">
              <span className="min-w-0 flex-1">Delete this view?</span>
              <button type="button" className="rounded-md px-2 py-1 hover:bg-accent" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" data-id="jsonView-confirm-delete-view" disabled={disabled} className="rounded-md bg-destructive px-2 py-1 text-destructive-foreground disabled:opacity-50" onClick={() => { void runAction(onDelete) }}>Delete</button>
            </div>
          )}

          {configurable && <><OptionsSection title="Layout" summary={display === 'kanban' ? 'Kanban' : 'Table'} defaultOpen>
            <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
              <button type="button" data-id="jsonView-layout-table" className={`flex h-8 items-center justify-center gap-1.5 rounded-md ${display === 'adaptive' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setDisplay('adaptive')}><Table2 className="h-3.5 w-3.5" /> Table</button>
              <button type="button" data-id="jsonView-layout-kanban" className={`flex h-8 items-center justify-center gap-1.5 rounded-md ${display === 'kanban' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setDisplay('kanban')}><Columns3 className="h-3.5 w-3.5" /> Kanban</button>
            </div>
            {display === 'kanban' && (
              <label className="mt-2 grid gap-1 text-muted-foreground">Group by
                <FieldSelect ariaLabel="Group by" fields={groupFields} includeEmpty value={groupBy} onChange={setGroupBy} />
              </label>
            )}
          </OptionsSection>

          <OptionsSection title="Properties" summary={`${visibleProperties.length} shown`}>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border">
              {properties.map((property) => (
                <div
                  key={property.path}
                  data-id="jsonView-property-option"
                  data-field-path={property.path}
                  draggable={property.visible}
                  className="flex min-h-9 items-center gap-2 border-b border-border px-2 last:border-b-0"
                  onDragStart={(event: DragEvent<HTMLDivElement>) => event.dataTransfer.setData('application/x-jsonView-view-property', property.path)}
                  onDragOver={(event) => { if (property.visible) event.preventDefault() }}
                  onDrop={(event) => {
                    event.preventDefault()
                    moveProperty(event.dataTransfer.getData('application/x-jsonView-view-property'), property.path)
                  }}
                >
                  <button
                    type="button"
                    aria-label={`Reorder ${property.defaultLabel}`}
                    disabled={!property.visible}
                    className="cursor-grab text-muted-foreground disabled:cursor-default disabled:opacity-25"
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      const index = visibleProperties.findIndex((item) => item.path === property.path)
                      const target = visibleProperties[index + (event.key === 'ArrowUp' ? -1 : 1)]
                      if (target) moveProperty(property.path, target.path)
                    }}
                  ><GripVertical className="h-3.5 w-3.5" /></button>
                  <Checkbox aria-label={`Show ${property.defaultLabel}`} checked={property.visible} onCheckedChange={(checked) => toggleProperty(property.path, checked === true)} />
                  {property.visible
                    ? <input aria-label={`${property.defaultLabel} label`} className="h-8 min-w-0 flex-1 bg-transparent px-1 text-xs outline-none focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-ring" value={property.label} onChange={(event) => setProperties((current) => current.map((item) => item.path === property.path ? { ...item, label: event.target.value } : item))} />
                    : <span className="min-w-0 flex-1 truncate text-muted-foreground">{property.defaultLabel}</span>}
                </div>
              ))}
            </div>
          </OptionsSection>

          <OptionsSection title="Filter" summary={summaryForFilter(filters, fields, types)}>
            {filters.length > 1 && (
              <label className="mb-2 flex items-center justify-between gap-2 text-muted-foreground">Match
                <MenuSelect ariaLabel="Filter match" options={[{ value: 'all', label: 'All rules' }, { value: 'any', label: 'Any rule' }]} value={match} onChange={(value) => setMatch(value === 'any' ? 'any' : 'all')} />
              </label>
            )}
            <div className="grid gap-2">
              {filters.map((filter, index) => {
                const field = fields.find((candidate) => candidate.path === filter.path)
                const hidesValue = filter.operator === 'isEmpty' || filter.operator === 'isNotEmpty'
                return (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(6.5rem,0.8fr)_auto] gap-1">
                    <FieldSelect ariaLabel={`Filter ${index + 1} property`} fields={fields} value={filter.path} onChange={(path) => setFilters((current) => current.map((item, itemIndex) => {
                      if (itemIndex !== index) return item
                      const nextField = fields.find((candidate) => candidate.path === path)
                      const allowed = operatorsFor(nextField, types)
                      return {
                        ...item,
                        path,
                        operator: allowed.some((operator) => operator.value === item.operator) ? item.operator : 'eq',
                        value: '',
                      }
                    }))} />
                    <MenuSelect ariaLabel={`Filter ${index + 1} condition`} options={operatorsFor(field, types).map((operator) => ({ value: operator.value, label: operator.label }))} value={filter.operator} onChange={(value) => setFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, operator: value as JsonViewFilterOperator } : item))} />
                    <button type="button" aria-label="Remove filter" className={ICON_BUTTON_CLASS} onClick={() => setFilters((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-3.5 w-3.5" /></button>
                    {!hidesValue && (field?.values.length
                      ? <MenuSelect ariaLabel={`Filter ${index + 1} value`} className="col-span-2" emptyOptionLabel="Select a value" options={field.values.map((value) => ({ value, label: value }))} value={filter.value} onChange={(value) => setFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value } : item))} />
                      : <input aria-label={`Filter ${index + 1} value`} className={`${INPUT_CLASS} col-span-2`} value={filter.value} placeholder={filter.operator === 'in' || filter.operator === 'notIn' ? 'Comma-separated values' : 'Value'} onChange={(event) => setFilters((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />)}
                  </div>
                )
              })}
            </div>
            <button type="button" data-id="jsonView-add-filter" disabled={!firstField} className="mt-2 flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" onClick={() => firstField && setFilters((current) => [...current, { path: firstField.path, operator: 'eq', value: firstField.values[0] ?? '' }])}><Plus className="h-3.5 w-3.5" /> Add filter</button>
          </OptionsSection>

          <OptionsSection title="Sort" summary={sorts.length === 0 ? 'None' : `${fields.find((field) => field.path === sorts[0].path)?.defaultLabel ?? 'Property'} ${sorts[0].direction === 'desc' ? 'descending' : 'ascending'}${sorts.length > 1 ? ` +${sorts.length - 1}` : ''}`}>
            <div className="grid gap-2">
              {sorts.map((sort, index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] gap-1">
                  <FieldSelect ariaLabel={`Sort ${index + 1} property`} fields={fields} value={sort.path} onChange={(path) => setSorts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, path } : item))} />
                  <MenuSelect ariaLabel={`Sort ${index + 1} direction`} options={[{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }]} value={sort.direction} onChange={(value) => setSorts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, direction: value === 'desc' ? 'desc' : 'asc' } : item))} />
                  <button type="button" aria-label="Remove sort" className={ICON_BUTTON_CLASS} onClick={() => setSorts((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
            <button type="button" data-id="jsonView-add-sort" disabled={!firstField} className="mt-2 flex h-7 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50" onClick={() => firstField && setSorts((current) => [...current, { path: firstField.path, direction: 'asc' }])}><Plus className="h-3.5 w-3.5" /> Add sort</button>
          </OptionsSection></>}

          {(error || draft.error) && <p role="alert" className="px-1 py-2 text-destructive">{error || draft.error}</p>}
          {saveMode === 'explicit' && (
            <footer className="flex justify-end gap-1 border-t border-border px-1 pt-2">
              <button type="button" className="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={closeWithoutSaving}>Cancel</button>
              <ConditionalTooltip enabled={saveUnavailableReason !== undefined} label={saveUnavailableReason ?? ''} side="bottom" align="end" delayDuration={200}>
                <span className="inline-flex" tabIndex={saveUnavailableReason ? 0 : undefined}>
                  <button type="button" data-id="jsonView-save-view" disabled={disabled || saveUnavailableReason !== undefined || saveState === 'saving'} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50" onClick={() => { void save() }}>Save view</button>
                </span>
              </ConditionalTooltip>
            </footer>
          )}
        </section>, portalContainer ?? document.body,
      )}
    </div>
  )
}

function collectionPath(path: Array<string | number>): string {
  return path.reduce<string>((source, segment) => typeof segment === 'number' ? `${source}[${segment}]` : appendProperty(source, segment), '$')
}

function isRecordCollectionValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isRecord)
  return isRecord(value) && Object.values(value).every(isRecord)
}

/** The option for one location, as a walk of the whole document would list it:
 * own properties only, nothing under `$jsonviews`, and the canonical path
 * spelling. Scalars are options too; they just are not record collections.
 * Without a path, the root is the option.
 */
function resolveViewPathOption(root: unknown, currentPath: string | undefined): JsonViewViewPathOption | undefined {
  if (!isRecord(root) && !Array.isArray(root)) return undefined
  const path: Array<string | number> = []
  let value: unknown = root
  if (currentPath !== undefined) {
    let segments: JsonViewPath['segments']
    try { segments = parseJsonViewPath(currentPath, { root: '$' }).segments } catch { return undefined }
    for (const segment of segments) {
      if (segment.kind === 'property') {
        if (segment.key === '$jsonviews' || !isRecord(value) || !Object.prototype.hasOwnProperty.call(value, segment.key)) return undefined
        value = value[segment.key]
        path.push(segment.key)
      } else if (segment.kind === 'index') {
        if (!Array.isArray(value) || !Object.prototype.hasOwnProperty.call(value, segment.index)) return undefined
        value = value[segment.index]
        path.push(segment.index)
      } else return undefined
    }
    if (collectionPath(path) !== currentPath) return undefined
  }
  return {
    path: collectionPath(path),
    label: path.length === 0 ? (Array.isArray(root) ? 'Data' : 'Root') : path.map((segment) => typeof segment === 'number' ? String(segment + 1) : friendlyLabel(segment)).join(' › '),
    recordCollection: isRecordCollectionValue(value),
  }
}

function collectionFields(
  root: unknown,
  option: JsonViewViewPathOption | undefined,
  schema: readonly CompiledJsonViewSchema[],
): ViewField[] {
  if (!option) return []
  const path = parseJsonViewPath(option.path, { root: '$' })
  const sourcePath: Array<string | number> = []
  path.segments.forEach((segment) => {
    if (segment.kind === 'property') sourcePath.push(segment.key)
    else if (segment.kind === 'index') sourcePath.push(segment.index)
  })
  const value = getValueAtPath(root, sourcePath)
  if (value === VALUE_PATH_MISSING) return []
  const view: CompiledJsonViewView = {
    id: '__new_view__',
    name: option.label,
    path,
    sourcePath,
    value,
    display: 'adaptive',
    sort: [],
    declarationIndex: -1,
    metadataPath: [],
  }
  return discoverViewFields(view, schema)
}

export function JsonViewAddView({
  align = 'start',
  currentPath,
  disabled = false,
  onAdd,
  root,
  schema,
  unavailableReason: unavailableReasonOverride,
}: {
  align?: 'start' | 'end'
  currentPath?: string
  disabled?: boolean
  onAdd: (option: JsonViewNewViewDraft) => Promise<void>
  root: unknown
  schema: readonly CompiledJsonViewSchema[]
  unavailableReason?: string
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [display, setDisplay] = useState<'table' | 'kanban'>('table')
  const [groupBy, setGroupBy] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLElement>(null)
  const portalContainer = useJsonViewsPortalContainer()
  const position = useAnchoredPosition(open, triggerRef, popoverRef, 'bottom', align)
  const selectedOption = useMemo(() => resolveViewPathOption(root, currentPath), [currentPath, root])
  const unavailableReason = unavailableReasonOverride
    ?? (selectedOption ? undefined : 'This location is not document data that a view can target.')
  // Field discovery reads every record; only the open popover uses it.
  const fields = useMemo(() => open ? collectionFields(root, selectedOption, schema) : [], [open, root, schema, selectedOption])
  const groupFields = fields.filter((field) => field.kind !== 'array' && field.kind !== 'object')
  const preferredGroup = groupFields.find((field) => field.type === 'select') ?? groupFields[0]
  const reset = () => {
    setName(selectedOption?.label ?? '')
    setDisplay('table')
    setGroupBy('')
    setSaving(false)
    setError(undefined)
  }
  const close = () => {
    setOpen(false)
    reset()
  }
  // A host conversion dialog lives outside this popover. Keep the draft open
  // while its save promise is pending so cancelling conversion is retryable.
  useDismiss({
    enabled: open && !saving,
    onDismiss: close,
    insideRefs: [triggerRef, popoverRef],
    ignoreSelectors: ['[data-jsonviews-metadata-persistence-dialog]'],
  })
  const add = async () => {
    if (!selectedOption) {
      setError('Choose a path')
      return
    }
    if (!name.trim()) {
      setError('Give the view a name')
      return
    }
    if (selectedOption.recordCollection && display === 'kanban' && !groupBy) {
      setError('Choose a property to group the Kanban by')
      return
    }
    setError(undefined)
    setSaving(true)
    try {
      await onAdd({
        ...selectedOption,
        name: name.trim(),
        display: selectedOption.recordCollection ? display : 'table',
        ...(selectedOption.recordCollection && display === 'kanban' ? { groupBy } : {}),
      })
      setOpen(false)
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Could not add this view')
      // Host dialogs may finish on the same click that dismisses their layer.
      // Reopen after that event so cancellation always leaves this draft retryable.
      window.setTimeout(() => setOpen(true), 0)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="relative shrink-0">
      <ConditionalTooltip enabled={unavailableReason !== undefined} label={unavailableReason ?? ''} side="bottom" align={align} delayDuration={200}>
      <button ref={triggerRef} type="button" data-id="jsonView-add-view" aria-label={unavailableReason ? `New view unavailable: ${unavailableReason}` : 'New view'} aria-disabled={disabled || unavailableReason !== undefined} title={unavailableReason ? undefined : 'Save this location as a view'} disabled={disabled} className={cn('grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50', unavailableReason && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground')} onClick={() => {
        if (unavailableReason) return
        if (open) close()
        else {
          reset()
          setOpen(true)
        }
      }}><Plus className="h-3.5 w-3.5" /></button>
      </ConditionalTooltip>
      {open && typeof document !== 'undefined' && createPortal(
        <section ref={popoverRef} data-id="jsonView-add-view-menu" aria-label="Create new view" style={position} className={cn('z-[100] w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-border bg-card p-3 text-xs text-foreground shadow-xl', align === 'end' ? '[transform-origin:top_right]' : '[transform-origin:top_left]')}>
          <header className="mb-2 px-0.5">
            <h3 className="text-sm font-medium">New view</h3>
            <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">Save the current location as a view.</p>
          </header>
          {selectedOption ? (
            <div className="grid gap-3">
              <label>
                <span className="sr-only">Name</span>
                <input autoFocus aria-label="New view name" className={`${INPUT_CLASS} w-full`} placeholder="View name" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              {selectedOption?.recordCollection ? <fieldset>
                <legend className="sr-only">View type</legend>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                  {([
                    { value: 'table', label: 'Table', Icon: Table2 },
                    { value: 'kanban', label: 'Kanban', Icon: Columns3 },
                  ] as const).map(({ value, label, Icon }) => (
                    <button key={value} type="button" data-id={`jsonView-new-${value}`} aria-pressed={display === value} className={cn('flex h-8 w-full items-center justify-center gap-1.5 rounded-md px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring', display === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')} onClick={() => {
                      setDisplay(value)
                      if (value === 'kanban' && !groupBy) setGroupBy(preferredGroup?.path ?? '')
                    }}><Icon className="h-3.5 w-3.5" />{label}</button>
                  ))}
                </div>
              </fieldset> : <p className="px-2 py-1.5 text-muted-foreground">Uses the natural JSON layout.</p>}
              {selectedOption?.recordCollection && display === 'kanban' && (
                <label className="grid gap-1 text-muted-foreground">Group by
                  <MenuSelect ariaLabel="New view group by" emptyOptionLabel="Select a property" options={groupFields.map((field) => ({ value: field.path, label: field.defaultLabel }))} value={groupBy} onChange={setGroupBy} />
                </label>
              )}
              {error && <p role="alert" className="text-destructive">{error}</p>}
              <footer className="flex justify-end gap-1.5 pt-0.5">
                <button type="button" className="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={close}>Cancel</button>
                <button type="button" data-id="jsonView-create-view" disabled={disabled || saving || (selectedOption?.recordCollection === true && display === 'kanban' && !groupBy)} className="h-8 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50" onClick={() => { void add() }}>{saving ? 'Creating…' : 'Create view'}</button>
              </footer>
            </div>
          ) : (
            <p className="px-2 pb-2 text-muted-foreground">This location cannot be saved as a view.</p>
          )}
        </section>, portalContainer ?? document.body,
      )}
    </div>
  )
}

export function JsonViewViewSettings(props: Parameters<typeof BuiltInViewSettings>[0]) {
  return props.view.display === 'html' ? <HtmlViewSettings {...props} /> : <BuiltInViewSettings {...props} />
}
