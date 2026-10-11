import { describe, expect, it } from 'vitest'

import {
  appendJsonArrayItemInSource,
  inspectJsonSource,
  jsonSourceRangeAtPath,
  removeJsonValueInSource,
  replaceJsonAtomicValueInSource,
  replaceJsonValueInSource,
  replaceJsonValuesInSource,
  upsertJsonObjectPropertyInSource,
} from '../src/json-source-patcher'

describe('JSON source token replacement', () => {
  it('appends an array item without rewriting unrelated source', () => {
    const source = '{\n  "rows" : [\n    {"name":"Ada","unsafe":9007199254740993}\n  ],\n  "untouched":  true\n}\n'
    expect(appendJsonArrayItemInSource(source, ['rows'], { name: '', unsafe: 0 })).toBe(
      '{\n  "rows" : [\n    {"name":"Ada","unsafe":9007199254740993},\n    {\n      "name": "",\n      "unsafe": 0\n    }\n  ],\n  "untouched":  true\n}\n',
    )
  })

  it('appends to an empty compact array', () => {
    expect(appendJsonArrayItemInSource('{"rows":[]}', ['rows'], { name: '' }))
      .toBe('{"rows":[{"name":""}]}')
  })

  it('preserves indentation, CRLF line endings, and a trailing newline', () => {
    const source = '{\r\n    "nested": {\r\n        "value": "before"\r\n    }\r\n}\r\n'
    const next = replaceJsonAtomicValueInSource(source, ['nested', 'value'], 'after')

    expect(next).toBe('{\r\n    "nested": {\r\n        "value": "after"\r\n    }\r\n}\r\n')
  })

  it('preserves every unrelated byte, including unusual whitespace', () => {
    const source = ' { "before" : 1,\n\t"target"\t:\ttrue , "after": [ 1 , 2 ] } \n'

    expect(replaceJsonAtomicValueInSource(source, ['target'], false))
      .toBe(' { "before" : 1,\n\t"target"\t:\tfalse , "after": [ 1 , 2 ] } \n')
  })

  it('patches the last duplicate key used by JSON.parse and retains earlier duplicates', () => {
    const source = '{"value": 1, "value": 2, "other": 3}'

    expect(replaceJsonAtomicValueInSource(source, ['value'], 4))
      .toBe('{"value": 1, "value": 4, "other": 3}')
  })

  it('preserves unsafe integer lexemes outside the selected path', () => {
    const source = '{"unsafe":9007199254740993,"target":1,"negative":-9007199254740995}'

    expect(replaceJsonAtomicValueInSource(source, ['target'], 2))
      .toBe('{"unsafe":9007199254740993,"target":2,"negative":-9007199254740995}')
  })

  it('finds escaped, dotted, numeric-looking, and prototype-sensitive keys', () => {
    const source = '{"a\\u002eb":{"0":{"__proto__":"before"}},"a.b-sibling":"untouched"}'

    expect(replaceJsonAtomicValueInSource(source, ['a.b', '0', '__proto__'], 'after'))
      .toBe('{"a\\u002eb":{"0":{"__proto__":"after"}},"a.b-sibling":"untouched"}')
  })

  it('patches an exact array element without reserializing its siblings', () => {
    const source = '[ 1, {"value" : "before", "unsafe": 9007199254740993}, 3 ]'

    expect(replaceJsonAtomicValueInSource(source, [1, 'value'], 'after'))
      .toBe('[ 1, {"value" : "after", "unsafe": 9007199254740993}, 3 ]')
  })

  it('keeps array indices and numeric-looking object keys unambiguous', () => {
    expect(replaceJsonAtomicValueInSource('[{"0":"before"}]', [0, '0'], 'after'))
      .toBe('[{"0":"after"}]')
    expect(() => replaceJsonAtomicValueInSource('["before"]', ['0'], 'after')).toThrow(/array path segment/)
    expect(() => replaceJsonAtomicValueInSource('{"0":"before"}', [0], 'after')).toThrow(/object path segment/)
  })

  it('supports an editable atomic root at the empty path', () => {
    expect(replaceJsonAtomicValueInSource('"before"', [], 'after')).toBe('"after"')
    expect(() => replaceJsonAtomicValueInSource('{"value":"before"}', [], 'after'))
      .toThrow(/does not point to an editable atomic value/)
  })

  it('rejects missing, inherited, and non-container paths', () => {
    expect(() => replaceJsonAtomicValueInSource('{"value":"before"}', ['missing'], 'after'))
      .toThrow(/does not exist/)
    expect(() => replaceJsonAtomicValueInSource('{}', ['constructor'], 'after'))
      .toThrow(/does not exist/)
    expect(() => replaceJsonAtomicValueInSource('{"value":"before"}', ['value', 'nested'], 'after'))
      .toThrow(/is not a container/)
  })

  it('rejects container and null targets, type changes, and non-finite replacements', () => {
    expect(() => replaceJsonAtomicValueInSource('{"value":["before"]}', ['value'], 'after'))
      .toThrow(/does not point to an editable atomic value/)
    expect(() => replaceJsonAtomicValueInSource('{"value":null}', ['value'], 'after'))
      .toThrow(/does not point to an editable atomic value/)
    expect(() => replaceJsonAtomicValueInSource('{"value":1}', ['value'], '1'))
      .toThrow(/must keep type number/)
    expect(() => replaceJsonAtomicValueInSource('{"value":1}', ['value'], Number.NaN))
      .toThrow(/finite editable JSON atomic value/)
  })

  it('keeps compact source compact and does not invent a trailing newline', () => {
    expect(replaceJsonAtomicValueInSource('{"value":1}', ['value'], 2)).toBe('{"value":2}')
  })

  it('preserves tab indentation', () => {
    expect(replaceJsonAtomicValueInSource('{\n\t"value": true\n}', ['value'], false))
      .toBe('{\n\t"value": false\n}')
  })

  it('rejects invalid source JSON', () => {
    expect(() => replaceJsonAtomicValueInSource('{', ['value'], 'after')).toThrow(SyntaxError)
  })

  it('rejects a byte order mark like JSON.parse does', () => {
    expect(() => replaceJsonValueInSource('﻿{"value":1}', ['value'], 2)).toThrow(SyntaxError)
    expect(() => inspectJsonSource('﻿{}')).toThrow(SyntaxError)
  })

  it('keeps UTF-16 offsets exact after non-ASCII text and surrogate pairs', () => {
    const source = '{"emoji":"🙂🙂","名前":"値","target":1}'
    const start = source.lastIndexOf('1')
    expect(jsonSourceRangeAtPath(source, ['target'])).toEqual({ start, end: start + 1 })
    expect(replaceJsonValueInSource(source, ['target'], 2)).toBe('{"emoji":"🙂🙂","名前":"値","target":2}')
    expect(replaceJsonValueInSource(source, ['名前'], '新')).toBe('{"emoji":"🙂🙂","名前":"新","target":1}')
  })

  it('resolves keys containing escaped quotes and backslashes', () => {
    const source = '{"a\\"b":1,"c\\\\d":2}'
    expect(replaceJsonValueInSource(source, ['a"b'], 3)).toBe('{"a\\"b":3,"c\\\\d":2}')
    expect(replaceJsonValueInSource(source, ['c\\d'], 4)).toBe('{"a\\"b":1,"c\\\\d":4}')
  })

  it('treats a unicode-escaped key and its literal spelling as duplicates', () => {
    const source = '{"a\\u0062":1,"ab":2}'
    const second = source.indexOf('"ab"')
    expect(inspectJsonSource(source).diagnostics).toEqual([
      expect.objectContaining({ code: 'duplicate-key', sourcePath: ['ab'], token: '"ab"', start: second, end: second + '"ab":2'.length }),
    ])
    expect(replaceJsonValueInSource(source, ['ab'], 3)).toBe('{"a\\u0062":1,"ab":3}')
  })

  it('scans uppercase exponents and flags only the overflowing one', () => {
    const source = '{"a":1E2,"b":1.5E+3,"c":1E400,"d":true}'
    expect(inspectJsonSource(source).diagnostics.map((item) => [item.code, item.sourcePath, item.token])).toEqual([
      ['unsafe-number', ['c'], '1E400'],
    ])
    expect(replaceJsonValueInSource(source, ['d'], false)).toBe('{"a":1E2,"b":1.5E+3,"c":1E400,"d":false}')
  })

  it('appends to a multi-line empty array using the closing bracket indentation', () => {
    expect(appendJsonArrayItemInSource('{\n  "rows": [\n  ]\n}', ['rows'], { name: 'x' }))
      .toBe('{\n  "rows": [\n    {\n      "name": "x"\n    }\n  ]\n}')
  })
})

describe('removeJsonValueInSource', () => {
  it('deletes first, middle, and last array elements with their adjacent comma', () => {
    expect(removeJsonValueInSource('[ 1,  2, 3 ]', [0])).toBe('[ 2, 3 ]')
    expect(removeJsonValueInSource('[ 1,  2, 3 ]', [1])).toBe('[ 1,  3 ]')
    expect(removeJsonValueInSource('[ 1,  2, 3 ]', [2])).toBe('[ 1,  2 ]')
  })

  it('deletes nested object properties while preserving unrelated source bytes', () => {
    const source = '{\r\n  "before": 1,\r\n  "nested": { "remove" : [1, 2], "keep": 3 },\r\n  "after": 4\r\n}\r\n'
    expect(removeJsonValueInSource(source, ['nested', 'remove'])).toBe(
      '{\r\n  "before": 1,\r\n  "nested": { "keep": 3 },\r\n  "after": 4\r\n}\r\n',
    )
  })

  it('deletes the last duplicate property selected by JSON semantics', () => {
    expect(removeJsonValueInSource('{"value":1, "value":2, "keep":3}', ['value']))
      .toBe('{"value":1, "keep":3}')
  })

  it('supports deleting the sole child without changing container whitespace', () => {
    expect(removeJsonValueInSource('{ "value": 1 }', ['value'])).toBe('{  }')
    expect(removeJsonValueInSource('[ 1 ]', [0])).toBe('[  ]')
  })

  it('rejects the root, missing paths, and mismatched container segment types', () => {
    expect(() => removeJsonValueInSource('{"value":1}', [])).toThrow(/root/)
    expect(() => removeJsonValueInSource('{"value":1}', ['missing'])).toThrow(/does not exist/)
    expect(() => removeJsonValueInSource('[1]', ['0'])).toThrow(/non-negative integer/)
  })
})

describe('replaceJsonValueInSource', () => {
  it('replaces arrays and objects without reserializing their siblings', () => {
    const source = '{\n  "before" : 1,\n  "tags": ["old"],\n  "after": 9007199254740993\n}\n'

    expect(replaceJsonValueInSource(source, ['tags'], ['new', 'qualified'])).toBe(
      '{\n  "before" : 1,\n  "tags": ["new","qualified"],\n  "after": 9007199254740993\n}\n',
    )
  })

  it('supports replacing the document root', () => {
    expect(replaceJsonValueInSource('[1, 2]', [], { value: true }))
      .toBe('{"value":true}')
  })

  it('rejects missing paths and values that JSON cannot serialize', () => {
    expect(() => replaceJsonValueInSource('{}', ['missing'], true)).toThrow(/does not exist/)
    expect(() => replaceJsonValueInSource('{"value":1}', ['value'], undefined))
      .toThrow(/valid JSON/)
    expect(() => replaceJsonValueInSource('{"value":1}', ['value'], 1n))
      .toThrow(/valid JSON/)
  })
})

describe('upsertJsonObjectPropertyInSource', () => {
  it('adds metadata without reserializing existing data', () => {
    const source = '{\n  "rows" : [{"unsafe":9007199254740993}]\n}\n'
    expect(upsertJsonObjectPropertyInSource(source, [], '$jsonviews', { version: 1, views: [] })).toBe(
      '{\n  "rows" : [{"unsafe":9007199254740993}],\n  "$jsonviews":{"version":1,"views":[]}\n}\n',
    )
  })

  it('replaces an existing property and rejects non-object targets', () => {
    expect(upsertJsonObjectPropertyInSource('{"meta":{"version":1}}', [], 'meta', { version: 2 }))
      .toBe('{"meta":{"version":2}}')
    expect(() => upsertJsonObjectPropertyInSource('{"rows":[]}', ['rows'], 'meta', {}))
      .toThrow(/does not point to an object/)
  })
})

describe('replaceJsonValuesInSource', () => {
  it('patches several independent values without reserializing the document', () => {
    const source = '{\n  "one" : 3,\n  "nested": { "two": "old" },\n  "unsafe": 9007199254740993\n}\n'
    expect(replaceJsonValuesInSource(source, [
      { path: ['one'], value: 1 },
      { path: ['nested', 'two'], value: 'new' },
    ])).toBe('{\n  "one" : 1,\n  "nested": { "two": "new" },\n  "unsafe": 9007199254740993\n}\n')
  })

  it('rejects duplicate and ancestor paths', () => {
    expect(() => replaceJsonValuesInSource('{"value":1}', [
      { path: ['value'], value: 2 },
      { path: ['value'], value: 3 },
    ])).toThrow(/overlaps/)
    expect(() => replaceJsonValuesInSource('{"record":{"value":1}}', [
      { path: ['record'], value: { value: 2 } },
      { path: ['record', 'value'], value: 3 },
    ])).toThrow(/overlaps/)
  })
})
