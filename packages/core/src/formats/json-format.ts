import { assertJsonDepth } from '../json-limits.js'
import {
  appendJsonArrayItemInSource,
  inspectJsonSource,
  removeJsonValuesInSource,
  replaceJsonValueInSource,
  replaceJsonValuesInSource,
  stringifyJsonValue,
} from '../json-source-patcher.js'
import type { ValuePath } from '../json-path.js'
import type {
  DocumentDiagnostic,
  FormatCapability,
  StructuredDocumentAdapter,
  StructuredDocumentFormat,
  ValueReplacement,
} from './document-format.js'

export interface JsonDocumentState {
  root: unknown
}

function jsonCapability(value: unknown): FormatCapability {
  try {
    stringifyJsonValue(value)
    return { representable: true }
  } catch {
    return { representable: false, reason: 'The value is not losslessly representable as JSON data' }
  }
}

function adapter(format: Extract<StructuredDocumentFormat, 'json-object' | 'json-array'>): StructuredDocumentAdapter<JsonDocumentState> {
  return {
    format,
    inspect(source) {
      const inspected = inspectJsonSource(source)
      const actual = Array.isArray(inspected.value) ? 'json-array' : 'json-object'
      if (actual !== format) throw new TypeError(`Expected ${format === 'json-array' ? 'an array' : 'a non-array'} JSON root`)
      const diagnostics: DocumentDiagnostic[] = inspected.diagnostics.map((item) => ({
        code: item.code,
        message: item.message,
        severity: 'warning',
        path: item.sourcePath,
        start: item.start,
        end: item.end,
        help: item.help,
      }))
      return { root: inspected.value, state: { root: inspected.value }, diagnostics }
    },
    validate(source) { JSON.parse(source) },
    replace(source, _state, path, value) { return replaceJsonValueInSource(source, path, value) },
    replaceMany(source, _state, changes) {
      return replaceJsonValuesInSource(source, changes)
    },
    removeMany(source, _state, paths) {
      return removeJsonValuesInSource(source, paths)
    },
    append(source, _state, path, value) { return appendJsonArrayItemInSource(source, path, value) },
    canRepresent: jsonCapability,
  }
}

export const jsonObjectFormat = adapter('json-object')
export const jsonArrayFormat = adapter('json-array')

export function jsonFormatForSource(source: string): StructuredDocumentAdapter<JsonDocumentState> {
  return Array.isArray(JSON.parse(source)) ? jsonArrayFormat : jsonObjectFormat
}

export function jsonFormatForRoot(root: unknown): StructuredDocumentAdapter<JsonDocumentState> {
  return Array.isArray(root) ? jsonArrayFormat : jsonObjectFormat
}

// Outside strings, valid JSON only contains these four whitespace characters.
function isJsonWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09
}

function isStructural(code: number): boolean {
  return code === 0x22 || code === 0x7b || code === 0x5b || code === 0x7d || code === 0x5d || code === 0x2c || code === 0x3a
}

/** Pretty-print JSON without changing numeric spelling, duplicate keys, or string contents. */
export function formatJsonSource(source: string): string {
  assertJsonDepth(JSON.parse(source))
  const parts: string[] = []
  const expandedContainers: boolean[] = []
  const length = source.length
  let depth = 0
  let indentation = ''
  const indent = (next: number) => {
    depth = next
    indentation = '  '.repeat(depth)
  }

  let index = 0
  while (index < length) {
    const code = source.charCodeAt(index)
    if (code === 0x22) {
      // Strings are copied whole, escapes included.
      let end = index + 1
      while (end < length) {
        const inner = source.charCodeAt(end)
        end += 1
        if (inner === 0x5c) end += 1
        else if (inner === 0x22) break
      }
      parts.push(source.slice(index, end))
      index = end
      continue
    }
    if (isJsonWhitespace(code)) {
      index += 1
      continue
    }
    if (code === 0x7b || code === 0x5b) {
      const closing = code === 0x7b ? 0x7d : 0x5d
      let nextIndex = index + 1
      while (nextIndex < length && isJsonWhitespace(source.charCodeAt(nextIndex))) nextIndex += 1
      const expanded = source.charCodeAt(nextIndex) !== closing
      expandedContainers.push(expanded)
      parts.push(source[index])
      if (expanded) {
        indent(depth + 1)
        parts.push(`\n${indentation}`)
      }
      index += 1
      continue
    }
    if (code === 0x7d || code === 0x5d) {
      const expanded = expandedContainers.pop() ?? false
      if (expanded) {
        indent(depth - 1)
        parts.push(`\n${indentation}`)
      }
      parts.push(source[index])
      index += 1
      continue
    }
    if (code === 0x2c) {
      parts.push(`,\n${indentation}`)
      index += 1
      continue
    }
    if (code === 0x3a) {
      parts.push(': ')
      index += 1
      continue
    }
    // Numbers and literals are copied as one run.
    let end = index + 1
    while (end < length) {
      const inner = source.charCodeAt(end)
      if (isStructural(inner) || isJsonWhitespace(inner)) break
      end += 1
    }
    parts.push(source.slice(index, end))
    index = end
  }
  return parts.join('')
}

export type { ValuePath, ValueReplacement }
