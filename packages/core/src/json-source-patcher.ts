import { MAX_JSON_DEPTH, JsonDepthLimitError } from './json-limits.js'
import { isEditableAtomicValue, type AtomicValue } from './atomic-value.js'
import { describeValuePath, requireValueAtPath, type ValuePath } from './json-path.js'
import { sourceDiagnosticHelp } from './diagnostics.js'

function assertSameEditableAtomicType(current: unknown, next: unknown, path: ValuePath): void {
  if (!isEditableAtomicValue(current)) {
    throw new TypeError(`JSON path ${describeValuePath(path)} does not point to an editable atomic value`)
  }
  if (!isEditableAtomicValue(next)) {
    throw new TypeError(`Replacement at ${describeValuePath(path)} must be a finite editable JSON atomic value`)
  }

  const currentType = typeof current
  const nextType = typeof next
  if (currentType !== nextType) {
    throw new TypeError(`Replacement at ${describeValuePath(path)} must keep type ${currentType}`)
  }
}

interface JsonSourceNode {
  start: number
  end: number
  kind: 'atomic' | 'array' | 'object'
  items?: JsonSourceNode[]
  properties?: JsonSourceProperty[]
  propertyIndex?: Map<string, JsonSourceNode>
}

interface JsonSourceProperty {
  end: number
  key: string
  start: number
  value: JsonSourceNode
}

// Character codes the scanner dispatches on. The text is already valid JSON.
const QUOTE = 0x22
const COMMA = 0x2c
const MINUS = 0x2d
const COLON = 0x3a
const OPEN_BRACKET = 0x5b
const BACKSLASH = 0x5c
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

function isNumberCharacter(code: number): boolean {
  return isDigit(code) || code === 0x2e || code === MINUS || code === 0x2b || code === 0x65 || code === 0x45
}

class JsonSourceScanner {
  private index = 0
  private readonly source: string

  constructor(source: string) {
    this.source = source
  }

  parse(): JsonSourceNode {
    // Callers validate once with JSON.parse before scanning source spans.
    const source = this.source
    const root = this.parseValue()
    const frames: Array<{ node: JsonSourceNode; afterValue: boolean; property?: JsonSourceProperty }> = []
    const push = (node: JsonSourceNode, property?: JsonSourceProperty) => {
      if (node.kind === 'atomic') return
      if (frames.length >= MAX_JSON_DEPTH) throw new JsonDepthLimitError()
      frames.push({ node, afterValue: false, property })
    }
    push(root)
    while (frames.length) {
      const frame = frames[frames.length - 1]
      const node = frame.node
      this.skipWhitespace()
      const close = node.kind === 'array' ? CLOSE_BRACKET : CLOSE_BRACE
      if (source.charCodeAt(this.index) === close) {
        node.end = ++this.index
        if (frame.property) frame.property.end = node.end
        frames.pop()
        continue
      }
      if (frame.afterValue) {
        if (source.charCodeAt(this.index++) !== COMMA) throw new SyntaxError('Expected comma')
        this.skipWhitespace()
      }
      frame.afterValue = true
      if (node.kind === 'array') {
        const value = this.parseValue()
        node.items!.push(value)
        push(value)
      } else {
        const start = this.index
        // A key without escapes is its own text; JSON.parse decodes the rest.
        const key = this.scanString()
          ? JSON.parse(source.slice(start, this.index)) as string
          : source.slice(start + 1, this.index - 1)
        this.skipWhitespace()
        if (source.charCodeAt(this.index++) !== COLON) throw new SyntaxError('Expected colon')
        const value = this.parseValue()
        const property = { key, start, end: value.end, value }
        node.properties!.push(property)
        node.propertyIndex!.set(key, value)
        push(value, property)
      }
    }
    this.skipWhitespace()
    if (this.index !== source.length) throw new SyntaxError('Unexpected content after JSON value')
    return root
  }

  private skipWhitespace(): void {
    const source = this.source
    let index = this.index
    while (index < source.length && isJsonWhitespace(source.charCodeAt(index))) index += 1
    this.index = index
  }

  private parseValue(): JsonSourceNode {
    this.skipWhitespace()
    const start = this.index
    const code = this.source.charCodeAt(start)

    if (code === OPEN_BRACE) { this.index += 1; return { start, end: this.index, kind: 'object', properties: [], propertyIndex: new Map() } }
    if (code === OPEN_BRACKET) { this.index += 1; return { start, end: this.index, kind: 'array', items: [] } }
    if (code === QUOTE) {
      this.scanString()
      return { start, end: this.index, kind: 'atomic' }
    }
    if (code === 0x74) return this.scanLiteral(start, 'true')
    if (code === 0x66) return this.scanLiteral(start, 'false')
    if (code === 0x6e) return this.scanLiteral(start, 'null')
    return this.scanNumber(start)
  }

  /** Moves past the closing quote and reports whether the string used escapes. */
  private scanString(): boolean {
    const source = this.source
    if (source.charCodeAt(this.index) !== QUOTE) throw new SyntaxError('Expected JSON string')
    let index = this.index + 1
    let escaped = false
    while (index < source.length) {
      const code = source.charCodeAt(index)
      index += 1
      if (code === QUOTE) {
        this.index = index
        return escaped
      }
      if (code === BACKSLASH) {
        escaped = true
        index += 1
      }
    }
    this.index = index
    throw new SyntaxError('Unterminated JSON string')
  }

  private scanLiteral(start: number, literal: 'true' | 'false' | 'null'): JsonSourceNode {
    this.index += literal.length
    return { start, end: this.index, kind: 'atomic' }
  }

  private scanNumber(start: number): JsonSourceNode {
    const source = this.source
    let index = start
    while (index < source.length && isNumberCharacter(source.charCodeAt(index))) index += 1
    if (index === start) throw new SyntaxError('Expected JSON value')
    this.index = index
    return { start, end: index, kind: 'atomic' }
  }
}

function sourceNodeAtPath(root: JsonSourceNode, path: ValuePath): JsonSourceNode {
  let current = root
  for (let index = 0; index < path.length; index++) {
    const segment = path[index]
    if (current.kind === 'array' && typeof segment === 'number') {
      const child = current.items?.[segment]
      if (!child) throw new RangeError(`JSON path ${describeValuePath(path)} does not exist`)
      current = child
      continue
    }
    if (current.kind === 'object' && typeof segment === 'string') {
      const child = current.propertyIndex?.get(segment)
      if (!child) throw new RangeError(`JSON path ${describeValuePath(path)} does not exist`)
      current = child
      continue
    }
    throw new TypeError(`JSON path ${describeValuePath(path.slice(0, index))} is not the requested container type`)
  }
  return current
}

export interface JsonSourceRange {
  start: number
  end: number
}

/** Locates the exact source span represented by a parsed JSON value path. */
export function jsonSourceRangeAtPath(source: string, path: ValuePath): JsonSourceRange {
  return jsonSourceRangesAtPaths(source, [path])[0]
}

/** Locates several value paths with one source parse, preserving path order. */
export function jsonSourceRangesAtPaths(source: string, paths: readonly ValuePath[]): JsonSourceRange[] {
  JSON.parse(source)
  const root = new JsonSourceScanner(source).parse()
  return paths.map((path) => {
    const target = sourceNodeAtPath(root, path)
    return { start: target.start, end: target.end }
  })
}

/** Serializes only JSON data: finite numbers, strings, booleans, null, dense arrays,
 * and plain data objects. Accessors, toJSON methods, cycles and lossy coercions are rejected.
 */
export function stringifyJsonValue(value: unknown, space = 0): string {
  const indent = ' '.repeat(Math.max(0, Math.min(10, Math.trunc(space))))
  const ancestors = new Set<object>()
  const invalid = (): never => { throw new TypeError('Replacement must be valid JSON data without coercion') }
  const visit = (item: unknown, depth: number): string => {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return invalid()
      return Object.is(item, -0) ? '-0' : JSON.stringify(item)
    }
    if (typeof item !== 'object' || ancestors.has(item)) return invalid()
    if (depth >= MAX_JSON_DEPTH) throw new JsonDepthLimitError()
    const array = Array.isArray(item)
    const prototype: unknown = Object.getPrototypeOf(item)
    if (!array && prototype !== Object.prototype && prototype !== null) return invalid()
    ancestors.add(item)
    const keys = Reflect.ownKeys(item)
    const fields: string[] = []
    if (array) {
      if (keys.length !== item.length + 1) return invalid()
      for (let index = 0; index < item.length; index += 1) {
        const property = Object.getOwnPropertyDescriptor(item, String(index))
        if (!property || !('value' in property) || !property.enumerable) return invalid()
        fields.push(visit(property.value, depth + 1))
      }
    } else {
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(item, key)
        if (typeof key !== 'string' || !property || !('value' in property) || !property.enumerable) return invalid()
        fields.push(`${JSON.stringify(key)}:${indent ? ' ' : ''}${visit(property.value, depth + 1)}`)
      }
    }
    ancestors.delete(item)
    const open = array ? '[' : '{'
    const close = array ? ']' : '}'
    if (fields.length === 0) return open + close
    return indent
      ? `${open}\n${indent.repeat(depth + 1)}${fields.join(`,\n${indent.repeat(depth + 1)}`)}\n${indent.repeat(depth)}${close}`
      : `${open}${fields.join(',')}${close}`
  }
  return visit(value, 0)
}

function serializeReplacement(next: unknown, path: ValuePath, space = 0): string {
  try { return stringifyJsonValue(next, space) } catch (error) {
    throw new TypeError(`Replacement at ${describeValuePath(path)} must be valid JSON data`, { cause: error })
  }
}

export interface JsonSourceDiagnostic {
  /** The token belongs to an earlier duplicate property or one of its descendants. */
  shadowed?: boolean
  code: 'duplicate-key' | 'unsafe-number'
  sourcePath: ValuePath
  message: string
  token: string
  start: number
  end: number
  help?: import('./annotation-capabilities.js').JsonViewDiagnosticHelp
}

interface InspectionFrame {
  node: JsonSourceNode
  parent: InspectionFrame | undefined
  segment: string | number
  shadowed: boolean
}

/** Paths are rebuilt from parent links only for the few nodes that report something. */
function inspectionPath(frame: InspectionFrame): ValuePath {
  const path: Array<string | number> = []
  for (let current = frame; current.parent; current = current.parent) path.push(current.segment)
  return path.reverse()
}

/** Integers of at most 15 digits round-trip exactly; -0 is the one exception. */
function isPlainSafeInteger(token: string): boolean {
  let index = token.charCodeAt(0) === MINUS ? 1 : 0
  if (token.length - index < 1 || token.length - index > 15) return false
  if (index === 1 && token.length === 2 && token.charCodeAt(1) === 0x30) return false
  for (; index < token.length; index += 1) if (!isDigit(token.charCodeAt(index))) return false
  return true
}

function inspectSourceDiagnostics(source: string): JsonSourceDiagnostic[] {
  const tree = new JsonSourceScanner(source).parse()
  const diagnostics: JsonSourceDiagnostic[] = []
  const decimalKey = (token: string): string => {
    const [coefficient, exponent = '0'] = token.toLowerCase().split('e')
    const negative = coefficient.startsWith('-')
    const unsigned = negative ? coefficient.slice(1) : coefficient
    const [whole, fraction = ''] = unsigned.split('.')
    const digits = (whole + fraction).replace(/^0+/, '')
    if (!digits) return negative ? '-0' : '0'
    const significant = digits.replace(/0+$/, '')
    return `${negative ? '-' : ''}${significant}e${Number(exponent) - fraction.length + digits.length - significant.length}`
  }
  const pending: InspectionFrame[] = [{ node: tree, parent: undefined, segment: '', shadowed: false }]
  while (pending.length) {
    const frame = pending.pop()!
    const { node, shadowed } = frame
    if (node.kind === 'object') {
      const seen = new Set<string>()
      for (const property of node.properties!) {
        const childShadowed = shadowed || node.propertyIndex!.get(property.key) !== property.value
        const child: InspectionFrame = { node: property.value, parent: frame, segment: property.key, shadowed: childShadowed }
        if (seen.has(property.key)) diagnostics.push({
          code: 'duplicate-key', sourcePath: inspectionPath(child), token: JSON.stringify(property.key),
          ...(childShadowed ? { shadowed: true } : {}),
          start: property.start, end: property.end,
          message: 'Duplicate object key; structured inspection shows the last occurrence. Source retains every occurrence.',
        })
        seen.add(property.key)
        pending.push(child)
      }
    } else if (node.kind === 'array') {
      node.items!.forEach((item, index) => pending.push({ node: item, parent: frame, segment: index, shadowed }))
    } else {
      const first = source.charCodeAt(node.start)
      if (first !== MINUS && !isDigit(first)) continue
      const token = source.slice(node.start, node.end)
      if (isPlainSafeInteger(token)) continue
      const number = Number(token)
      if (!Number.isFinite(number) || Object.is(number, -0)
        || (Number.isInteger(number) && !Number.isSafeInteger(number))
        || decimalKey(token) !== decimalKey(String(number))) {
        diagnostics.push({
          code: 'unsafe-number', sourcePath: inspectionPath(frame), token, start: node.start, end: node.end,
          ...(shadowed ? { shadowed: true } : {}),
          message: 'This numeric token cannot be safely edited through JavaScript numbers. Edit its exact value in Source.',
        })
      }
    }
  }
  diagnostics.sort((a, b) => a.start - b.start)
  return diagnostics
}

let lastInspection: { source: string; diagnostics: JsonSourceDiagnostic[] } | undefined

/** Reads a source-preserving inspection value and identifies information JSON.parse cannot retain. */
export function inspectJsonSource(source: string): { value: unknown; diagnostics: JsonSourceDiagnostic[] } {
  const value: unknown = JSON.parse(source)
  // Hosts inspect one text several times per change. The scan is the expensive
  // part, so its result is kept for the most recent source; callers still get
  // their own value, diagnostic objects, and paths.
  const cached = lastInspection !== undefined && lastInspection.source === source ? lastInspection.diagnostics : undefined
  const diagnostics = cached ?? inspectSourceDiagnostics(source)
  if (!cached) lastInspection = { source, diagnostics }
  return { value, diagnostics: diagnostics.map((item) => ({ ...item, sourcePath: [...item.sourcePath], help: sourceDiagnosticHelp(item.code) })) }
}

/** Replaces one existing JSON value while preserving every unrelated source byte. */
export function replaceJsonValueInSource(
  source: string,
  path: ValuePath,
  next: unknown,
): string {
  const parsed: unknown = JSON.parse(source)
  requireValueAtPath(parsed, path)
  const serialized = serializeReplacement(next, path)

  const target = sourceNodeAtPath(new JsonSourceScanner(source).parse(), path)
  return `${source.slice(0, target.start)}${serialized}${source.slice(target.end)}`
}

/** Adds or replaces one property while preserving the surrounding JSON source. */
export function upsertJsonObjectPropertyInSource(
  source: string,
  objectPath: ValuePath,
  key: string,
  next: unknown,
): string {
  const parsed: unknown = JSON.parse(source)
  const object = requireValueAtPath(parsed, objectPath)
  if (object === null || typeof object !== 'object' || Array.isArray(object)) {
    throw new TypeError(`JSON path ${describeValuePath(objectPath)} does not point to an object`)
  }
  const replacement = serializeReplacement(next, [...objectPath, key])
  const tree = new JsonSourceScanner(source).parse()
  if (Object.prototype.hasOwnProperty.call(object, key)) {
    const target = sourceNodeAtPath(tree, [...objectPath, key])
    return `${source.slice(0, target.start)}${replacement}${source.slice(target.end)}`
  }

  const target = sourceNodeAtPath(tree, objectPath)
  if (target.kind !== 'object') {
    throw new TypeError(`JSON path ${describeValuePath(objectPath)} does not point to an object`)
  }
  const properties = target.properties ?? []
  const serialized = `${JSON.stringify(key)}:${replacement}`
  if (properties.length === 0) {
    return `${source.slice(0, target.start + 1)}${serialized}${source.slice(target.end - 1)}`
  }

  const first = properties[0]
  const leadingWhitespace = source.slice(target.start + 1, first.start)
  const lineBreak = leadingWhitespace.lastIndexOf('\n')
  const separator = lineBreak >= 0
    ? `,\n${leadingWhitespace.slice(lineBreak + 1)}`
    : ', '
  const insertionPoint = properties[properties.length - 1].end
  return `${source.slice(0, insertionPoint)}${separator}${serialized}${source.slice(insertionPoint)}`
}

/** Appends one item while preserving every byte outside the target array. */
export function appendJsonArrayItemInSource(
  source: string,
  arrayPath: ValuePath,
  next: unknown,
): string {
  const parsed: unknown = JSON.parse(source)
  const array = requireValueAtPath(parsed, arrayPath)
  if (!Array.isArray(array)) {
    throw new TypeError(`JSON path ${describeValuePath(arrayPath)} does not point to an array`)
  }

  const target = sourceNodeAtPath(new JsonSourceScanner(source).parse(), arrayPath)
  if (target.kind !== 'array') {
    throw new TypeError(`JSON path ${describeValuePath(arrayPath)} does not point to an array`)
  }
  const items = target.items ?? []
  if (items.length === 0) {
    const innerWhitespace = source.slice(target.start + 1, target.end - 1)
    if (!innerWhitespace.includes('\n')) {
      const serialized = serializeReplacement(next, [...arrayPath, array.length])
      return `${source.slice(0, target.start + 1)}${serialized}${source.slice(target.end - 1)}`
    }
    const closingIndent = innerWhitespace.slice(innerWhitespace.lastIndexOf('\n') + 1)
    const itemIndent = `${closingIndent}  `
    const serialized = serializeReplacement(next, [...arrayPath, array.length], 2).replace(/\n/g, `\n${itemIndent}`)
    return `${source.slice(0, target.start + 1)}\n${itemIndent}${serialized}\n${closingIndent}${source.slice(target.end - 1)}`
  }

  const first = items[0]
  const leadingWhitespace = source.slice(target.start + 1, first.start)
  const lineBreak = leadingWhitespace.lastIndexOf('\n')
  const itemIndent = lineBreak >= 0 ? leadingWhitespace.slice(lineBreak + 1) : ''
  const separator = lineBreak >= 0 ? `,\n${itemIndent}` : ', '
  const serialized = lineBreak >= 0
    ? serializeReplacement(next, [...arrayPath, array.length], 2).replace(/\n/g, `\n${itemIndent}`)
    : serializeReplacement(next, [...arrayPath, array.length])
  const insertionPoint = items[items.length - 1].end
  return `${source.slice(0, insertionPoint)}${separator}${serialized}${source.slice(insertionPoint)}`
}

export interface JsonValueReplacement {
  path: ValuePath
  value: unknown
}

export interface JsonPropertyUpsert {
  objectPath: ValuePath
  key: string
  value: unknown
}

/** Adds/replaces properties against one source scan, preserving unrelated tokens. */
export function upsertJsonObjectPropertiesInSource(source: string, changes: readonly JsonPropertyUpsert[]): string {
  if (changes.length === 0) return source
  const parsed: unknown = JSON.parse(source)
  const tree = new JsonSourceScanner(source).parse()
  const groups = new Map<JsonSourceNode, Map<string, string>>()
  for (const change of changes) {
    const object = requireValueAtPath(parsed, change.objectPath)
    if (object === null || typeof object !== 'object' || Array.isArray(object)) throw new TypeError('Property writes require an object')
    const parent = sourceNodeAtPath(tree, change.objectPath)
    const properties = groups.get(parent) ?? new Map<string, string>()
    if (properties.has(change.key)) throw new TypeError('JSON property writes overlap')
    properties.set(change.key, serializeReplacement(change.value, [...change.objectPath, change.key]))
    groups.set(parent, properties)
  }
  const edits: Array<{ start: number; end: number; text: string }> = []
  for (const [parent, changes] of groups) {
    const added: string[] = []
    for (const [key, text] of changes) {
      const existing = parent.propertyIndex!.get(key)
      if (existing) edits.push({ start: existing.start, end: existing.end, text })
      else added.push(`${JSON.stringify(key)}:${text}`)
    }
    if (added.length === 0) continue
    const properties = parent.properties!
    const first = properties[0]
    const whitespace = first ? source.slice(parent.start + 1, first.start) : ''
    const lineBreak = whitespace.lastIndexOf('\n')
    const separator = lineBreak >= 0 ? `,\n${whitespace.slice(lineBreak + 1)}` : ', '
    const start = properties.at(-1)?.end ?? parent.start + 1
    edits.push({ start, end: start, text: (first ? separator : '') + added.join(separator) })
  }
  edits.sort((a, b) => a.start - b.start || b.end - a.end)
  let cursor = 0
  const parts: string[] = []
  for (const edit of edits) {
    if (edit.start < cursor) throw new TypeError('JSON property writes overlap')
    parts.push(source.slice(cursor, edit.start), edit.text)
    cursor = edit.end
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

/** Replaces independent existing values as one source-preserving document update. */
export function replaceJsonValuesInSource(
  source: string,
  replacements: readonly JsonValueReplacement[],
): string {
  if (replacements.length === 0) return source
  const parsed: unknown = JSON.parse(source)
  const tree = new JsonSourceScanner(source).parse()
  const edits = replacements.map((replacement) => {
    requireValueAtPath(parsed, replacement.path)
    const target = sourceNodeAtPath(tree, replacement.path)
    return { ...target, path: replacement.path, serialized: serializeReplacement(replacement.value, replacement.path) }
  }).sort((left, right) => left.start - right.start || right.end - left.end)
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].start < edits[index - 1].end) {
      throw new TypeError(`JSON path ${describeValuePath(edits[index].path)} overlaps ${describeValuePath(edits[index - 1].path)}`)
    }
  }
  const parts: string[] = []
  let cursor = 0
  for (const edit of edits) {
    parts.push(source.slice(cursor, edit.start), edit.serialized)
    cursor = edit.end
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

/** Parses, validates, and replaces only the selected atomic token in the source. */
export function replaceJsonAtomicValueInSource(
  source: string,
  path: ValuePath,
  next: AtomicValue,
): string {
  const root: unknown = JSON.parse(source)
  assertSameEditableAtomicType(requireValueAtPath(root, path), next, path)

  const target = sourceNodeAtPath(new JsonSourceScanner(source).parse(), path)
  if (target.kind !== 'atomic') {
    throw new TypeError(`JSON path ${describeValuePath(path)} does not point to an atomic value`)
  }
  return `${source.slice(0, target.start)}${serializeReplacement(next, path)}${source.slice(target.end)}`
}

function removalRange(nodes: Array<{ start: number; end: number }>, index: number): { start: number; end: number } {
  const target = nodes[index]
  if (!target) throw new RangeError(`JSON child ${index} does not exist`)
  const next = nodes[index + 1]
  if (next) return { start: target.start, end: next.start }
  const previous = nodes[index - 1]
  if (previous) return { start: previous.end, end: target.end }
  return { start: target.start, end: target.end }
}

/** Removes one array item or object property while preserving unrelated JSON source bytes. */
export function removeJsonValueInSource(source: string, path: ValuePath): string {
  if (path.length === 0) throw new TypeError('The JSON document root cannot be removed')
  const parsed: unknown = JSON.parse(source)
  requireValueAtPath(parsed, path)

  const parentPath = path.slice(0, -1)
  const segment = path[path.length - 1]
  const parent = sourceNodeAtPath(new JsonSourceScanner(source).parse(), parentPath)
  let range: { start: number; end: number }
  if (parent.kind === 'array' && typeof segment === 'number') {
    range = removalRange(parent.items ?? [], segment)
  } else if (parent.kind === 'object' && typeof segment === 'string') {
    const properties = parent.properties ?? []
    let propertyIndex = -1
    for (let index = 0; index < properties.length; index++) {
      if (properties[index].key === segment) propertyIndex = index
    }
    if (propertyIndex < 0) throw new RangeError(`JSON path ${describeValuePath(path)} does not exist`)
    range = removalRange(properties, propertyIndex)
  } else {
    throw new TypeError(`JSON path ${describeValuePath(parentPath)} is not the requested container type`)
  }

  return source.slice(0, range.start) + source.slice(range.end)
}

/** Removes locations in the original source, independent of caller order.
 * Duplicate locations are idempotent; ancestor/descendant plans are rejected.
 * Adjacent siblings share a removal span so commas remain valid.
 */
export function removeJsonValuesInSource(source: string, paths: readonly ValuePath[]): string {
  if (paths.length === 0) return source
  const parsed: unknown = JSON.parse(source)
  const tree = new JsonSourceScanner(source).parse()
  const groups = new Map<JsonSourceNode, Set<number>>()
  const targets: JsonSourceNode[] = []
  for (const path of paths) {
    if (path.length === 0) throw new TypeError('The JSON document root cannot be removed')
    requireValueAtPath(parsed, path)
    const parent = sourceNodeAtPath(tree, path.slice(0, -1))
    const target = sourceNodeAtPath(tree, path)
    const index = parent.kind === 'array'
      ? parent.items!.indexOf(target)
      : parent.properties!.findIndex((property) => property.value === target)
    const indices = groups.get(parent) ?? new Set<number>()
    if (!indices.has(index)) targets.push(target)
    indices.add(index)
    groups.set(parent, indices)
  }
  targets.sort((a, b) => a.start - b.start)
  for (let index = 1; index < targets.length; index++) {
    if (targets[index].start < targets[index - 1].end) throw new TypeError('JSON removals overlap')
  }
  const ranges: Array<{ start: number; end: number }> = []
  for (const [parent, selected] of groups) {
    const siblings = parent.kind === 'array' ? parent.items! : parent.properties!
    const indices = [...selected].sort((a, b) => a - b)
    for (let cursor = 0; cursor < indices.length; cursor++) {
      const first = indices[cursor]
      let last = first
      while (indices[cursor + 1] === last + 1) last = indices[++cursor]
      const next = siblings[last + 1]
      ranges.push(next
        ? { start: siblings[first].start, end: next.start }
        : { start: siblings[first - 1]?.end ?? siblings[first].start, end: siblings[last].end })
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let cursor = 0
  for (const range of ranges) {
    parts.push(source.slice(cursor, range.start))
    cursor = range.end
  }
  parts.push(source.slice(cursor))
  return parts.join('')
}

export type JsonPatchOperation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; path: string; from: string }
  | { op: 'copy'; path: string; from: string }
  | { op: 'test'; path: string; value: unknown }

export type JsonPatchErrorCode =
  | 'invalid-document'
  | 'invalid-patch'
  | 'invalid-operation'
  | 'invalid-pointer'
  | 'missing-path'
  | 'invalid-array-index'
  | 'invalid-value'
  | 'test-failed'
  | 'move-into-descendant'
  | 'root-removal-not-supported'

export class JsonPatchError extends Error {
  readonly code: JsonPatchErrorCode
  readonly path?: string
  readonly from?: string
  operationIndex?: number

  constructor(
    code: JsonPatchErrorCode,
    message: string,
    details: { path?: string; from?: string; operationIndex?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'JsonPatchError'
    this.code = code
    this.path = details.path
    this.from = details.from
    this.operationIndex = details.operationIndex
  }
}

function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) {
    throw new JsonPatchError('invalid-pointer', `JSON Pointer ${JSON.stringify(pointer)} must be empty or start with /`, { path: pointer })
  }
  return pointer.slice(1).split('/').map((token) => {
    if (/~(?:[^01]|$)/.test(token)) {
      throw new JsonPatchError('invalid-pointer', `JSON Pointer ${JSON.stringify(pointer)} contains an invalid ~ escape`, { path: pointer })
    }
    return token.replace(/~1/g, '/').replace(/~0/g, '~')
  })
}

function arrayIndex(token: string, length: number, pointer: string, allowEnd: boolean): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) {
    throw new JsonPatchError('invalid-array-index', `Array token ${JSON.stringify(token)} in ${JSON.stringify(pointer)} must be a non-negative integer without leading zeros`, { path: pointer })
  }
  const index = Number(token)
  if (!Number.isSafeInteger(index) || index > length || (!allowEnd && index === length)) {
    throw new JsonPatchError('missing-path', `JSON Pointer ${JSON.stringify(pointer)} does not exist`, { path: pointer })
  }
  return index
}

function resolvePointer(root: unknown, tokens: readonly string[], pointer: string): { path: ValuePath; value: unknown } {
  const path: Array<string | number> = []
  let current = root
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (token === '-') throw new JsonPatchError('missing-path', `JSON Pointer ${JSON.stringify(pointer)} does not exist`, { path: pointer })
      const index = arrayIndex(token, current.length, pointer, false)
      path.push(index)
      current = current[index]
    } else if (current !== null && typeof current === 'object') {
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        throw new JsonPatchError('missing-path', `JSON Pointer ${JSON.stringify(pointer)} does not exist`, { path: pointer })
      }
      path.push(token)
      current = (current as Record<string, unknown>)[token]
    } else {
      throw new JsonPatchError('missing-path', `JSON Pointer ${JSON.stringify(pointer)} does not exist`, { path: pointer })
    }
  }
  return { path, value: current }
}

function resolveAddPointer(root: unknown, tokens: readonly string[], pointer: string): { path: ValuePath; parent: unknown } {
  if (tokens.length === 0) return { path: [], parent: undefined }
  const parentResult = resolvePointer(root, tokens.slice(0, -1), pointer)
  const token = tokens[tokens.length - 1]
  if (Array.isArray(parentResult.value)) {
    const index = token === '-' ? parentResult.value.length : arrayIndex(token, parentResult.value.length, pointer, true)
    return { path: [...parentResult.path, index], parent: parentResult.value }
  }
  if (parentResult.value !== null && typeof parentResult.value === 'object') {
    return { path: [...parentResult.path, token], parent: parentResult.value }
  }
  throw new JsonPatchError('missing-path', `Parent of JSON Pointer ${JSON.stringify(pointer)} does not exist`, { path: pointer })
}

function replaceJsonFragmentInSource(source: string, path: ValuePath, fragment: string): string {
  const target = sourceNodeAtPath(new JsonSourceScanner(source).parse(), path)
  return source.slice(0, target.start) + fragment + source.slice(target.end)
}

function addJsonFragmentInSource(source: string, pointer: string, fragment: string): string {
  const root: unknown = JSON.parse(source)
  const tokens = parseJsonPointer(pointer)
  const target = resolveAddPointer(root, tokens, pointer)
  if (target.path.length === 0) return replaceJsonFragmentInSource(source, [], fragment)

  const parentPath = target.path.slice(0, -1)
  const segment = target.path[target.path.length - 1]
  const parentNode = sourceNodeAtPath(new JsonSourceScanner(source).parse(), parentPath)
  if (parentNode.kind === 'object' && typeof segment === 'string') {
    if (Object.prototype.hasOwnProperty.call(target.parent, segment)) {
      return replaceJsonFragmentInSource(source, target.path, fragment)
    }
    const properties = parentNode.properties ?? []
    const first = properties[0]
    const whitespace = first ? source.slice(parentNode.start + 1, first.start) : source.slice(parentNode.start + 1, parentNode.end - 1)
    const lineBreak = whitespace.lastIndexOf('\n')
    const separator = lineBreak >= 0 ? `,\n${whitespace.slice(lineBreak + 1)}` : ', '
    const colon = first && source.slice(first.start, first.value.start).includes(': ') ? ': ' : ':'
    const property = `${JSON.stringify(segment)}${colon}${fragment}`
    if (!first) {
      return source.slice(0, parentNode.start + 1) + property + source.slice(parentNode.end - 1)
    }
    const insertionPoint = properties[properties.length - 1].end
    return source.slice(0, insertionPoint) + separator + property + source.slice(insertionPoint)
  }
  if (parentNode.kind === 'array' && typeof segment === 'number') {
    const items = parentNode.items ?? []
    if (items.length === 0) {
      const innerWhitespace = source.slice(parentNode.start + 1, parentNode.end - 1)
      if (!innerWhitespace.includes('\n')) {
        return source.slice(0, parentNode.start + 1) + fragment + source.slice(parentNode.end - 1)
      }
      const closingIndent = innerWhitespace.slice(innerWhitespace.lastIndexOf('\n') + 1)
      const itemIndent = `${closingIndent}  `
      return `${source.slice(0, parentNode.start + 1)}\n${itemIndent}${fragment}\n${closingIndent}${source.slice(parentNode.end - 1)}`
    }
    const leadingWhitespace = source.slice(parentNode.start + 1, items[0].start)
    const lineBreak = leadingWhitespace.lastIndexOf('\n')
    const separator = lineBreak >= 0 ? `,\n${leadingWhitespace.slice(lineBreak + 1)}` : ', '
    if (segment === items.length) {
      const insertionPoint = items[items.length - 1].end
      return source.slice(0, insertionPoint) + separator + fragment + source.slice(insertionPoint)
    }
    return source.slice(0, items[segment].start) + fragment + separator + source.slice(items[segment].start)
  }
  throw new JsonPatchError('missing-path', `Parent of JSON Pointer ${JSON.stringify(pointer)} does not exist`, { path: pointer })
}

function sourceFragmentAtPointer(source: string, pointer: string): { fragment: string; path: ValuePath; value: unknown } {
  const root: unknown = JSON.parse(source)
  const resolved = resolvePointer(root, parseJsonPointer(pointer), pointer)
  const node = sourceNodeAtPath(new JsonSourceScanner(source).parse(), resolved.path)
  return { ...resolved, fragment: source.slice(node.start, node.end) }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]))
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
    && jsonValuesEqual(leftRecord[key], rightRecord[key]))
}

function requirePatchOperation(operation: unknown, index: number): JsonPatchOperation {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new JsonPatchError('invalid-operation', `Patch operation ${index} must be an object`, { operationIndex: index })
  }
  const item = operation as Record<string, unknown>
  if (typeof item.op !== 'string' || !['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(item.op)) {
    throw new JsonPatchError('invalid-operation', `Patch operation ${index} has an unsupported op`, { operationIndex: index })
  }
  if (typeof item.path !== 'string') {
    throw new JsonPatchError('invalid-operation', `Patch operation ${index} requires a string path`, { operationIndex: index })
  }
  if ((item.op === 'add' || item.op === 'replace' || item.op === 'test') && !Object.prototype.hasOwnProperty.call(item, 'value')) {
    throw new JsonPatchError('invalid-operation', `Patch operation ${index} with op ${item.op} requires value`, { operationIndex: index, path: item.path })
  }
  if ((item.op === 'move' || item.op === 'copy') && typeof item.from !== 'string') {
    throw new JsonPatchError('invalid-operation', `Patch operation ${index} with op ${item.op} requires a string from`, { operationIndex: index, path: item.path })
  }
  return item as unknown as JsonPatchOperation
}

/** Applies an RFC 6902 JSON Patch atomically while preserving every unrelated source byte. */
export function applyJsonPatchInSource(source: string, patch: readonly unknown[]): string {
  if (!Array.isArray(patch)) throw new JsonPatchError('invalid-patch', 'JSON Patch must be an array')
  try { JSON.parse(source) } catch (cause) {
    throw new JsonPatchError('invalid-document', 'The current document is not valid JSON', { cause })
  }

  let next = source
  for (let index = 0; index < patch.length; index += 1) {
    const operation = requirePatchOperation(patch[index], index)
    try {
      const pathTokens = parseJsonPointer(operation.path)
      if (operation.op === 'add') {
        next = addJsonFragmentInSource(next, operation.path, serializeReplacement(operation.value, []))
      } else if (operation.op === 'remove') {
        if (pathTokens.length === 0) throw new JsonPatchError('root-removal-not-supported', 'A JSON document root cannot be removed', { path: operation.path })
        const root: unknown = JSON.parse(next)
        const target = resolvePointer(root, pathTokens, operation.path)
        next = removeJsonValueInSource(next, target.path)
      } else if (operation.op === 'replace') {
        const root: unknown = JSON.parse(next)
        const target = resolvePointer(root, pathTokens, operation.path)
        next = replaceJsonFragmentInSource(next, target.path, serializeReplacement(operation.value, target.path))
      } else if (operation.op === 'test') {
        serializeReplacement(operation.value, [])
        const root: unknown = JSON.parse(next)
        const target = resolvePointer(root, pathTokens, operation.path)
        if (!jsonValuesEqual(target.value, operation.value)) {
          throw new JsonPatchError('test-failed', `Test operation failed at JSON Pointer ${JSON.stringify(operation.path)}`, { path: operation.path })
        }
      } else {
        const fromTokens = parseJsonPointer(operation.from)
        if (operation.op === 'move' && fromTokens.length < pathTokens.length
          && fromTokens.every((token, tokenIndex) => token === pathTokens[tokenIndex])) {
          throw new JsonPatchError('move-into-descendant', 'A value cannot be moved into one of its descendants', { path: operation.path, from: operation.from })
        }
        const sourceValue = sourceFragmentAtPointer(next, operation.from)
        if (operation.op === 'move') {
          if (operation.from === operation.path) continue
          if (sourceValue.path.length === 0) throw new JsonPatchError('root-removal-not-supported', 'A JSON document root cannot be moved below itself', { path: operation.path, from: operation.from })
          next = removeJsonValueInSource(next, sourceValue.path)
        }
        next = addJsonFragmentInSource(next, operation.path, sourceValue.fragment)
      }
    } catch (error) {
      if (error instanceof JsonPatchError) {
        error.operationIndex ??= index
        throw error
      }
      throw new JsonPatchError('invalid-value', error instanceof Error ? error.message : 'The patch value is not valid JSON', {
        operationIndex: index, path: operation.path, cause: error,
      })
    }
  }
  return next
}
