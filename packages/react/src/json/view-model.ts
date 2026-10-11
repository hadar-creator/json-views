import { schemaForJsonViewPath, getValueAtPath, isJsonViewTableCandidate, VALUE_PATH_MISSING, type ValuePath } from '@script-it/json-views-core'
import { JSON_VIEW_PATH_MISSING, inferJsonViewRecordTitleKey, parseJsonViewPath, resolveJsonViewRowPath, type CompiledJsonViewMetadata, type CompiledJsonViewView, type JsonViewPath, type JsonViewSchemaDescriptor, type JsonViewViewRow } from '@script-it/json-views-core'
import { isLongText } from './long-text.js'


export function isRecordCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value).every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
}

export function presentsRecordCollection(view: CompiledJsonViewView, forceTable = false): boolean {
  if (!isRecordCollection(view.value)) return false
  if (view.display === 'kanban') return true
  if (view.declarationIndex < 0 && !forceTable) return Array.isArray(view.value) && isJsonViewTableCandidate(view.value)
  return view.columns !== undefined
    || view.filter !== undefined
    || view.sort.length > 0
    || (Array.isArray(view.value)
      ? view.value.length > 0
      : Object.keys(view.value as Record<string, unknown>).length > 0)
}

export function matchesSearch(value: unknown, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  try {
    return JSON.stringify(value).toLocaleLowerCase().includes(normalized)
  } catch {
    return String(value).toLocaleLowerCase().includes(normalized)
  }
}

// A stable empty result keeps memos that depend on the raw views from recomputing every render.
const NO_RAW_VIEWS: readonly unknown[] = Object.freeze([])

export function rawViewsFor(compiled: CompiledJsonViewMetadata): readonly unknown[] {
  const metadata = compiled.metadata
  if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const views = (metadata as Record<string, unknown>).views
    if (Array.isArray(views)) return views
  }
  return compiled.inference?.views ?? NO_RAW_VIEWS
}

export function rawViewFor(compiled: CompiledJsonViewMetadata, view: CompiledJsonViewView): Record<string, unknown> | undefined {
  const raw = rawViewsFor(compiled)[view.declarationIndex]
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined
}

export function uniqueViewName(label: string, views: readonly unknown[]): string {
  const used = new Set(views.flatMap((view) => (
    view !== null && typeof view === 'object' && !Array.isArray(view) && typeof (view as Record<string, unknown>).name === 'string'
      ? [String((view as Record<string, unknown>).name).toLocaleLowerCase()]
      : []
  )))
  let name = label
  let suffix = 2
  while (used.has(name.toLocaleLowerCase())) {
    name = `${label} ${suffix}`
    suffix += 1
  }
  return name
}

export function uniqueViewId(name: string, views: readonly unknown[]): string {
  const used = new Set(views.flatMap((view) => (
    view !== null && typeof view === 'object' && !Array.isArray(view) && typeof (view as Record<string, unknown>).id === 'string'
      ? [String((view as Record<string, unknown>).id)]
      : []
  )))
  const base = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'view'
  let id = base
  let suffix = 2
  while (used.has(id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

export function inferredDescriptor(value: unknown): JsonViewSchemaDescriptor {
  if (typeof value === 'boolean') return { type: 'checkbox' }
  if (typeof value === 'number') return { type: 'number' }
  return { type: 'text' }
}

export function jsonPathForValuePath(path: ValuePath): string {
  return path.reduce<string>((source, segment) => {
    if (typeof segment === 'number') return `${source}[${segment}]`
    if (/^[A-Za-z_$][\w$]*$/.test(segment)) return `${source}.${segment}`
    const escaped = segment
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
    return `${source}['${escaped}']`
  }, '$')
}

export function rowHasLongText(compiled: CompiledJsonViewMetadata, rowPath: ValuePath): boolean {
  const row = getValueAtPath(compiled.root, rowPath)
  return row !== null && typeof row === 'object' && !Array.isArray(row) && Object.entries(row).some(([key, value]) => isLongText(value, schemaForJsonViewPath(compiled.schema, [...rowPath, key])?.descriptor))
}

export interface RowTitleField {
  label: string
  path: ValuePath
  value: unknown
}

export function titleFieldForRow(root: unknown, view: CompiledJsonViewView, row: JsonViewViewRow): RowTitleField | undefined {
  const first = view.columns?.[0]
  if (first) {
    const resolved = resolveJsonViewRowPath(root, row, first.path)
    return { label: first.label, path: resolved.sourcePath, value: resolved.value === JSON_VIEW_PATH_MISSING ? undefined : resolved.value }
  }
  const key = inferJsonViewRecordTitleKey([row.value], false)
  if (key) return { label: key, path: [...row.sourcePath, key], value: row.value[key] }
  return undefined
}

export function nestedRecordView(
  root: unknown,
  rowPath: ValuePath,
  titleKey: string | undefined,
  name: string,
): { row: JsonViewViewRow; view: CompiledJsonViewView } | undefined {
  const row = rowAtSourcePath(root, rowPath)
  if (!row) return undefined
  return {
    row,
    view: {
      id: `nested:${JSON.stringify(rowPath)}`,
      name,
      path: parseJsonViewPath(jsonPathForValuePath(rowPath)),
      sourcePath: rowPath,
      value: row.value,
      display: 'adaptive',
      ...(titleKey ? { columns: [{ label: titleKey, path: parseJsonViewPath(jsonPathForValuePath([...rowPath, titleKey])), metadataPath: [] }] } : {}),
      sort: [],
      declarationIndex: -1,
      metadataPath: [],
    },
  }
}

export function titleForRow(root: unknown, view: CompiledJsonViewView, row: JsonViewViewRow): string {
  const field = titleFieldForRow(root, view, row)
  if (field && field.value != null && String(field.value).trim()) return String(field.value)
  if (field) return 'Untitled'
  return String(row.key)
}

export function rowAtSourcePath(root: unknown, sourcePath: ValuePath | undefined): JsonViewViewRow | undefined {
  if (!sourcePath) return undefined
  const value = getValueAtPath(root, sourcePath)
  if (value === VALUE_PATH_MISSING || value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const key = sourcePath[sourcePath.length - 1] ?? '$'
  return { key, value: value as Record<string, unknown>, sourcePath }
}

export function rowForPage(view: CompiledJsonViewView): JsonViewViewRow | undefined {
  if (view.value === null || typeof view.value !== 'object' || Array.isArray(view.value)) return undefined
  return {
    key: view.sourcePath[view.sourcePath.length - 1] ?? view.name,
    value: view.value as Record<string, unknown>,
    sourcePath: view.sourcePath,
  }
}

export function pathLabel(path: ValuePath): string {
  return `$${path.map((segment) => (
    typeof segment === 'number'
      ? `[${segment}]`
      : /^[A-Za-z_$][\w$]*$/.test(segment)
        ? `.${segment}`
        : `[${JSON.stringify(segment)}]`
  )).join('')}`
}

export function sameJsonViewPath(left: JsonViewPath, right: JsonViewPath | undefined): boolean {
  if (!right || left.root !== right.root || left.segments.length !== right.segments.length) return false
  return left.segments.every((segment, index) => {
    const candidate = right.segments[index]
    if (segment.kind !== candidate?.kind) return false
    if (segment.kind === 'property') return segment.key === (candidate as typeof segment).key
    if (segment.kind === 'index') return segment.index === (candidate as typeof segment).index
    return true
  })
}
