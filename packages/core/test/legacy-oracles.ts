// Verbatim copies of implementations replaced by performance work. The
// differential tests run them beside the current code on generated input so
// the faster versions stay behaviorally identical.
import { MAX_JSON_DEPTH, JsonDepthLimitError } from '../src/json-limits'
import { assertJsonDepth } from '../src/json-limits'
import { describeValuePath, type ValuePath } from '../src/json-path'
import { sourceDiagnosticHelp } from '../src/diagnostics'
import {
  JSON_VIEW_PATH_MISSING,
  compileJsonViewMetadata,
  type CompiledJsonViewSchema,
  type JsonSourceDiagnostic,
  type JsonViewPath,
  type ResolvedJsonViewPath,
} from '../src'
import { isJsonViewTableCandidate } from '../src/table-suitability'

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

class LegacyJsonSourceScanner {
  private index = 0
  private readonly source: string

  constructor(source: string) {
    this.source = source
  }

  parse(): JsonSourceNode {
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
      const close = node.kind === 'array' ? ']' : '}'
      if (this.source[this.index] === close) {
        node.end = ++this.index
        if (frame.property) frame.property.end = node.end
        frames.pop()
        continue
      }
      if (frame.afterValue) {
        if (this.source[this.index++] !== ',') throw new SyntaxError('Expected comma')
        this.skipWhitespace()
      }
      frame.afterValue = true
      if (node.kind === 'array') {
        const value = this.parseValue()
        node.items!.push(value)
        push(value)
      } else {
        const start = this.index
        this.scanString()
        const key = JSON.parse(this.source.slice(start, this.index)) as string
        this.skipWhitespace()
        if (this.source[this.index++] !== ':') throw new SyntaxError('Expected colon')
        const value = this.parseValue()
        const property = { key, start, end: value.end, value }
        node.properties!.push(property)
        node.propertyIndex!.set(key, value)
        push(value, property)
      }
    }
    this.skipWhitespace()
    if (this.index !== this.source.length) throw new SyntaxError('Unexpected content after JSON value')
    return root
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /[\t\n\r ]/.test(this.source[this.index])) this.index++
  }

  private parseValue(): JsonSourceNode {
    this.skipWhitespace()
    const start = this.index
    const token = this.source[this.index]
    if (token === '{') { this.index++; return { start, end: this.index, kind: 'object', properties: [], propertyIndex: new Map() } }
    if (token === '[') { this.index++; return { start, end: this.index, kind: 'array', items: [] } }
    if (token === '"') {
      this.scanString()
      return { start, end: this.index, kind: 'atomic' }
    }
    if (token === 't') return this.scanLiteral(start, 'true')
    if (token === 'f') return this.scanLiteral(start, 'false')
    if (token === 'n') return this.scanLiteral(start, 'null')
    return this.scanNumber(start)
  }

  private scanString(): void {
    if (this.source[this.index] !== '"') throw new SyntaxError('Expected JSON string')
    this.index++
    while (this.index < this.source.length) {
      const token = this.source[this.index]
      this.index++
      if (token === '"') return
      if (token === '\\') this.index++
    }
    throw new SyntaxError('Unterminated JSON string')
  }

  private scanLiteral(start: number, literal: 'true' | 'false' | 'null'): JsonSourceNode {
    this.index += literal.length
    return { start, end: this.index, kind: 'atomic' }
  }

  private scanNumber(start: number): JsonSourceNode {
    while (this.index < this.source.length && /[0-9eE+.-]/.test(this.source[this.index])) this.index++
    if (this.index === start) throw new SyntaxError('Expected JSON value')
    return { start, end: this.index, kind: 'atomic' }
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

export function legacyJsonSourceRangesAtPaths(source: string, paths: readonly ValuePath[]): Array<{ start: number; end: number }> {
  JSON.parse(source)
  const root = new LegacyJsonSourceScanner(source).parse()
  return paths.map((path) => {
    const target = sourceNodeAtPath(root, path)
    return { start: target.start, end: target.end }
  })
}

export function legacyInspectJsonSource(source: string): { value: unknown; diagnostics: JsonSourceDiagnostic[] } {
  const value: unknown = JSON.parse(source)
  const tree = new LegacyJsonSourceScanner(source).parse()
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
  const pending: Array<{ node: JsonSourceNode; path: ValuePath; shadowed: boolean }> = [{ node: tree, path: [], shadowed: false }]
  while (pending.length) {
    const { node, path, shadowed } = pending.pop()!
    if (node.kind === 'object') {
      const seen = new Set<string>()
      for (const property of node.properties ?? []) {
        const childPath = [...path, property.key]
        const childShadowed = shadowed || node.propertyIndex?.get(property.key) !== property.value
        if (seen.has(property.key)) diagnostics.push({
          code: 'duplicate-key', sourcePath: childPath, token: JSON.stringify(property.key),
          ...(childShadowed ? { shadowed: true } : {}),
          start: property.start, end: property.end,
          message: 'Duplicate object key; structured inspection shows the last occurrence. Source retains every occurrence.',
        })
        seen.add(property.key)
        pending.push({ node: property.value, path: childPath, shadowed: childShadowed })
      }
    } else if (node.kind === 'array') {
      node.items?.forEach((child, index) => pending.push({ node: child, path: [...path, index], shadowed }))
    } else {
      const token = source.slice(node.start, node.end)
      if (!/^-?[0-9]/.test(token)) continue
      const number = Number(token)
      if (!Number.isFinite(number) || Object.is(number, -0)
        || (Number.isInteger(number) && !Number.isSafeInteger(number))
        || decimalKey(token) !== decimalKey(String(number))) {
        diagnostics.push({
          code: 'unsafe-number', sourcePath: path, token, start: node.start, end: node.end,
          ...(shadowed ? { shadowed: true } : {}),
          message: 'This numeric token cannot be safely edited through JavaScript numbers. Edit its exact value in Source.',
        })
      }
    }
  }
  diagnostics.sort((a, b) => a.start - b.start)
  return { value, diagnostics: diagnostics.map((item) => ({ ...item, help: sourceDiagnosticHelp(item.code) })) }
}

export function legacyFormatJsonSource(source: string): string {
  assertJsonDepth(JSON.parse(source))
  let formatted = ''
  let depth = 0
  let escaped = false
  let inString = false
  const expandedContainers: boolean[] = []
  const indentation = () => '  '.repeat(depth)

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      formatted += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (/\s/.test(character)) continue
    if (character === '"') {
      inString = true
      formatted += character
      continue
    }
    if (character === '{' || character === '[') {
      const closingCharacter = character === '{' ? '}' : ']'
      let nextIndex = index + 1
      while (nextIndex < source.length && /\s/.test(source[nextIndex])) nextIndex += 1
      const expanded = source[nextIndex] !== closingCharacter
      expandedContainers.push(expanded)
      formatted += character
      if (expanded) {
        depth += 1
        formatted += `\n${indentation()}`
      }
      continue
    }
    if (character === '}' || character === ']') {
      const expanded = expandedContainers.pop() ?? false
      if (expanded) {
        depth -= 1
        formatted += `\n${indentation()}`
      }
      formatted += character
      continue
    }
    if (character === ',') {
      formatted += `,\n${indentation()}`
      continue
    }
    formatted += character === ':' ? ': ' : character
  }
  return formatted
}

export function legacyPrefersSource(content: string, metadata?: unknown): boolean {
  try {
    const root: unknown = JSON.parse(content)
    const compiled = compileJsonViewMetadata(root, undefined, metadata === undefined ? {} : { metadata })
    if (compiled.metadataSource !== 'inferred' || compiled.views.length || isJsonViewTableCandidate(root)) return false
    const formatted = JSON.stringify(root, null, 2)
    const lines = formatted.split('\n').length
    if (formatted.length > 8000 || lines > 100) return false
    const entries = root !== null && typeof root === 'object' ? Object.values(root) : []
    if (!Array.isArray(root) && entries.length >= 2
      && entries.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) return false
    if (entries.length <= 5 && formatted.length <= 3000 && lines <= 40
      && entries.some((value) => value !== null && typeof value === 'object' && Object.keys(value).length > 0
        && (!Array.isArray(value) || value.some((item) => item !== null && typeof item === 'object')))) return true
    let leaves = 0
    let hidden = 0
    const visit = (value: unknown, depth: number): void => {
      if (value !== null && typeof value === 'object') Object.values(value).forEach((child) => visit(child, depth + 1))
      else { leaves++; if (depth >= 3) hidden++ }
    }
    visit(root, 0)
    return leaves > 0 && hidden / leaves >= 0.6
  } catch { return false }
}

export function legacyMatchesJsonViewPath(path: JsonViewPath, sourcePath: ValuePath): boolean {
  if (path.root !== '$' || path.segments.length !== sourcePath.length) return false
  return path.segments.every((segment, index) => {
    const sourceSegment = sourcePath[index]
    if (segment.kind === 'wildcard') return true
    if (segment.kind === 'property') return segment.key === sourceSegment
    return segment.index === sourceSegment
  })
}

export function legacySchemaForJsonViewPath(
  schema: readonly CompiledJsonViewSchema[],
  sourcePath: ValuePath,
): CompiledJsonViewSchema | undefined {
  return schema
    .filter((entry) => legacyMatchesJsonViewPath(entry.path, sourcePath))
    .sort((left, right) => (
      right.specificity[0] - left.specificity[0]
      || right.specificity[1] - left.specificity[1]
      || left.declarationIndex - right.declarationIndex
    ))[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function legacyExpandSchemaLocations(root: unknown, entry: CompiledJsonViewSchema): ResolvedJsonViewPath[] {
  const results: ResolvedJsonViewPath[] = []
  const visit = (value: unknown, segmentIndex: number, sourcePath: ValuePath): void => {
    if (segmentIndex === entry.path.segments.length) {
      results.push({ value, sourcePath })
      return
    }
    const segment = entry.path.segments[segmentIndex]
    const missing = (): void => {
      const remainder = entry.path.segments.slice(segmentIndex)
      const concrete: Array<string | number> = [...sourcePath]
      for (const part of remainder) {
        if (part.kind === 'wildcard') break
        concrete.push(part.kind === 'property' ? part.key : part.index)
      }
      results.push({ value: JSON_VIEW_PATH_MISSING, sourcePath: concrete })
    }
    if (segment.kind === 'property') {
      if (!isRecord(value)) { missing(); return }
      if (own(value, segment.key)) visit(value[segment.key], segmentIndex + 1, [...sourcePath, segment.key])
      else missing()
      return
    }
    if (segment.kind === 'index') {
      if (!Array.isArray(value)) { missing(); return }
      if (own(value as unknown as Record<string, unknown>, String(segment.index))) visit(value[segment.index], segmentIndex + 1, [...sourcePath, segment.index])
      else missing()
      return
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, segmentIndex + 1, [...sourcePath, index]))
      return
    }
    if (isRecord(value)) {
      Object.entries(value).forEach(([key, child]) => visit(child, segmentIndex + 1, [...sourcePath, key]))
    } else missing()
  }
  visit(root, 0, [])
  return results
}

/** The (entry, location) sequence the previous validator visited, in order. */
export function legacyValidationSequence(root: unknown, schema: readonly CompiledJsonViewSchema[]): Array<{ declaration: string; sourcePath: ValuePath; missing: boolean }> {
  const sequence: Array<{ declaration: string; sourcePath: ValuePath; missing: boolean }> = []
  const visited = new Set<string>()
  for (const entry of schema) {
    for (const location of legacyExpandSchemaLocations(root, entry)) {
      const winner = legacySchemaForJsonViewPath(schema, location.sourcePath)
      if (winner && winner !== entry) continue
      const visitKey = JSON.stringify(location.sourcePath)
      if (visited.has(visitKey)) continue
      visited.add(visitKey)
      sequence.push({ declaration: entry.declaration, sourcePath: location.sourcePath, missing: location.value === JSON_VIEW_PATH_MISSING })
    }
  }
  return sequence
}
