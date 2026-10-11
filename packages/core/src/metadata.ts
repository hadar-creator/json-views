import { MAX_HTML_VIEW_BYTES } from './html-view-limits.js'
import { assertJsonDepth } from './json-limits.js'
import { getValueAtPath, VALUE_PATH_MISSING, valuePathKey, type ValuePath } from './json-path.js'
import { compileSafePattern } from './safe-pattern.js'
import { defaultTypeRegistry, JSON_VIEW_OPTION_COLORS, type JsonViewOptionColor, type JsonViewTypeRegistry } from './type-registry.js'
import { compareDateValues, parseDateValue } from './date-type.js'
import { inferJsonViewMetadata, type InferredJsonViewMetadata } from './inference.js'
import { ANNOTATION_PROPERTIES, COMMON_FILTER_OPERATORS, VIEW_PROPERTIES, type JsonViewDiagnosticHelp } from './annotation-capabilities.js'
import { explainMetadataDiagnostics } from './diagnostics.js'

export type JsonViewPathRoot = '$'

export type JsonViewPathSegment =
  | { kind: 'property'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'wildcard' }

export interface JsonViewPath {
  source: string
  root: JsonViewPathRoot
  segments: JsonViewPathSegment[]
}

export interface JsonViewSchemaDescriptor {
  type: string
  title?: string
  description?: string
  required?: boolean
  minimum?: number | string | null
  maximum?: number | string | null
  defaultIncludeTime?: boolean
  pattern?: string
  options?: string[]
  optionColors?: Record<string, JsonViewOptionColor>
  placeholder?: string
  multiline?: boolean
  step?: number
  [key: string]: unknown
}

export interface CompiledJsonViewSchema {
  declaration: string
  path: JsonViewPath
  descriptor: JsonViewSchemaDescriptor
  declarationIndex: number
  specificity: readonly [concreteSegments: number, totalSegments: number]
  metadataPath: ValuePath
}

export interface CompiledJsonViewColumn {
  label: string
  path: JsonViewPath
  metadataPath: ValuePath
}

export type JsonViewFilterOperator =
  | 'eq' | 'neq' | 'in' | 'notIn'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'notContains'
  | 'isEmpty' | 'isNotEmpty'
  | (string & {})

export interface CompiledJsonViewFilterRule {
  /** Present only when this operand comes from the embedded source metadata. */
  sourceValuePath?: ValuePath
  path: JsonViewPath
  operator: JsonViewFilterOperator
  value?: unknown
  metadataPath: ValuePath
}

export interface CompiledJsonViewFilter {
  match: 'all' | 'any'
  rules: CompiledJsonViewFilterRule[]
}

export interface CompiledJsonViewSort {
  path: JsonViewPath
  direction: 'asc' | 'desc'
  metadataPath: ValuePath
}

export type JsonViewGroupValue = string | number | boolean | null

export interface CompiledJsonViewView {
  id: string
  name: string
  path: JsonViewPath
  sourcePath: ValuePath
  value: unknown
  display: 'adaptive' | 'kanban' | 'html'
  html?: string
  css?: string
  groupBy?: JsonViewPath
  groupOrder?: JsonViewGroupValue[]
  orderPath?: JsonViewPath
  columns?: CompiledJsonViewColumn[]
  filter?: CompiledJsonViewFilter
  sort: CompiledJsonViewSort[]
  declarationIndex: number
  metadataPath: ValuePath
}

export type JsonViewDiagnosticScope = 'metadata' | 'schema' | 'view' | 'value'

export interface JsonViewMetadataDiagnostic {
  scope: JsonViewDiagnosticScope
  code: string
  message: string
  metadataPath: ValuePath
  sourcePath?: ValuePath
  severity?: 'warning' | 'error'
  viewId?: string
  declaration?: string
  metadataSource?: 'embedded' | 'external' | 'inferred'
  help?: JsonViewDiagnosticHelp
}

export interface CompiledJsonViewMetadata {
  status: 'none' | 'ready' | 'invalid' | 'unsupported-version'
  metadata?: unknown
  metadataSource?: 'embedded' | 'external' | 'inferred'
  root: unknown
  recognized: boolean
  active: boolean
  schema: CompiledJsonViewSchema[]
  views: CompiledJsonViewView[]
  diagnostics: JsonViewMetadataDiagnostic[]
  inference?: InferredJsonViewMetadata
}

export const JSON_VIEW_PATH_MISSING = Symbol('jsonView-path-missing')

export interface ResolvedJsonViewPath {
  value: unknown | typeof JSON_VIEW_PATH_MISSING
  sourcePath: ValuePath
}

export interface JsonViewViewRow {
  key: string | number
  value: Record<string, unknown>
  sourcePath: ValuePath
}

const FILTER_OPERATORS = new Set<JsonViewFilterOperator>(COMMON_FILTER_OPERATORS)
const PRESENCE_OPERATORS = new Set<JsonViewFilterOperator>(['isEmpty', 'isNotEmpty'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function syntaxError(source: string, index: number, detail: string): SyntaxError {
  return new SyntaxError(`Invalid JSONPath ${JSON.stringify(source)} at character ${index}: ${detail}`)
}

function parseQuotedProperty(source: string, start: number): { key: string; next: number } {
  let index = start + 2
  let key = ''
  while (index < source.length) {
    const character = source[index]
    if (character === "'") {
      if (source[index + 1] !== ']') throw syntaxError(source, index + 1, 'expected ] after quoted property')
      return { key, next: index + 2 }
    }
    if (character !== '\\') {
      key += character
      index += 1
      continue
    }
    const escaped = source[index + 1]
    if (escaped === undefined) throw syntaxError(source, index, 'unterminated escape')
    const simpleEscapes: Record<string, string> = {
      "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    }
    if (own(simpleEscapes, escaped)) {
      key += simpleEscapes[escaped]
      index += 2
      continue
    }
    if (escaped === 'u') {
      const hex = source.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw syntaxError(source, index, 'invalid Unicode escape')
      key += String.fromCharCode(Number.parseInt(hex, 16))
      index += 6
      continue
    }
    throw syntaxError(source, index, `unsupported escape \\${escaped}`)
  }
  throw syntaxError(source, start, 'unterminated quoted property')
}

export function parseJsonViewPath(
  source: string,
  options: { root?: JsonViewPathRoot; allowWildcard?: boolean } = {},
): JsonViewPath {
  if (typeof source !== 'string' || source.length === 0) throw new SyntaxError('JSONPath must be a non-empty string')
  const root = source[0]
  if (root !== '$') throw syntaxError(source, 0, 'path must start with $')
  if (options.root && root !== options.root) throw syntaxError(source, 0, `path must start with ${options.root}`)

  const segments: JsonViewPathSegment[] = []
  let index = 1
  while (index < source.length) {
    if (source[index] === '.') {
      const start = index + 1
      index = start
      while (index < source.length && source[index] !== '.' && source[index] !== '[') index += 1
      const key = source.slice(start, index)
      if (!key || /\s/.test(key) || key === '*') throw syntaxError(source, start, 'invalid dot property')
      segments.push({ kind: 'property', key })
      continue
    }

    if (source[index] !== '[') throw syntaxError(source, index, 'expected . or [')
    if (source[index + 1] === "'") {
      const parsed = parseQuotedProperty(source, index)
      segments.push({ kind: 'property', key: parsed.key })
      index = parsed.next
      continue
    }
    const close = source.indexOf(']', index + 1)
    if (close < 0) throw syntaxError(source, index, 'unterminated index')
    const token = source.slice(index + 1, close)
    if (token === '*') {
      if (!options.allowWildcard) throw syntaxError(source, index + 1, 'wildcards are not allowed here')
      segments.push({ kind: 'wildcard' })
    } else {
      if (!/^(0|[1-9]\d*)$/.test(token)) throw syntaxError(source, index + 1, 'index must be a non-negative integer')
      const parsedIndex = Number(token)
      if (!Number.isSafeInteger(parsedIndex)) throw syntaxError(source, index + 1, 'index must be a safe integer')
      segments.push({ kind: 'index', index: parsedIndex })
    }
    index = close + 1
  }
  return { source, root, segments }
}

function pathSegmentsToValuePath(path: JsonViewPath): ValuePath {
  return path.segments.map((segment) => {
    if (segment.kind === 'property') return segment.key
    if (segment.kind === 'index') return segment.index
    throw new TypeError(`JSONPath ${JSON.stringify(path.source)} is not concrete`)
  })
}

export function resolveJsonViewPath(
  root: unknown,
  path: JsonViewPath,
): ResolvedJsonViewPath {
  const sourcePath = pathSegmentsToValuePath(path)
  let current = root
  for (const segment of path.segments) {
    if (segment.kind === 'property') {
      if (!isRecord(current) || !own(current, segment.key)) return { value: JSON_VIEW_PATH_MISSING, sourcePath }
      current = current[segment.key]
    } else if (segment.kind === 'index') {
      if (!Array.isArray(current) || !own(current as unknown as Record<string, unknown>, String(segment.index))) {
        return { value: JSON_VIEW_PATH_MISSING, sourcePath }
      }
      current = current[segment.index]
    } else {
      throw new TypeError(`JSONPath ${JSON.stringify(path.source)} is not concrete`)
    }
  }
  return { value: current, sourcePath }
}

/** Without a root, reads the compiled snapshot; supplying a root resolves the plan against it. */
export function getJsonViewViewRows(view: CompiledJsonViewView, root?: unknown): JsonViewViewRow[] {
  if (arguments.length < 2) return rowsForRecordCollection(view.value, view.sourcePath)
  const resolved = resolveJsonViewPath(root, view.path)
  return rowsForRecordCollection(resolved.value, resolved.sourcePath)
}

function rowsForRecordCollection(value: unknown, sourcePath: ValuePath): JsonViewViewRow[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => isRecord(item)
      ? [{ key: index, value: item, sourcePath: [...sourcePath, index] }]
      : [])
  }
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, item]) => isRecord(item)
    ? [{ key, value: item, sourcePath: [...sourcePath, key] }]
    : [])
}

export function resolveJsonViewRowPath(
  root: unknown,
  row: Pick<JsonViewViewRow, 'value' | 'sourcePath'>,
  path: JsonViewPath,
): ResolvedJsonViewPath {
  const prefix = path.segments.slice(0, row.sourcePath.length)
  const aligned = prefix.length === row.sourcePath.length && prefix.every((segment, index) => {
    const sourceSegment = row.sourcePath[index]
    if (segment.kind === 'wildcard') return true
    if (segment.kind === 'property') return segment.key === sourceSegment
    return segment.index === sourceSegment
  })
  if (!aligned) return { value: JSON_VIEW_PATH_MISSING, sourcePath: row.sourcePath }

  const remainder = path.segments.slice(row.sourcePath.length)
  if (remainder.some((segment) => segment.kind === 'wildcard')) {
    throw new TypeError(`JSONPath ${JSON.stringify(path.source)} selects more than one value per record`)
  }
  const currentRow = getValueAtPath(root, row.sourcePath)
  if (currentRow === VALUE_PATH_MISSING) return { value: JSON_VIEW_PATH_MISSING, sourcePath: row.sourcePath }
  const resolved = resolveJsonViewPath(currentRow, { ...path, segments: remainder })
  return { value: resolved.value, sourcePath: [...row.sourcePath, ...resolved.sourcePath] }
}

function diagnostic(
  diagnostics: JsonViewMetadataDiagnostic[],
  scope: JsonViewDiagnosticScope,
  code: string,
  message: string,
  metadataPath: ValuePath,
  details: Pick<JsonViewMetadataDiagnostic, 'sourcePath' | 'viewId' | 'declaration' | 'severity' | 'help'> = {},
): void {
  diagnostics.push({ scope, code, message, metadataPath, ...details })
}

function diagnoseUnknownProperties(
  value: Record<string, unknown>, allowed: readonly string[], metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[], scope: JsonViewDiagnosticScope, code: string,
  details: Pick<JsonViewMetadataDiagnostic, 'viewId' | 'declaration'> = {},
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    const suggestion = allowed.find((candidate) => candidate.toLowerCase() === key.toLowerCase())
    diagnostic(diagnostics, scope, code,
      `Unrecognized property ${JSON.stringify(key)}${suggestion ? `; use ${JSON.stringify(suggestion)} (case-sensitive)` : ''}; the built-in compiler does not use it`,
      [...metadataPath, key], { ...details, severity: 'warning' })
  }
}

function normalizeDescriptor(
  value: unknown,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  typeRegistry: JsonViewTypeRegistry,
): JsonViewSchemaDescriptor | undefined {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'schema', 'invalid-schema-descriptor', 'Schema descriptor must be an object', metadataPath)
    return undefined
  }
  if (typeof value.type !== 'string' || !value.type.trim()) {
    diagnostic(diagnostics, 'schema', 'invalid-schema-type', 'Schema descriptor must name a type', [...metadataPath, 'type'])
    return undefined
  }
  if (!typeRegistry.has(value.type)) {
    diagnostic(diagnostics, 'schema', 'unknown-schema-type', `No type named ${JSON.stringify(value.type)} is registered`, [...metadataPath, 'type'])
    return undefined
  }
  const supported = typeRegistry.get(value.type)?.descriptorProperties
  if (supported) {
    diagnoseUnknownProperties(value, [...supported, 'nullable'], metadataPath, diagnostics, 'schema', 'unknown-schema-property')
    if (value.pattern !== undefined && ['number', 'checkbox', 'multi-select'].includes(value.type)) {
      diagnostic(diagnostics, 'schema', 'inapplicable-schema-property', `pattern only checks strings; it does not constrain ${value.type} values`, [...metadataPath, 'pattern'], { severity: 'warning' })
    }
  }
  const knownProperties = new Set([
    'type', 'title', 'description', 'nullable', 'required', 'minimum', 'maximum',
    'defaultIncludeTime', 'pattern', 'options', 'optionColors', 'placeholder', 'multiline', 'step',
  ])
  const normalized: JsonViewSchemaDescriptor = {
    ...Object.fromEntries(Object.entries(value).filter(([key]) => !knownProperties.has(key))),
    type: value.type,
  }
  for (const key of ['title', 'description'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] === 'string') normalized[key] = value[key]
    else diagnostic(diagnostics, 'schema', `invalid-${key}`, `${key} must be a string`, [...metadataPath, key])
  }
  if (value.nullable !== undefined) {
    diagnostic(
      diagnostics,
      'schema',
      'unsupported-schema-property',
      'Optional fields already allow null; use required to reject empty values',
      [...metadataPath, 'nullable'],
    )
  }
  for (const key of ['required'] as const) {
    if (value[key] === undefined) continue
    if (typeof value[key] === 'boolean') normalized[key] = value[key]
    else diagnostic(diagnostics, 'schema', `invalid-${key}`, `${key} must be a boolean`, [...metadataPath, key])
  }
  delete normalized.minimum
  delete normalized.maximum
  for (const key of ['minimum', 'maximum'] as const) {
    if (value[key] === undefined) continue
    if (value.type === 'date') {
      if (value[key] === null) continue
      const parsed = parseDateValue(value[key])
      if (typeof value[key] === 'string' && (parsed.kind === 'date' || parsed.kind === 'datetime' || parsed.kind === 'floating-datetime')) normalized[key] = value[key]
      else diagnostic(diagnostics, 'schema', `invalid-${key}`, `${key} must be a date or date and time`, [...metadataPath, key])
    } else if (typeof value[key] === 'number' && Number.isFinite(value[key])) normalized[key] = value[key]
    else diagnostic(diagnostics, 'schema', `invalid-${key}`, `${key} must be a finite number`, [...metadataPath, key])
  }
  if (value.type === 'date' && typeof normalized.minimum === 'string' && typeof normalized.maximum === 'string'
    && (parseDateValue(normalized.minimum).kind === 'date') === (parseDateValue(normalized.maximum).kind === 'date')
    && compareDateValues(normalized.minimum, normalized.maximum) > 0) {
    diagnostic(diagnostics, 'schema', 'invalid-date-bounds', 'minimum must not be after maximum', metadataPath)
    delete normalized.minimum
    delete normalized.maximum
  }
  delete normalized.defaultIncludeTime
  if (value.defaultIncludeTime !== undefined) {
    if (typeof value.defaultIncludeTime === 'boolean') normalized.defaultIncludeTime = value.defaultIncludeTime
    else diagnostic(diagnostics, 'schema', 'invalid-defaultIncludeTime', 'defaultIncludeTime must be a boolean', [...metadataPath, 'defaultIncludeTime'])
  }
  if (value.pattern !== undefined) {
    if (typeof value.pattern !== 'string') {
      diagnostic(diagnostics, 'schema', 'invalid-pattern', 'pattern must be a string', [...metadataPath, 'pattern'])
    } else {
      try {
        compileSafePattern(value.pattern)
        normalized.pattern = value.pattern
      } catch (error) {
        diagnostic(diagnostics, 'schema', 'invalid-pattern', `pattern must use supported RE2 syntax: ${error instanceof Error ? error.message : String(error)}`, [...metadataPath, 'pattern'])
      }
    }
  }
  if (value.options !== undefined) {
    if (Array.isArray(value.options) && value.options.every((option) => typeof option === 'string')) {
      normalized.options = [...value.options]
    } else {
      diagnostic(diagnostics, 'schema', 'invalid-options', 'options must be an array of strings', [...metadataPath, 'options'])
    }
  }
  if (value.optionColors !== undefined) {
    if (value.type !== 'select' && value.type !== 'multi-select') {
      diagnostic(diagnostics, 'schema', 'invalid-optionColors', 'optionColors is only supported by select and multi-select descriptors', [...metadataPath, 'optionColors'])
    } else if (!isRecord(value.optionColors)) {
      diagnostic(diagnostics, 'schema', 'invalid-optionColors', 'optionColors must map option values to built-in palette colors', [...metadataPath, 'optionColors'])
    } else {
      const optionColors: Record<string, JsonViewOptionColor> = Object.create(null)
      for (const [option, color] of Object.entries(value.optionColors)) {
        if (typeof color === 'string' && (JSON_VIEW_OPTION_COLORS as readonly string[]).includes(color)) {
          optionColors[option] = color as JsonViewOptionColor
        } else {
          diagnostic(diagnostics, 'schema', 'invalid-option-color', `Color for ${JSON.stringify(option)} must be one of ${JSON_VIEW_OPTION_COLORS.join(', ')}`, [...metadataPath, 'optionColors', option])
        }
      }
      normalized.optionColors = optionColors
    }
  }
  if (value.placeholder !== undefined) {
    if (typeof value.placeholder === 'string') normalized.placeholder = value.placeholder
    else diagnostic(diagnostics, 'schema', 'invalid-placeholder', 'placeholder must be a string', [...metadataPath, 'placeholder'])
  }
  if (value.multiline !== undefined) {
    if (typeof value.multiline === 'boolean') normalized.multiline = value.multiline
    else diagnostic(diagnostics, 'schema', 'invalid-multiline', 'multiline must be a boolean', [...metadataPath, 'multiline'])
  }
  if (value.step !== undefined) {
    if (typeof value.step === 'number' && Number.isFinite(value.step) && value.step > 0) normalized.step = value.step
    else diagnostic(diagnostics, 'schema', 'invalid-step', 'step must be a positive finite number', [...metadataPath, 'step'])
  }
  if (typeof normalized.minimum === 'number' && typeof normalized.maximum === 'number' && normalized.minimum > normalized.maximum) {
    diagnostic(diagnostics, 'schema', 'invalid-number-bounds', 'minimum must not exceed maximum', metadataPath)
    delete normalized.minimum
    delete normalized.maximum
  }
  const descriptorIssue = typeRegistry.validateDescriptor(normalized)
  if (descriptorIssue) {
    diagnostic(diagnostics, 'schema', 'invalid-type-descriptor', descriptorIssue, metadataPath)
    return undefined
  }
  return normalized
}

function schemaSpecificity(path: JsonViewPath): readonly [number, number] {
  return [path.segments.filter((segment) => segment.kind !== 'wildcard').length, path.segments.length]
}

function pathsOverlap(left: JsonViewPath, right: JsonViewPath): boolean {
  if (left.root !== right.root || left.segments.length !== right.segments.length) return false
  return left.segments.every((segment, index) => {
    const other = right.segments[index]
    if (segment.kind === 'wildcard') return true
    if (other.kind === 'wildcard') return true
    if (segment.kind !== other.kind) return false
    return segment.kind === 'property'
      ? segment.key === (other as Extract<JsonViewPathSegment, { kind: 'property' }>).key
      : segment.index === (other as Extract<JsonViewPathSegment, { kind: 'index' }>).index
  })
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function matchesJsonViewPath(path: JsonViewPath, sourcePath: ValuePath): boolean {
  const segments = path.segments
  if (path.root !== '$' || segments.length !== sourcePath.length) return false
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    if (segment.kind === 'wildcard') continue
    if ((segment.kind === 'property' ? segment.key : segment.index) !== sourcePath[index]) return false
  }
  return true
}

/** More concrete segments win, then longer paths, then the earlier declaration. */
function outranks(candidate: CompiledJsonViewSchema, current: CompiledJsonViewSchema): boolean {
  if (candidate.specificity[0] !== current.specificity[0]) return candidate.specificity[0] > current.specificity[0]
  if (candidate.specificity[1] !== current.specificity[1]) return candidate.specificity[1] > current.specificity[1]
  return candidate.declarationIndex < current.declarationIndex
}

export function schemaForJsonViewPath(
  schema: readonly CompiledJsonViewSchema[],
  sourcePath: ValuePath,
): CompiledJsonViewSchema | undefined {
  // Keeps the earliest of the best-ranked matches, exactly as a stable sort would.
  let winner: CompiledJsonViewSchema | undefined
  for (const entry of schema) {
    if (matchesJsonViewPath(entry.path, sourcePath) && (!winner || outranks(entry, winner))) winner = entry
  }
  return winner
}

function parseDeclaredPath(
  value: unknown,
  expectedRoot: JsonViewPathRoot,
  allowWildcard: boolean,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  scope: 'schema' | 'view',
  code: string,
  details: Pick<JsonViewMetadataDiagnostic, 'viewId' | 'declaration'> = {},
): JsonViewPath | undefined {
  if (typeof value !== 'string') {
    diagnostic(diagnostics, scope, code, 'Path must be a string', metadataPath, details)
    return undefined
  }
  try {
    return parseJsonViewPath(value, { root: expectedRoot, allowWildcard })
  } catch (error) {
    diagnostic(diagnostics, scope, code, error instanceof Error ? error.message : 'Invalid JSONPath', metadataPath, details)
    return undefined
  }
}

function compileSchema(
  value: unknown,
  diagnostics: JsonViewMetadataDiagnostic[],
  typeRegistry: JsonViewTypeRegistry,
): CompiledJsonViewSchema[] {
  const schemaPath: ValuePath = ['$jsonviews', 'schema']
  if (value === undefined) return []
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'metadata', 'invalid-schema-map', '$jsonviews.schema must be an object', schemaPath)
    return []
  }
  const compiled: CompiledJsonViewSchema[] = []
  Object.entries(value).forEach(([declaration, descriptorValue], declarationIndex) => {
    const metadataPath: ValuePath = [...schemaPath, declaration]
    const path = parseDeclaredPath(
      declaration, '$', true, metadataPath, diagnostics, 'schema', 'invalid-schema-path', { declaration },
    )
    const descriptor = normalizeDescriptor(descriptorValue, metadataPath, diagnostics, typeRegistry)
    if (!path || !descriptor) return
    compiled.push({
      declaration,
      path,
      descriptor,
      declarationIndex,
      specificity: schemaSpecificity(path),
      metadataPath,
    })
  })

  compiled.forEach((entry, index) => {
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = compiled[previousIndex]
      if (entry.specificity[0] !== previous.specificity[0]
        || entry.specificity[1] !== previous.specificity[1]
        || !pathsOverlap(entry.path, previous.path)
        || canonicalValue(entry.descriptor) === canonicalValue(previous.descriptor)) continue
      diagnostic(
        diagnostics,
        'schema',
        'schema-specificity-conflict',
        `Conflicts with equally specific declaration ${JSON.stringify(previous.declaration)}; the earlier declaration wins`,
        entry.metadataPath,
        { declaration: entry.declaration },
      )
      break
    }
  })

  // Legacy body annotations retain rich-text rendering without a singular record role.
  compiled.forEach((entry) => {
    if (entry.descriptor.type === 'body') entry.descriptor = { ...entry.descriptor, type: 'markdown' }
  })
  return compiled
}

function inferSchemaOptions(root: unknown, schema: readonly CompiledJsonViewSchema[]): void {
  for (const entry of schema) {
    const type = entry.descriptor.type
    if (type !== 'select' && type !== 'multi-select') continue
    const options = new Set(entry.descriptor.options ?? [])
    visitSchemaLocations(root, entry, (value) => {
      if (type === 'select' && typeof value === 'string' && value !== '') options.add(value)
      if (type === 'multi-select' && Array.isArray(value)) {
        value.forEach((item) => {
          if (typeof item === 'string' && item !== '') options.add(item)
        })
      }
    })
    entry.descriptor = { ...entry.descriptor, options: Array.from(options) }
  }
}

function normalizeColumns(
  value: unknown,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  viewId: string,
): CompiledJsonViewColumn[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'view', 'invalid-columns', 'columns must be an array', metadataPath, { viewId })
    return undefined
  }
  if (value.length === 0) return undefined
  const columns = value.flatMap((raw, index): CompiledJsonViewColumn[] => {
    const itemPath: ValuePath = [...metadataPath, index]
    if (isRecord(raw)) diagnoseUnknownProperties(raw, ['label', 'path'], itemPath, diagnostics, 'view', 'unknown-view-property', { viewId })
    const path = isRecord(raw) ? parseDeclaredPath(raw.path, '$', true, [...itemPath, 'path'], diagnostics, 'view', 'invalid-column-path', { viewId }) : undefined
    if (!isRecord(raw) || typeof raw.label !== 'string' || raw.label.trim() === '') {
      diagnostic(diagnostics, 'view', 'invalid-column', 'Column requires a non-empty label', isRecord(raw) ? [...itemPath, 'label'] : itemPath, { viewId })
      return []
    }
    return path ? [{ label: raw.label, path, metadataPath: itemPath }] : []
  })
  return columns.length > 0 ? columns : undefined
}

function normalizeFilter(
  value: unknown,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  viewId: string,
): CompiledJsonViewFilter | undefined {
  if (value === undefined) return undefined
  if (isRecord(value)) diagnoseUnknownProperties(value, ['match', 'rules'], metadataPath, diagnostics, 'view', 'unknown-view-property', { viewId })
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'view', 'invalid-filter', 'filter requires an object with a rules array', metadataPath, { viewId })
    return undefined
  }
  if (value.match !== undefined && value.match !== 'all' && value.match !== 'any') {
    diagnostic(diagnostics, 'view', 'invalid-filter', 'filter.match must be "all" or "any"', [...metadataPath, 'match'], { viewId })
  }
  if (!Array.isArray(value.rules)) {
    diagnostic(diagnostics, 'view', 'invalid-filter', 'filter.rules must be an array', [...metadataPath, 'rules'], { viewId })
    return undefined
  }
  const match = value.match === 'any' ? 'any' : 'all'
  const rules = value.rules.flatMap((raw, index): CompiledJsonViewFilterRule[] => {
    const itemPath: ValuePath = [...metadataPath, 'rules', index]
    if (isRecord(raw)) diagnoseUnknownProperties(raw, ['path', 'operator', 'value'], itemPath, diagnostics, 'view', 'unknown-view-property', { viewId })
    const path = isRecord(raw) ? parseDeclaredPath(raw.path, '$', true, [...itemPath, 'path'], diagnostics, 'view', 'invalid-filter-path', { viewId }) : undefined
    if (!isRecord(raw) || typeof raw.operator !== 'string' || !raw.operator.trim()) {
      diagnostic(diagnostics, 'view', 'invalid-filter-rule', 'Filter rule requires a non-empty operator', isRecord(raw) ? [...itemPath, 'operator'] : itemPath, { viewId })
      return []
    }
    const operator = raw.operator as JsonViewFilterOperator
    if (!PRESENCE_OPERATORS.has(operator) && !own(raw, 'value')) {
      diagnostic(diagnostics, 'view', 'invalid-filter-value', `${operator} requires a comparison value`, [...itemPath, 'value'], { viewId })
      return []
    }
    if ((operator === 'in' || operator === 'notIn') && !Array.isArray(raw.value)) {
      diagnostic(diagnostics, 'view', 'invalid-filter-value', `${operator} requires an array value`, [...itemPath, 'value'], { viewId })
      return []
    }
    if (PRESENCE_OPERATORS.has(operator) && own(raw, 'value')) {
      diagnostic(diagnostics, 'view', 'unused-filter-value', `${operator} ignores value`, [...itemPath, 'value'], { viewId, severity: 'warning' })
    }
    if (!path) return []
    return [{
      path,
      operator,
      ...(PRESENCE_OPERATORS.has(operator) ? {} : { value: raw.value }),
      metadataPath: itemPath,
    }]
  })
  return { match, rules }
}

function normalizeSort(
  value: unknown,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  viewId: string,
): CompiledJsonViewSort[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'view', 'invalid-sort', 'sort must be an array', metadataPath, { viewId })
    return []
  }
  return value.flatMap((raw, index): CompiledJsonViewSort[] => {
    const itemPath: ValuePath = [...metadataPath, index]
    if (isRecord(raw)) diagnoseUnknownProperties(raw, ['path', 'direction'], itemPath, diagnostics, 'view', 'unknown-view-property', { viewId })
    const path = isRecord(raw) ? parseDeclaredPath(raw.path, '$', true, [...itemPath, 'path'], diagnostics, 'view', 'invalid-sort-path', { viewId }) : undefined
    if (!isRecord(raw) || (raw.direction !== 'asc' && raw.direction !== 'desc')) {
      diagnostic(diagnostics, 'view', 'invalid-sort-entry', 'Sort entry requires direction "asc" or "desc"', isRecord(raw) ? [...itemPath, 'direction'] : itemPath, { viewId })
      return []
    }
    return path ? [{ path, direction: raw.direction, metadataPath: itemPath }] : []
  })
}

function normalizeGroupOrder(
  value: unknown,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  viewId: string,
): JsonViewGroupValue[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'view', 'invalid-group-order', 'groupOrder must be an array of scalar group values', metadataPath, { viewId })
    return undefined
  }
  const groups: JsonViewGroupValue[] = []
  const seen = new Set<string>()
  value.forEach((group, index) => {
    const valid = group === null || typeof group === 'string' || typeof group === 'boolean'
      || (typeof group === 'number' && Number.isFinite(group))
    if (!valid) {
      diagnostic(diagnostics, 'view', 'invalid-group-order', 'Each groupOrder entry must be a string, finite number, boolean, or null', [...metadataPath, index], { viewId })
      return
    }
    const key = group === null || group === '' ? 'empty' : `${typeof group}:${JSON.stringify(group)}`
    if (seen.has(key)) {
      diagnostic(diagnostics, 'view', 'invalid-group-order', 'groupOrder values must be unique', [...metadataPath, index], { viewId })
      return
    }
    seen.add(key)
    groups.push(group as JsonViewGroupValue)
  })
  return groups
}

function supportsRecordCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isRecord)
  return isRecord(value) && Object.values(value).every(isRecord)
}

function samePathSegment(left: JsonViewPathSegment, right: JsonViewPathSegment): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'property') return left.key === (right as typeof left).key
  if (left.kind === 'index') return left.index === (right as typeof left).index
  return true
}

function validatesAsViewField(viewPath: JsonViewPath, fieldPath: JsonViewPath): boolean {
  if (fieldPath.segments.length <= viewPath.segments.length + 1) return false
  if (!viewPath.segments.every((segment, index) => samePathSegment(segment, fieldPath.segments[index]))) return false
  if (fieldPath.segments[viewPath.segments.length]?.kind !== 'wildcard') return false
  return !fieldPath.segments.slice(viewPath.segments.length + 1).some((segment) => segment.kind === 'wildcard')
}

function validateViewField(
  root: unknown,
  rows: readonly JsonViewViewRow[],
  viewPath: JsonViewPath,
  fieldPath: JsonViewPath,
  metadataPath: ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  viewId: string,
  code: string,
): void {
  const fieldHelp = (): JsonViewDiagnosticHelp => {
    const keys = [...new Set(rows.slice(0, 20).flatMap((row) => Object.keys(row.value)))].slice(0, 12)
    const examples = keys.filter((key) => /^[A-Za-z_$][\w$]*$/.test(key)).map((key) => `${viewPath.source}[*].${key}`)
    return {
      fix: `Set this path to an existing field under ${viewPath.source}[*]. Use a concrete nested suffix for nested fields.`,
      expected: `${viewPath.source}, followed by one [*], then a nonempty concrete field path`,
      ...(examples.length ? { examples } : {}),
      capabilities: [
        'Use absolute $ paths, not @ relative paths. No additional wildcard may appear after the record selector.',
        'The path must resolve on at least one current record; an empty collection has no fields to check.',
        ...(keys.length ? [`Record keys sampled from up to 20 rows (not exhaustive): ${keys.map((key) => JSON.stringify(key)).join(', ')}.`] : []),
      ],
    }
  }
  if (!validatesAsViewField(viewPath, fieldPath)) {
    diagnostic(
      diagnostics,
      'view',
      code,
      `Path ${JSON.stringify(fieldPath.source)} must select one field from each record under ${JSON.stringify(viewPath.source)}, for example ${viewPath.source}[*].field`,
      metadataPath,
      { viewId, help: fieldHelp() },
    )
    return
  }
  if (rows.length === 0) return
  // Only a field missing from every record is reported, so stop at the first record that has it.
  let first: ResolvedJsonViewPath | undefined
  for (const row of rows) {
    const resolved = resolveJsonViewRowPath(root, row, fieldPath)
    if (resolved.value !== JSON_VIEW_PATH_MISSING) return
    first ??= resolved
  }
  diagnostic(
    diagnostics,
    'view',
    code,
    `Path ${JSON.stringify(fieldPath.source)} does not resolve on any record selected by ${JSON.stringify(viewPath.source)}`,
    metadataPath,
    { viewId, sourcePath: first?.sourcePath, help: fieldHelp() },
  )
}

function reserveViewId(raw: Record<string, unknown>, declarationIndex: number, usedIds: Set<string>): string {
  const requested = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `view-${declarationIndex + 1}`
  let id = requested
  let suffix = 2
  while (usedIds.has(id)) {
    id = `${requested}-${suffix}`
    suffix += 1
  }
  usedIds.add(id)
  return id
}

function compileViews(
  root: unknown,
  value: unknown,
  diagnostics: JsonViewMetadataDiagnostic[],
  schema: readonly CompiledJsonViewSchema[],
  typeRegistry: JsonViewTypeRegistry,
): CompiledJsonViewView[] {
  const viewsPath: ValuePath = ['$jsonviews', 'views']
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    diagnostic(diagnostics, 'metadata', 'invalid-views', '$jsonviews.views must be an array', viewsPath)
    return []
  }
  const usedIds = new Set<string>()
  return value.flatMap((raw, declarationIndex): CompiledJsonViewView[] => {
    const metadataPath: ValuePath = [...viewsPath, declarationIndex]
    if (!isRecord(raw)) {
      diagnostic(diagnostics, 'view', 'invalid-view', 'View declaration must be an object', metadataPath)
      return []
    }
    const viewDiagnostics: JsonViewMetadataDiagnostic[] = []
    if (Object.hasOwn(raw, 'title')) diagnostic(viewDiagnostics, 'view', 'removed-view-title', 'View title is not supported; put the identifying field first in columns', [...metadataPath, 'title'])
    const requestedId = typeof raw.id === 'string' ? raw.id.trim() : ''
    const duplicateId = requestedId !== '' && usedIds.has(requestedId)
    const id = reserveViewId(raw, declarationIndex, usedIds)
    diagnoseUnknownProperties(raw, VIEW_PROPERTIES, metadataPath, viewDiagnostics, 'view', 'unknown-view-property', { viewId: id })
    if (raw.id !== undefined && !requestedId) {
      diagnostic(viewDiagnostics, 'view', 'invalid-view-id', 'View id must be a non-empty string when supplied', [...metadataPath, 'id'], { viewId: id, severity: 'warning' })
    } else if (duplicateId) {
      diagnostic(viewDiagnostics, 'view', 'duplicate-view-id', `Duplicate view id ${JSON.stringify(requestedId)} was assigned ${JSON.stringify(id)}`, [...metadataPath, 'id'], { viewId: id, severity: 'warning' })
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) diagnostic(viewDiagnostics, 'view', 'invalid-view', 'View requires a non-empty name', [...metadataPath, 'name'], { viewId: id })
    const path = parseDeclaredPath(raw.path, '$', false, [...metadataPath, 'path'], viewDiagnostics, 'view', 'invalid-view-path', { viewId: id })
    const groupBy = raw.groupBy === undefined ? undefined : parseDeclaredPath(raw.groupBy, '$', true, [...metadataPath, 'groupBy'], viewDiagnostics, 'view', 'invalid-group-path', { viewId: id })
    const groupOrder = normalizeGroupOrder(raw.groupOrder, [...metadataPath, 'groupOrder'], viewDiagnostics, id)
    const orderPath = raw.orderPath === undefined ? undefined : parseDeclaredPath(raw.orderPath, '$', true, [...metadataPath, 'orderPath'], viewDiagnostics, 'view', 'invalid-order-path', { viewId: id })
    const columns = normalizeColumns(raw.columns, [...metadataPath, 'columns'], viewDiagnostics, id)
    let filter = normalizeFilter(raw.filter, [...metadataPath, 'filter'], viewDiagnostics, id)
    const sort = normalizeSort(raw.sort, [...metadataPath, 'sort'], viewDiagnostics, id)
    if (raw.display !== undefined && raw.display !== 'kanban' && raw.display !== 'html') {
      diagnostic(viewDiagnostics, 'view', 'invalid-display', 'Supported display overrides are "kanban" and "html"', [...metadataPath, 'display'], { viewId: id })
    }
    if (raw.display === 'html') {
      if (typeof raw.html !== 'string' || !raw.html.trim()) diagnostic(viewDiagnostics, 'view', 'invalid-html', 'HTML views require a non-empty html string', [...metadataPath, 'html'], { viewId: id })
      if (raw.css !== undefined && typeof raw.css !== 'string') diagnostic(viewDiagnostics, 'view', 'invalid-html-css', 'css must be a string', [...metadataPath, 'css'], { viewId: id })
      for (const property of ['html', 'css']) if (typeof raw[property] === 'string' && new TextEncoder().encode(raw[property]).length > MAX_HTML_VIEW_BYTES) diagnostic(viewDiagnostics, 'view', 'html-size-limit', 'HTML and CSS are limited to 256 KiB each', [...metadataPath, property], { viewId: id })
      for (const property of ['columns', 'filter', 'sort', 'groupBy', 'groupOrder', 'orderPath']) if (raw[property] !== undefined) diagnostic(viewDiagnostics, 'view', 'incompatible-html', `${property} does not apply to HTML views`, [...metadataPath, property], { viewId: id })
    } else if (raw.html !== undefined || raw.css !== undefined) diagnostic(viewDiagnostics, 'view', 'incompatible-html', 'html and css require display: "html"', metadataPath, { viewId: id })
    // Report independent syntax errors together; defer data-dependent checks until the root resolves.
    const resolved = path ? resolveJsonViewPath(root, path) : undefined
    if (path && resolved?.value === JSON_VIEW_PATH_MISSING) {
      diagnostic(viewDiagnostics, 'view', 'unresolved-view-path', `View path ${JSON.stringify(path.source)} does not exist`, [...metadataPath, 'path'], { viewId: id, sourcePath: resolved.sourcePath })
    }
    if (!path || !resolved || resolved.value === JSON_VIEW_PATH_MISSING) {
      diagnostics.push(...viewDiagnostics)
      return []
    }

    const recordCollection = supportsRecordCollection(resolved.value)
    const rows = recordCollection ? rowsForRecordCollection(resolved.value, resolved.sourcePath) : []
    if (filter) {
      const rules = filter.rules.filter((rule) => {
        const descriptors = rows.length > 0 && validatesAsViewField(path, rule.path)
          ? rows.map((row) => schemaForJsonViewPath(schema, resolveJsonViewRowPath(root, row, rule.path).sourcePath)?.descriptor)
          : [[...schema].filter((entry) => pathsOverlap(entry.path, rule.path))
            .sort((left, right) => right.specificity[0] - left.specificity[0] || left.declarationIndex - right.declarationIndex)[0]?.descriptor]
        const unsupported = descriptors.findIndex((descriptor) => {
          const operators = descriptor ? typeRegistry.filterOperators(descriptor) : undefined
          return !(operators ? operators.includes(rule.operator) : FILTER_OPERATORS.has(rule.operator))
        })
        if (unsupported < 0) {
          if (!PRESENCE_OPERATORS.has(rule.operator) && descriptors.some((descriptor) => descriptor?.type === 'date')
            && !['date', 'datetime', 'floating-datetime'].includes(parseDateValue(rule.value).kind)) {
            diagnostic(viewDiagnostics, 'view', 'invalid-filter-value', 'Date comparison requires a valid date or timestamp string', [...rule.metadataPath, 'value'], { viewId: id, help: {
              fix: 'Set value to a valid calendar date or timestamp with seconds. To check for missing dates use isEmpty/isNotEmpty without value.',
              expected: 'YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss with optional fractional seconds and timezone offset',
              examples: ['2026-01-01', '2026-01-01T09:30:00Z'],
            } })
            return false
          }
          return true
        }
        diagnostic(viewDiagnostics, 'view', 'invalid-filter-operator', `${rule.operator} is not supported for ${descriptors[unsupported]?.type ?? 'untyped'} values`, [...rule.metadataPath, 'operator'], { viewId: id, help: {
          fix: 'Choose an operator supported by every applicable field type.',
          expected: `operator supported by ${descriptors[unsupported]?.type ?? 'untyped'} values`,
          allowedValues: [...new Set(descriptors.flatMap((descriptor) => descriptor ? [...(typeRegistry.filterOperators(descriptor) ?? COMMON_FILTER_OPERATORS)] : [...COMMON_FILTER_OPERATORS]))]
            .filter((operator) => descriptors.every((descriptor) => (descriptor ? typeRegistry.filterOperators(descriptor) ?? COMMON_FILTER_OPERATORS : COMMON_FILTER_OPERATORS).includes(operator))),
        } })
        return false
      })
      filter = { ...filter, rules }
    }
    const hasRecordConfiguration = columns !== undefined || filter !== undefined || sort.length > 0
      || groupBy !== undefined || groupOrder !== undefined || orderPath !== undefined

    if (orderPath && groupBy && canonicalValue(orderPath.segments) === canonicalValue(groupBy.segments)) {
      diagnostic(viewDiagnostics, 'view', 'conflicting-kanban-paths', 'orderPath must be different from groupBy', [...metadataPath, 'orderPath'], { viewId: id })
    }
    if (hasRecordConfiguration && !recordCollection) {
      diagnostic(viewDiagnostics, 'view', 'incompatible-view', 'Configured fields require an array of objects or dictionary of object records', metadataPath, { viewId: id, sourcePath: resolved.sourcePath })
    }
    if (recordCollection) {
      columns?.forEach((column) => validateViewField(root, rows, path, column.path, [...column.metadataPath, 'path'], viewDiagnostics, id, 'invalid-column-path'))
      filter?.rules.forEach((rule) => validateViewField(root, rows, path, rule.path, [...rule.metadataPath, 'path'], viewDiagnostics, id, 'invalid-filter-path'))
      sort.forEach((entry) => validateViewField(root, rows, path, entry.path, [...entry.metadataPath, 'path'], viewDiagnostics, id, 'invalid-sort-path'))
      if (groupBy) validateViewField(root, rows, path, groupBy, [...metadataPath, 'groupBy'], viewDiagnostics, id, 'invalid-group-path')
      if (orderPath) validateViewField(root, rows, path, orderPath, [...metadataPath, 'orderPath'], viewDiagnostics, id, 'invalid-order-path')
    }
    if (orderPath && recordCollection && validatesAsViewField(path, orderPath)) {
      for (const row of rows) {
        const order = resolveJsonViewRowPath(root, row, orderPath)
        if (order.value === JSON_VIEW_PATH_MISSING || typeof order.value !== 'number' || !Number.isFinite(order.value)) {
          diagnostic(viewDiagnostics, 'view', 'invalid-order-value', 'orderPath must resolve to a finite number on every record', [...metadataPath, 'orderPath'], { viewId: id, sourcePath: order.sourcePath })
        }
      }
    }

    let display: CompiledJsonViewView['display'] = 'adaptive'
    if (raw.display === 'html') {
      display = 'html'
    } else if (raw.display === 'kanban') {
      if (!groupBy || !recordCollection) {
        diagnostic(viewDiagnostics, 'view', 'incompatible-kanban', 'Kanban requires groupBy and a record collection', [...metadataPath, 'display'], { viewId: id, sourcePath: resolved.sourcePath })
      } else {
        display = 'kanban'
      }
    } else if (groupBy || groupOrder || orderPath) {
      diagnostic(viewDiagnostics, 'view', 'incompatible-kanban', 'groupBy, groupOrder, and orderPath are only valid for a Kanban view', metadataPath, { viewId: id })
    }

    diagnostics.push(...viewDiagnostics)
    if (viewDiagnostics.some((item) => item.severity !== 'warning')) return []

    return [{
      id,
      name,
      path,
      sourcePath: resolved.sourcePath,
      value: resolved.value,
      display,
      ...(display === 'html' ? { html: raw.html as string, css: (raw.css as string | undefined) ?? '' } : {}),
      ...(groupBy ? { groupBy } : {}),
      ...(groupOrder !== undefined ? { groupOrder } : {}),
      ...(orderPath ? { orderPath } : {}),
      ...(columns !== undefined ? { columns } : {}),
      ...(filter ? { filter } : {}),
      sort,
      declarationIndex,
      metadataPath,
    }]
  })
}

/** `path` materializes the concrete location on demand. `complete` is false for a
 * missing location cut short by a remaining wildcard, which is then shorter than
 * the entry's path. */
type SchemaLocationVisitor = (value: unknown, path: () => ValuePath, complete: boolean) => void

/** Visits every location a schema path selects, in document order, without
 * allocating a path per location. Missing data is visited once at its deepest
 * concrete prefix.
 */
function visitSchemaLocations(root: unknown, entry: CompiledJsonViewSchema, visit: SchemaLocationVisitor): void {
  const segments = entry.path.segments
  const stack: Array<string | number> = []
  let snapshot: ValuePath | undefined
  const path = (): ValuePath => snapshot ??= stack.slice()
  const report = (value: unknown, complete: boolean): void => {
    snapshot = undefined
    visit(value, path, complete)
  }
  const missing = (segmentIndex: number): void => {
    let pushed = 0
    for (let index = segmentIndex; index < segments.length; index += 1) {
      const part = segments[index]
      if (part.kind === 'wildcard') break
      stack.push(part.kind === 'property' ? part.key : part.index)
      pushed += 1
    }
    report(JSON_VIEW_PATH_MISSING, stack.length === segments.length)
    stack.length -= pushed
  }
  const descend = (value: unknown, segmentIndex: number): void => {
    if (segmentIndex === segments.length) {
      report(value, true)
      return
    }
    const segment = segments[segmentIndex]
    if (segment.kind === 'property') {
      if (!isRecord(value) || !own(value, segment.key)) { missing(segmentIndex); return }
      stack.push(segment.key)
      descend(value[segment.key], segmentIndex + 1)
      stack.pop()
      return
    }
    if (segment.kind === 'index') {
      if (!Array.isArray(value) || !own(value as unknown as Record<string, unknown>, String(segment.index))) { missing(segmentIndex); return }
      stack.push(segment.index)
      descend(value[segment.index], segmentIndex + 1)
      stack.pop()
      return
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        stack.push(index)
        descend(child, segmentIndex + 1)
        stack.pop()
      })
      return
    }
    if (!isRecord(value)) { missing(segmentIndex); return }
    for (const key of Object.keys(value)) {
      stack.push(key)
      descend(value[key], segmentIndex + 1)
      stack.pop()
    }
  }
  descend(root, 0)
}

function underAnyPath(paths: readonly ValuePath[], sourcePath: ValuePath): boolean {
  return paths.some((path) => path.length <= sourcePath.length && path.every((part, index) => part === sourcePath[index]))
}

function validateResolvedSchemaValue(
  value: unknown,
  descriptor: JsonViewSchemaDescriptor,
  entry: CompiledJsonViewSchema,
  path: () => ValuePath,
  diagnostics: JsonViewMetadataDiagnostic[],
  typeRegistry: JsonViewTypeRegistry,
  suppressRequiredPaths: readonly ValuePath[],
): void {
  // Most values are valid, so the path is only materialized for the ones that report.
  const suppressed = (sourcePath: ValuePath): boolean => suppressRequiredPaths.length > 0 && underAnyPath(suppressRequiredPaths, sourcePath)
  if (value === JSON_VIEW_PATH_MISSING) {
    if (!descriptor.required) return
    const sourcePath = path()
    if (!suppressed(sourcePath)) {
      diagnostic(diagnostics, 'value', 'required-value-missing', 'Required value is missing', entry.metadataPath, { declaration: entry.declaration, sourcePath })
    }
    return
  }
  const issue = typeRegistry.validate(value, descriptor)
  if (issue) {
    const sourcePath = path()
    if (!(issue === 'A value is required' && suppressed(sourcePath))) {
      diagnostic(diagnostics, 'value', 'invalid-typed-value', issue, entry.metadataPath, { declaration: entry.declaration, sourcePath })
      return
    }
  }
  const warnings = typeRegistry.warnings(value, descriptor)
  if (warnings.length === 0) return
  const sourcePath = path()
  for (const warning of warnings) {
    diagnostic(diagnostics, 'value', 'typed-value-warning', warning, entry.metadataPath, { declaration: entry.declaration, sourcePath, severity: 'warning' })
  }
}

function validateSchemaValues(
  root: unknown,
  schema: readonly CompiledJsonViewSchema[],
  diagnostics: JsonViewMetadataDiagnostic[],
  typeRegistry: JsonViewTypeRegistry,
  suppressRequiredPaths: readonly ValuePath[],
): void {
  // A complete location has one winner among the entries of its length, so it
  // can only be claimed away from this entry by an overlapping higher-ranked
  // entry. Cut-off locations are the only ones several entries can share.
  const visited = new Set<string>()
  for (const entry of schema) {
    const rivals = schema.filter((other) => other !== entry
      && other.path.segments.length === entry.path.segments.length
      && outranks(other, entry) && pathsOverlap(other.path, entry.path))
    visitSchemaLocations(root, entry, (value, path, complete) => {
      if (complete) {
        if (rivals.length > 0) {
          const sourcePath = path()
          if (rivals.some((rival) => matchesJsonViewPath(rival.path, sourcePath))) return
        }
      } else {
        const sourcePath = path()
        const winner = schemaForJsonViewPath(schema, sourcePath)
        if (winner && winner !== entry) return
        const visitKey = valuePathKey(sourcePath)
        if (visited.has(visitKey)) return
        visited.add(visitKey)
      }
      validateResolvedSchemaValue(value, entry.descriptor, entry, path, diagnostics, typeRegistry, suppressRequiredPaths)
    })
  }
}

function compileMetadataValue(
  root: unknown,
  metadata: Record<string, unknown>,
  typeRegistry: JsonViewTypeRegistry,
  recognized: boolean,
  inference?: InferredJsonViewMetadata,
  metadataSource: 'embedded' | 'external' | 'inferred' = 'embedded',
  suppressRequiredPaths: readonly ValuePath[] = [],
  validateValues = true,
): CompiledJsonViewMetadata {
  const diagnostics: JsonViewMetadataDiagnostic[] = []
  diagnoseUnknownProperties(metadata, ANNOTATION_PROPERTIES, ['$jsonviews'], diagnostics, 'metadata', 'unknown-annotation-property')
  const schema = compileSchema(metadata.schema, diagnostics, typeRegistry)
  inferSchemaOptions(root, schema)
  const views = compileViews(root, metadata.views, diagnostics, schema, typeRegistry)
  if (metadataSource === 'embedded') {
    for (const view of views) for (const rule of view.filter?.rules ?? []) {
      rule.sourceValuePath = [...rule.metadataPath, 'value']
    }
  }
  // Inference is a presentation hint, not a user-authored validation contract.
  // A sampled collection can contain later values that do not match the guessed
  // type, and those values must not become upload-time errors.
  if (metadataSource !== 'inferred' && validateValues) {
    validateSchemaValues(root, schema, diagnostics, typeRegistry, suppressRequiredPaths)
  }
  return {
    root,
    metadata,
    metadataSource,
    status: 'ready',
    recognized,
    active: schema.length > 0 || views.length > 0 || diagnostics.length > 0,
    schema,
    views,
    diagnostics: explainMetadataDiagnostics(diagnostics, root, metadata, typeRegistry, metadataSource, schema),
    ...(inference ? { inference } : {}),
  }
}

export interface CompileJsonViewMetadataOptions {
  /** Explicit annotations take precedence over embedded annotations and inference. */
  metadata?: unknown
  /** Temporarily hides required-value diagnostics below paths for unfinished record drafts. */
  suppressRequiredPaths?: readonly ValuePath[]
  /** `false` skips checking every document value against the schema, which is
   * most of the compile time on large documents. The compiled schema, views, and
   * all other diagnostics are unchanged; value diagnostics are omitted. */
  validateValues?: boolean
}

export function compileJsonViewMetadata(
  root: unknown,
  typeRegistry: JsonViewTypeRegistry = defaultTypeRegistry,
  options: CompileJsonViewMetadataOptions = {},
): CompiledJsonViewMetadata {
  assertJsonDepth(root)
  assertJsonDepth(options.metadata)
  const validateValues = options.validateValues !== false
  const inactive = (): CompiledJsonViewMetadata => ({
    root, status: 'none', recognized: false, active: false, schema: [], views: [], diagnostics: [],
  })
  const supplied = (metadata: unknown, metadataSource: 'embedded' | 'external'): CompiledJsonViewMetadata => {
    if (isRecord(metadata) && metadata.version === 1) {
      return compileMetadataValue(root, metadata, typeRegistry, true, undefined, metadataSource, options.suppressRequiredPaths, validateValues)
    }
    const unsupported = isRecord(metadata) && Number.isInteger(metadata.version) && Number(metadata.version) > 0
    return {
      ...inactive(),
      metadata,
      metadataSource,
      status: unsupported ? 'unsupported-version' : 'invalid',
      diagnostics: explainMetadataDiagnostics([{
        scope: 'metadata',
        code: unsupported ? 'unsupported-metadata-version' : 'invalid-metadata',
        message: unsupported ? `Unsupported JSON Views annotation version: ${String(metadata.version)}` : 'Annotations must be an object with version: 1',
        metadataPath: unsupported ? ['$jsonviews', 'version'] : ['$jsonviews'],
      }], root, metadata, typeRegistry, metadataSource),
    }
  }
  if (Object.prototype.hasOwnProperty.call(options, 'metadata')) return supplied(options.metadata, 'external')
  if (isRecord(root)) {
    if (own(root, '$jsonviews')) return supplied(root.$jsonviews, 'embedded')
  }
  const inference = inferJsonViewMetadata(root)
  if (Object.keys(inference.schema).length === 0 && inference.views.length === 0) return inactive()
  return compileMetadataValue(root, inference as unknown as Record<string, unknown>, typeRegistry, false, inference, 'inferred', options.suppressRequiredPaths, validateValues)
}
