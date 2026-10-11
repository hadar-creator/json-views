import { describe, expect, it } from 'vitest'

import {
  compileJsonViewMetadata,
  formatJsonSource,
  inspectJsonSource,
  jsonSourceRangesAtPaths,
  prefersSource,
  schemaForJsonViewPath,
  type ValuePath,
} from '../src'
import {
  legacyFormatJsonSource,
  legacyInspectJsonSource,
  legacyJsonSourceRangesAtPaths,
  legacyPrefersSource,
  legacySchemaForJsonViewPath,
  legacyValidationSequence,
} from './legacy-oracles'

// mulberry32: a small deterministic generator so failures reproduce.
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]

type SourceNode =
  | { kind: 'object'; entries: Array<[keyText: string, value: SourceNode]> }
  | { kind: 'array'; items: SourceNode[] }
  | { kind: 'atom'; text: string }

const KEY_TEXTS = ['"a"', '"b"', '"ab"', '"a\\u0062"', '"q\\"uote"', '"back\\\\slash"', '"名前"', '"emoji🙂"', '"0"', '"__proto__"', '"with space"']
const NUMBER_TEXTS = [
  '0', '-0', '1', '-7', '42', '123456789012345', '1234567890123456', '9007199254740991', '9007199254740992', '9007199254740993',
  '-9007199254740995', '1e2', '1E2', '1.5E+3', '1e400', '1e-400', '0.1', '0.12345678901234567890', '1.0000000000000001', '100.0',
  '2.5e-3', '-0.0', '1e21', '123456789012345678901234567890',
]
const ATOM_TEXTS = ['true', 'false', 'null', '"text"', '"esc\\n\\t\\"aped"', '"🙂"', '""']

function randomNode(next: () => number, depth: number): SourceNode {
  const roll = next()
  if (depth < 4 && roll < 0.3) {
    const entries: Array<[string, SourceNode]> = []
    const count = Math.floor(next() * 5)
    for (let index = 0; index < count; index += 1) {
      const key = pick(next, KEY_TEXTS)
      entries.push([key, randomNode(next, depth + 1)])
      // Repeat a key now and then so duplicates and shadowing get exercised.
      if (next() < 0.25) entries.push([key, randomNode(next, depth + 1)])
    }
    return { kind: 'object', entries }
  }
  if (depth < 4 && roll < 0.5) {
    return { kind: 'array', items: Array.from({ length: Math.floor(next() * 5) }, () => randomNode(next, depth + 1)) }
  }
  return { kind: 'atom', text: next() < 0.5 ? pick(next, NUMBER_TEXTS) : pick(next, ATOM_TEXTS) }
}

function serialize(node: SourceNode, next: () => number): string {
  const space = () => pick(next, ['', '', ' ', '\n', '\t', '\r\n', '  \n  '])
  if (node.kind === 'atom') return node.text
  if (node.kind === 'array') {
    return `[${space()}${node.items.map((item) => serialize(item, next)).join(`${space()},${space()}`)}${space()}]`
  }
  return `{${space()}${node.entries.map(([key, value]) => `${key}${space()}:${space()}${serialize(value, next)}`).join(`${space()},${space()}`)}${space()}}`
}

function leafPaths(value: unknown, path: ValuePath = []): ValuePath[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => leafPaths(item, [...path, index]))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...path, key]))
  }
  return [path]
}

function randomDocuments(seed: number, count: number): string[] {
  const next = random(seed)
  return Array.from({ length: count }, () => {
    const source = `${pick(next, ['', ' ', '\n'])}${serialize(randomNode(next, 0), next)}${pick(next, ['', ' ', '\n'])}`
    JSON.parse(source)
    return source
  })
}

describe('source scanner equivalence', () => {
  const documents = randomDocuments(7, 300)

  it('reports the same inspection diagnostics as the previous scanner', () => {
    for (const source of documents) {
      expect(inspectJsonSource(source)).toEqual(legacyInspectJsonSource(source))
    }
  })

  it('locates the same source ranges as the previous scanner', () => {
    for (const source of documents) {
      const paths = leafPaths(JSON.parse(source))
      expect(jsonSourceRangesAtPaths(source, paths)).toEqual(legacyJsonSourceRangesAtPaths(source, paths))
    }
  })

  it('formats source exactly like the previous formatter', () => {
    for (const source of documents) {
      expect(formatJsonSource(source)).toBe(legacyFormatJsonSource(source))
    }
  })
})

describe('inspectJsonSource cache', () => {
  it('returns fresh values and diagnostic objects for repeated inspections of one text', () => {
    const source = '{"a":9007199254740993,"a":1,"b":{"c":1e400}}'
    const first = inspectJsonSource(source)
    const second = inspectJsonSource(source)
    expect(second).toEqual(first)
    expect(second.value).not.toBe(first.value)
    expect(second.diagnostics).not.toBe(first.diagnostics)
    expect(second.diagnostics[0]).not.toBe(first.diagnostics[0])
    expect(second.diagnostics[0].sourcePath).not.toBe(first.diagnostics[0].sourcePath)
    expect(second.diagnostics[0].help).not.toBe(first.diagnostics[0].help)
    ;(first.diagnostics[0].sourcePath as Array<string | number>)[0] = 'other'
    ;(first.diagnostics[0] as { code: string }).code = 'changed'
    first.diagnostics.push(first.diagnostics[0])
    // Compare with independently built results: earlier results may share whatever was corrupted.
    expect(inspectJsonSource(source)).toEqual(legacyInspectJsonSource(source))
  })

  it('never serves one text from another text of the same length', () => {
    const left = '{"a":9007199254740993}'
    const right = '{"b":9007199254740993}'
    expect(inspectJsonSource(left).diagnostics[0].sourcePath).toEqual(['a'])
    expect(inspectJsonSource(right).diagnostics[0].sourcePath).toEqual(['b'])
    expect(inspectJsonSource(left).diagnostics[0].sourcePath).toEqual(['a'])
    expect(() => inspectJsonSource('{"a":')).toThrow(SyntaxError)
    expect(inspectJsonSource(left).diagnostics[0].sourcePath).toEqual(['a'])
  })
})

describe('schema lookup equivalence', () => {
  const next = random(11)
  const roots = Array.from({ length: 120 }, () => ({
    rows: Array.from({ length: Math.floor(next() * 4) }, (_, index) => (next() < 0.8
      ? { name: index, score: index * 2, nested: next() < 0.5 ? { deep: { v: index } } : null, ...(next() < 0.3 ? { extra: 1 } : {}) }
      : index)),
    byId: Object.fromEntries(Array.from({ length: Math.floor(next() * 3) }, (_, index) => [`k${index}`, { name: index, score: next() < 0.5 ? index : null }])),
    ...(next() < 0.3 ? { scalar: 5 } : {}),
    ...(next() < 0.3 ? { empty: [] } : {}),
  }))
  const candidates = [
    '$.rows[*].name', '$.rows[*].score', '$.rows[0].name', '$.rows[1].score', '$.rows[*].nested.deep.v', '$.rows[*].absent',
    '$.rows[*].nested.absent', '$.rows[0]', '$.rows[*]', '$.rows', '$.byId[*].name', '$.byId[*].score', '$.byId.k0.name', "$.byId['k1'].score",
    '$.missing[*].a', '$.missing[*].b', '$.missing', '$.scalar', '$.scalar[*].x', '$.empty[*].x', '$[*][*].name', '$[*].name', "$.rows[*]['0']",
  ]
  const schemas = Array.from({ length: 120 }, () => {
    const shuffled = [...candidates].sort(() => next() - 0.5)
    const count = 1 + Math.floor(next() * 8)
    // Every location must report exactly one diagnostic, so the validation order is observable.
    return Object.fromEntries(shuffled.slice(0, count).map((path) => [path, { type: 'text', required: true }]))
  })

  it('selects the same schema entry as the previous filter-and-sort lookup', () => {
    const paths: ValuePath[] = [
      ['rows', 0, 'name'], ['rows', 1, 'score'], ['rows', 0], ['rows'], ['byId', 'k0', 'name'], ['byId', 'k1', 'score'], ['missing'],
      ['rows', 0, 'nested', 'deep', 'v'], ['rows', 0, '0'], [0, 0, 'name'], ['scalar'], ['empty', 0, 'x'], [], ['rows', '0', 'name'],
    ]
    for (const schema of schemas) {
      const compiled = compileJsonViewMetadata(roots[0], undefined, { metadata: { version: 1, schema }, validateValues: false })
      for (const path of paths) {
        expect(schemaForJsonViewPath(compiled.schema, path)).toBe(legacySchemaForJsonViewPath(compiled.schema, path))
        const reversed = [...compiled.schema].reverse()
        expect(schemaForJsonViewPath(reversed, path)).toBe(legacySchemaForJsonViewPath(reversed, path))
      }
    }
  })

  it('validates the same locations in the same order as the previous validator', () => {
    for (let index = 0; index < schemas.length; index += 1) {
      const root = roots[index % roots.length]
      const compiled = compileJsonViewMetadata(root, undefined, { metadata: { version: 1, schema: schemas[index] } })
      const reported = compiled.diagnostics
        .filter((item) => item.scope === 'value')
        .map((item) => ({ declaration: item.declaration, sourcePath: item.sourcePath, missing: item.code === 'required-value-missing' }))
      expect(reported).toEqual(legacyValidationSequence(root, compiled.schema))
    }
  })

  it('compiles identical schema and views without value validation', () => {
    for (let index = 0; index < schemas.length; index += 1) {
      const root = roots[index % roots.length]
      const metadata = { version: 1, schema: schemas[index], views: [{ id: 'rows', name: 'Rows', path: '$.rows', columns: [{ label: 'Name', path: '$.rows[*].name' }] }] }
      const full = compileJsonViewMetadata(root, undefined, { metadata })
      const light = compileJsonViewMetadata(root, undefined, { metadata, validateValues: false })
      expect(light.schema).toEqual(full.schema)
      expect(light.views).toEqual(full.views)
      expect(light.active).toBe(full.active)
      expect(light.diagnostics).toEqual(full.diagnostics.filter((item) => item.scope !== 'value'))
    }
  })
})

describe('prefersSource equivalence', () => {
  it('decides like the previous implementation for small and large documents', () => {
    const next = random(5)
    const small = randomDocuments(13, 150)
    const large = Array.from({ length: 10 }, () => JSON.stringify({
      rows: Array.from({ length: 60 + Math.floor(next() * 60) }, (_, index) => ({ id: index, nested: { deep: { value: index } } })),
    }))
    const nested = Array.from({ length: 10 }, () => JSON.stringify({
      settings: { a: { b: { c: Array.from({ length: Math.floor(next() * 4) }, (_, index) => ({ d: index })) } } },
    }))
    for (const source of [...small, ...large, ...nested, '5', '"text"', '[]', '{}', 'nope']) {
      expect(prefersSource(source)).toBe(legacyPrefersSource(source))
    }
  })
})
