import { describe, expect, it } from 'vitest'

import {
  JSON_VIEW_PATH_MISSING,
  compileJsonViewMetadata,
  getJsonViewViewRows,
  parseJsonViewPath,
  resolveJsonViewRowPath,
  schemaForJsonViewPath,
} from '../src/metadata'
import { createDefaultTypeRegistry } from '../src/type-registry'

describe('JSON Views JSONPath subset', () => {
  it('preserves prototype-named option colors as ordinary data', () => {
    const compiled = compileJsonViewMetadata({ status: '__proto__' }, undefined, { metadata: {
      version: 1, schema: { '$.status': { type: 'select', optionColors: JSON.parse('{"__proto__":"red"}') } },
    } })
    const colors = compiled.schema[0].descriptor.optionColors!
    expect(Object.hasOwn(colors, '__proto__')).toBe(true)
    expect(colors.__proto__).toBe('red')
    expect(colors.toString).toBeUndefined()
  })
  it('parses absolute paths without losing property/index types', () => {
    expect(parseJsonViewPath("$['a.b'][0].owner['display name']", { root: '$' }).segments).toEqual([
      { kind: 'property', key: 'a.b' },
      { kind: 'index', index: 0 },
      { kind: 'property', key: 'owner' },
      { kind: 'property', key: 'display name' },
    ])
    expect(parseJsonViewPath('$.items[2]', { root: '$' }).segments).toEqual([
      { kind: 'property', key: 'items' },
      { kind: 'index', index: 2 },
    ])
  })

  it('allows schema wildcards only when explicitly enabled', () => {
    expect(parseJsonViewPath('$.rows[*].status', { root: '$', allowWildcard: true }).segments[1])
      .toEqual({ kind: 'wildcard' })
    expect(() => parseJsonViewPath('$.rows[*]', { root: '$' })).toThrow(/wildcards are not allowed/)
    expect(() => parseJsonViewPath('@.rows')).toThrow(/must start with \$/)
    expect(() => parseJsonViewPath('$[01]')).toThrow(/non-negative integer/)
  })
})

describe('compileJsonViewMetadata', () => {
  it('leaves non-object roots and unsupported metadata versions inactive', () => {
    for (const root of [[], 'value', null, { rows: [] }, { $jsonviews: { version: 2, views: [] } }]) {
      const compiled = compileJsonViewMetadata(root)
      expect(compiled.recognized).toBe(false)
      expect(compiled.active).toBe(false)
      expect(compiled.schema).toEqual([])
      expect(compiled.views).toEqual([])
    }
  })

  it('compiles schema and ordered views with exact source paths', () => {
    const root = {
      leads: [{ id: '1', owner: { email: 'alice@example.com' }, status: 'new', rank: 1 }],
      by_id: { one: { status: 'new' } },
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new', 'closed'] },
        },
        views: [
          {
            name: 'Pipeline',
            path: '$.leads',
            display: 'kanban',
            groupBy: '$.leads[*].status',
            groupOrder: ['closed', 'new'],
            orderPath: '$.leads[*].rank',
            columns: [
              { label: 'Owner', path: '$.leads[*].owner.email' },
              { label: 'Status', path: '$.leads[*].status' },
            ],
            filter: { rules: [{ path: '$.leads[*].status', operator: 'in', value: ['new'] }] },
            sort: [{ path: '$.leads[*].rank', direction: 'asc' }],
          },
          { id: 'records', name: 'Records', path: '$.by_id' },
        ],
      },
    }

    const compiled = compileJsonViewMetadata(root)
    expect(compiled.root).toBe(root)
    expect(compiled.recognized).toBe(true)
    expect(compiled.active).toBe(true)
    expect(compiled.schema).toHaveLength(1)
    expect(compiled.views.map((view) => view.id)).toEqual(['view-1', 'records'])
    expect(compiled.views[0]).toMatchObject({
      sourcePath: ['leads'],
      value: root.leads,
      display: 'kanban',
      declarationIndex: 0,
    })
    expect(compiled.views[0].columns?.map((column) => column.label)).toEqual(['Owner', 'Status'])
    expect(compiled.views[0].filter).toMatchObject({ match: 'all', rules: [{ operator: 'in', value: ['new'] }] })
    expect(compiled.views[0].groupOrder).toEqual(['closed', 'new'])
    expect(compiled.views[0].sort.map((sort) => sort.direction)).toEqual(['asc'])
    expect(compiled.diagnostics).toEqual([])

    const [row] = getJsonViewViewRows(compiled.views[0])
    expect(row.sourcePath).toEqual(['leads', 0])
    expect(resolveJsonViewRowPath(root, row, compiled.views[0].columns![0].path)).toEqual({
      value: 'alice@example.com',
      sourcePath: ['leads', 0, 'owner', 'email'],
    })
    expect(resolveJsonViewRowPath(root, row, parseJsonViewPath('$.leads[*].missing.deep', { root: '$', allowWildcard: true }))).toEqual({
      value: JSON_VIEW_PATH_MISSING,
      sourcePath: ['leads', 0, 'missing', 'deep'],
    })
  })

  it('rejects the removed page display for every data shape', () => {
    const root = {
      profile: { name: 'Ada', role: 'Engineer' },
      rows: [{ name: 'Grace' }],
      scalar: 3,
      $jsonviews: {
        version: 1,
        views: [
          { id: 'profile', name: 'Profile', path: '$.profile', display: 'page' },
          { id: 'rows', name: 'Rows', path: '$.rows', display: 'page' },
          { id: 'scalar', name: 'Scalar', path: '$.scalar', display: 'page' },
        ],
      },
    }

    const compiled = compileJsonViewMetadata(root)
    expect(compiled.views).toHaveLength(0)
    expect(compiled.diagnostics.filter((item) => item.code === 'invalid-display')).toHaveLength(3)
  })

  it('ignores invalid declarations independently and keeps valid views in document order', () => {
    const root = {
      rows: [{ status: 'new' }],
      scalar: 3,
      $jsonviews: {
        version: 1,
        schema: {
          '@.wrong': { type: 'text' },
          '$.rows[*].status': { type: 'text' },
          '$.rows[*].bad': { type: 'unsupported', title: 'Ignored' },
        },
        views: [
          { id: 'missing', name: 'Missing', path: '$.nope' },
          {
            id: 'rows',
            name: 'Rows',
            path: '$.rows',
            columns: [{ label: 'Status', path: '$.rows[*].status' }, { label: '', path: '$.rows[*].bad' }],
            filter: { match: 'any', rules: [{ path: '$.rows[*].status', operator: 'eq', value: 'new' }, { path: '@.bad', operator: 'eq', value: 1 }] },
            sort: [{ path: '$.rows[*].status', direction: 'asc' }, { path: '$.rows[*].bad', direction: 'sideways' }],
          },
          { id: 'scalar', name: 'Scalar', path: '$.scalar', display: 'kanban', groupBy: '$.scalar[*].status', columns: [{ label: 'Status', path: '$.scalar[*].status' }] },
          { id: 'valid', name: 'Valid', path: '$.rows' },
        ],
      },
    }

    const compiled = compileJsonViewMetadata(root)
    expect(compiled.schema).toHaveLength(1)
    expect(compiled.schema[0].descriptor).toEqual({ type: 'text' })
    expect(compiled.views.map((view) => view.id)).toEqual(['valid'])
    expect(new Set(compiled.diagnostics.map((item) => item.code))).toEqual(expect.objectContaining(new Set([
      'invalid-schema-path',
      'invalid-schema-type',
      'unresolved-view-path',
      'invalid-column',
      'invalid-filter-path',
      'invalid-sort-entry',
      'incompatible-kanban',
      'incompatible-view',
    ])))
  })

  it('selects the most specific schema and diagnoses equal-specificity conflicts', () => {
    const root = {
      rows: [['value']],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*][0]': { type: 'text', title: 'First' },
          '$.rows[0][*]': { type: 'text', title: 'Conflicting' },
          '$.rows[0][0]': { type: 'text', title: 'Exact' },
        },
      },
    }
    const compiled = compileJsonViewMetadata(root)

    expect(schemaForJsonViewPath(compiled.schema, ['rows', 0, 0])?.descriptor.title).toBe('Exact')
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: 'schema-specificity-conflict' }))

    const withoutExact = compiled.schema.slice(0, 2)
    expect(schemaForJsonViewPath(withoutExact, ['rows', 0, 0])?.descriptor.title).toBe('First')
  })

  it('reports value diagnostics without hiding or coercing existing values', () => {
    const root = {
      rows: [{ score: 101, email: 'invalid' }, {}],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].score': { type: 'number', minimum: 0, maximum: 100, required: true },
          '$.rows[*].email': { type: 'email' },
          '$.rows[*].status': { type: 'text', required: true },
        },
      },
    }
    const compiled = compileJsonViewMetadata(root)

    expect(root.rows[0].score).toBe(101)
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 0, 'score'] }),
      expect.objectContaining({ code: 'required-value-missing', sourcePath: ['rows', 1, 'score'] }),
      expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 0, 'email'] }),
      expect.objectContaining({ code: 'required-value-missing', sourcePath: ['rows', 0, 'status'] }),
      expect.objectContaining({ code: 'required-value-missing', sourcePath: ['rows', 1, 'status'] }),
    ]))
  })

  it('suppresses only unfinished required fields below draft paths', () => {
    const root = {
      rows: [{ name: '' }, { name: '' }],
      $jsonviews: { version: 1, schema: { '$.rows[*].name': { type: 'text', required: true } } },
    }

    const compiled = compileJsonViewMetadata(root, undefined, { suppressRequiredPaths: [['rows', 1]] })

    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 0, 'name'] }))
    expect(compiled.diagnostics).not.toContainEqual(expect.objectContaining({ sourcePath: ['rows', 1, 'name'] }))
  })

  it('accepts empty optional values and rejects empty required values', () => {
    const compiled = compileJsonViewMetadata({
      rows: [
        { optionalUrl: null, optionalEmail: '', requiredUrl: null, requiredText: '' },
        { optionalUrl: 'not-a-url', optionalEmail: 'not-an-email', requiredUrl: 'https://script.it', requiredText: 'Ready' },
      ],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].optionalUrl': { type: 'url' },
          '$.rows[*].optionalEmail': { type: 'email' },
          '$.rows[*].requiredUrl': { type: 'url', required: true },
          '$.rows[*].requiredText': { type: 'text', required: true },
        },
      },
    })

    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 0, 'requiredUrl'] }),
      expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 0, 'requiredText'] }),
      expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 1, 'optionalUrl'] }),
      expect.objectContaining({ code: 'invalid-typed-value', sourcePath: ['rows', 1, 'optionalEmail'] }),
    ]))
    expect(compiled.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: ['rows', 0, 'optionalUrl'] }),
      expect.objectContaining({ sourcePath: ['rows', 0, 'optionalEmail'] }),
    ]))
  })

  it('normalizes date options and diagnoses invalid date metadata', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ due: '2026-09-04T15:30:00' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].due': {
            type: 'date',
            minimum: '2026-01-01',
            maximum: '2027-12-31',
            defaultIncludeTime: true,
          },
          '$.rows[*].bad': {
            type: 'date',
            minimum: '09/04/2026',
            defaultIncludeTime: 'yes',
          },
        },
      },
    })

    expect(compiled.schema[0]?.descriptor).toMatchObject({
      type: 'date',
      minimum: '2026-01-01',
      maximum: '2027-12-31',
      defaultIncludeTime: true,
    })
    expect(compiled.schema[1]?.descriptor).not.toHaveProperty('minimum')
    expect(compiled.schema[1]?.descriptor).not.toHaveProperty('defaultIncludeTime')
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-minimum' }),
      expect.objectContaining({ code: 'invalid-defaultIncludeTime' }),
    ]))
    expect(compiled.diagnostics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'typed-value-warning' }),
    ]))
  })

  it('rejects filter operators that the date type does not support', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ due: '2026-09-04' }],
      $jsonviews: {
        version: 1,
        schema: { '$.rows[*].due': { type: 'date' } },
        views: [{
          id: 'dates',
          name: 'Dates',
          path: '$.rows',
          filter: { rules: [{ path: '$.rows[*].due', operator: 'contains', value: '2026' }] },
        }],
      },
    })

    expect(compiled.views).toEqual([])
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-filter-operator' }))
  })

  it('normalizes multiple legacy body fields to Markdown', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ summary: 'one', notes: 'two' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].summary': { type: 'body' },
          '$.rows[*].notes': { type: 'body' },
        },
      },
    })

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.schema.map(({ descriptor }) => descriptor)).toEqual([{ type: 'markdown' }, { type: 'markdown' }])
  })

  it('omits a view when a declared column is invalid', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ name: 'Ada' }],
      $jsonviews: {
        version: 1,
        views: [{ id: 'rows', name: 'Rows', path: '$.rows', columns: [{ label: '', path: '$.rows[*].name' }] }],
      },
    })

    expect(compiled.views).toEqual([])
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code: 'invalid-column' }))
  })

  it('treats omitted and empty columns as inferred top-level fields', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ name: 'Ada', status: 'ready' }],
      $jsonviews: {
        version: 1,
        views: [
          { name: 'Omitted', path: '$.rows' },
          { name: 'Empty', path: '$.rows', columns: [] },
        ],
      },
    })

    expect(compiled.views).toHaveLength(2)
    expect(compiled.views.map(({ columns }) => columns)).toEqual([undefined, undefined])
    expect(compiled.diagnostics).toEqual([])
  })

  it('omits a view when a declared path resolves on no records', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ name: 'Ada', status: 'ready' }, { name: 'Grace', status: 'done' }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'rows',
          name: 'Rows',
          path: '$.rows',
          columns: [
            { label: 'Name', path: '$.rows[*].name' },
            { label: 'Missing', path: '$.rows[*].summary' },
          ],
        }],
      },
    })

    expect(compiled.views).toEqual([])
    expect(compiled.diagnostics).toContainEqual(expect.objectContaining({
      code: 'invalid-column-path',
      viewId: 'rows',
    }))
  })

  it('uses temporary ordering when orderPath cannot safely persist card order', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ status: 'new', rank: 'first' }],
      $jsonviews: {
        version: 1,
        views: [
          { id: 'same', name: 'Same', path: '$.rows', display: 'kanban', groupBy: '$.rows[*].status', orderPath: '$.rows[*].status' },
          { id: 'text', name: 'Text', path: '$.rows', display: 'kanban', groupBy: '$.rows[*].status', orderPath: '$.rows[*].rank' },
        ],
      },
    })

    expect(compiled.views).toEqual([])
    expect(compiled.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'conflicting-kanban-paths', viewId: 'same' }),
      expect.objectContaining({ code: 'invalid-order-value', viewId: 'text' }),
    ]))
  })

  it('validates calendar dates and web URLs precisely', () => {
    const compiled = compileJsonViewMetadata({
      rows: [{ date: '2026-02-31', website: 'javascript:alert(1)' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].date': { type: 'date' },
          '$.rows[*].website': { type: 'url' },
        },
      },
    })

    expect(compiled.diagnostics.filter(({ code }) => code === 'invalid-typed-value')).toHaveLength(2)
  })

  it('infers select and multi-select options from existing values', () => {
    const compiled = compileJsonViewMetadata({
      rows: [
        { status: 'new', tags: ['priority', 'sales'] },
        { status: 'done', tags: ['sales'] },
      ],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].status': { type: 'select' },
          '$.rows[*].tags': { type: 'multi-select' },
        },
      },
    })

    expect(compiled.schema.map(({ descriptor }) => descriptor.options)).toEqual([
      ['new', 'done'],
      ['priority', 'sales'],
    ])
    expect(compiled.diagnostics).toEqual([])
  })

  it('adds existing custom values after declared select options', () => {
    const compiled = compileJsonViewMetadata({
      rows: [
        { status: 'Customer', tags: ['Design'] },
        { status: 'New', tags: ['Product'] },
      ],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].status': { type: 'select', options: ['New'] },
          '$.rows[*].tags': { type: 'multi-select', options: ['Engineering'] },
        },
      },
    })

    expect(compiled.schema.map(({ descriptor }) => descriptor.options)).toEqual([
      ['New', 'Customer'],
      ['Engineering', 'Design', 'Product'],
    ])
    expect(compiled.diagnostics).toEqual([])
  })

  it('infers options through dictionary record wildcards', () => {
    const compiled = compileJsonViewMetadata({
      rows: { first: { status: 'new' }, second: { status: 'done' } },
      $jsonviews: {
        version: 1,
        schema: { '$.rows[*].status': { type: 'select' } },
      },
    })

    expect(compiled.schema[0].descriptor.options).toEqual(['new', 'done'])
    expect(compiled.diagnostics).toEqual([])
  })

  it('supports custom descriptor fields through a registered type', () => {
    const types = createDefaultTypeRegistry().register({
      name: 'rating',
      validate: (value, descriptor) => (
        typeof value === 'number' && value <= Number(descriptor.maxStars)
          ? undefined
          : 'Rating is outside its configured range'
      ),
    })
    const compiled = compileJsonViewMetadata({
      score: 4,
      $jsonviews: {
        version: 1,
        schema: {
          '$.score': { type: 'rating', maxStars: 5 },
        },
      },
    }, types)

    expect(compiled.schema[0].descriptor).toEqual({ type: 'rating', maxStars: 5 })
    expect(compiled.diagnostics).toEqual([])
  })
})

describe('value validation of missing ancestors', () => {
  const missing = (diagnostics: { code: string }[]) => diagnostics.filter((item) => item.code === 'required-value-missing')
  const compile = (schema: Record<string, unknown>) => compileJsonViewMetadata({ other: 1 }, undefined, { metadata: { version: 1, schema } })

  it('lets the first entry reaching a missing collection claim it, even when it is optional', () => {
    const optionalFirst = compile({ '$.rows[*].a': { type: 'text' }, '$.rows[*].b': { type: 'text', required: true } })
    expect(missing(optionalFirst.diagnostics)).toEqual([])

    const requiredFirst = compile({ '$.rows[*].b': { type: 'text', required: true }, '$.rows[*].a': { type: 'text' } })
    expect(missing(requiredFirst.diagnostics)).toEqual([
      expect.objectContaining({ sourcePath: ['rows'], metadataPath: ['$jsonviews', 'schema', '$.rows[*].b'] }),
    ])
  })

  it('reports a missing collection once when several required entries reach it', () => {
    const compiled = compile({ '$.rows[*].a': { type: 'text', required: true }, '$.rows[*].b': { type: 'text', required: true } })
    expect(missing(compiled.diagnostics)).toEqual([
      expect.objectContaining({ sourcePath: ['rows'], metadataPath: ['$jsonviews', 'schema', '$.rows[*].a'] }),
    ])
  })

  it('leaves a missing collection to an entry declared on the collection itself, in either order', () => {
    const before = compile({ '$.rows': { type: 'text' }, '$.rows[*].name': { type: 'text', required: true } })
    const after = compile({ '$.rows[*].name': { type: 'text', required: true }, '$.rows': { type: 'text' } })
    expect(missing(before.diagnostics)).toEqual([])
    expect(missing(after.diagnostics)).toEqual([])
  })
})
