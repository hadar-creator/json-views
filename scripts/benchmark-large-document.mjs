// Times the core pipeline on one large document and optionally dumps canonical
// outputs so two builds can be diffed for behavioral equality.
//
//   npm run build -w @script-it/json-views-core
//   node scripts/benchmark-large-document.mjs [--file data.json] [--rows 8362] [--iterations 5] [--dump out-dir]
//
// Without --file, a deterministic synthetic document shaped like a keyword
// research export (annotated records, select/checkbox/number/date fields,
// four views with filters and a two-key sort) is generated in memory.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const coreEntry = fileURLToPath(new URL('../packages/core/dist/index.js', import.meta.url))
if (!existsSync(coreEntry)) {
  console.error('Build the core package first: npm run build -w @script-it/json-views-core')
  process.exit(1)
}
const core = await import(coreEntry)

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const file = option('file')
const rows = Number(option('rows', '8362'))
const iterations = Math.max(1, Number(option('iterations', '5')))
const dumpDirectory = option('dump')

function syntheticDocument(count) {
  // mulberry32: small, deterministic, good enough for shaping data.
  let seed = 0x9e3779b9
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (items) => items[Math.floor(random() * items.length)]
  const clusters = ['Automation platforms', 'Browser and AI automation', 'Invoice generator', 'Email generator', 'AI agent builders', 'General agents', 'Alternative automation platforms', 'Workflow tools', 'Data pipelines', 'Form builders', 'Scheduling', 'general']
  const paths = ['keyword_cluster', 'connecting_tools', 'automating_tool', 'related_other']
  const tools = ['Zapier', 'n8n', 'Make', 'Pipedream', 'Airtable', 'Notion', 'Slack', 'HubSpot', 'Gmail', 'Sheets']
  const words = ['ai', 'agent', 'automation', 'workflow', 'generator', 'builder', 'free', 'online', 'tool', 'app', 'api', 'template', 'integration', 'connect', 'sync']
  const day = (index) => new Date(Date.UTC(2026, 0, 1 + (index % 240))).toISOString()
  const records = Array.from({ length: count }, (_, index) => {
    const cluster = pick(clusters)
    const keyword = Array.from({ length: 2 + Math.floor(random() * 4) }, () => pick(words)).join(' ') + ` ${index}`
    const volume = Math.floor(random() ** 3 * 200000)
    const cpc = Math.round(random() * 12 * 100) / 100
    return {
      first_checked: day(index),
      last_checked: day(index + 30),
      times_checked: 1 + (index % 4),
      keyword,
      cluster_id: `cluster-${clusters.indexOf(cluster)}`,
      cluster_name: cluster,
      path: pick(paths),
      seed_keyword: pick(words),
      source_tool: pick(tools),
      destination_tool: pick(tools),
      tool: pick(tools),
      reason: `Related to ${cluster.toLowerCase()} because ${pick(words)} ${pick(words)} ${pick(words)}.`,
      concept_id: `concept-${Math.floor(index / 7)}`,
      representative_keyword: keyword,
      is_representative: index % 7 === 0,
      variant_count: 1 + Math.floor(random() * 9),
      monthly_search_volume: volume,
      average_cpc_usd: cpc,
      low_top_of_page_bid_usd: Math.round(cpc * 0.6 * 100) / 100,
      high_top_of_page_bid_usd: Math.round(cpc * 1.7 * 100) / 100,
      competition: pick(['LOW', 'MEDIUM', 'HIGH']),
      competition_index: Math.floor(random() * 100),
      recent_3_month_average_volume: Math.floor(volume * (0.8 + random() * 0.4)),
      tags: Array.from({ length: Math.floor(random() * 3) }, () => pick(['core', 'expand', 'watch', 'drop'])),
    }
  })
  const field = (name) => `$.records[*].${name}`
  const schema = {
    [field('keyword')]: { type: 'text', required: true },
    [field('cluster_id')]: { type: 'text' },
    [field('cluster_name')]: { type: 'text' },
    [field('path')]: { type: 'select', options: paths },
    [field('seed_keyword')]: { type: 'text' },
    [field('source_tool')]: { type: 'text' },
    [field('destination_tool')]: { type: 'text' },
    [field('tool')]: { type: 'text' },
    [field('reason')]: { type: 'text' },
    [field('concept_id')]: { type: 'text' },
    [field('representative_keyword')]: { type: 'text' },
    [field('is_representative')]: { type: 'checkbox' },
    [field('variant_count')]: { type: 'number', minimum: 1 },
    [field('monthly_search_volume')]: { type: 'number', minimum: 0 },
    [field('average_cpc_usd')]: { type: 'number', minimum: 0 },
    [field('low_top_of_page_bid_usd')]: { type: 'number', minimum: 0 },
    [field('high_top_of_page_bid_usd')]: { type: 'number', minimum: 0 },
    [field('competition')]: { type: 'select', options: ['LOW', 'MEDIUM', 'HIGH'] },
    [field('competition_index')]: { type: 'number', minimum: 0, maximum: 100 },
    [field('recent_3_month_average_volume')]: { type: 'number', minimum: 0 },
    [field('first_checked')]: { type: 'date' },
    [field('last_checked')]: { type: 'date' },
    [field('times_checked')]: { type: 'number', minimum: 0 },
    [field('tags')]: { type: 'multi-select' },
  }
  const column = (label, name) => ({ label, path: field(name) })
  const views = [
    {
      id: 'unique-concepts', name: 'Unique concepts', path: '$.records',
      columns: [column('Cluster', 'cluster_name'), column('Keyword', 'keyword'), column('Volume', 'monthly_search_volume'), column('CPC', 'average_cpc_usd'), column('Variants', 'variant_count')],
      filter: { rules: [{ path: field('is_representative'), operator: 'eq', value: true }, { path: field('average_cpc_usd'), operator: 'lt', value: 4 }] },
    },
    {
      id: 'all-researched-terms', name: 'All researched terms', path: '$.records',
      columns: [column('Cluster', 'cluster_name'), column('Keyword', 'keyword'), column('Representative', 'representative_keyword'), column('Path', 'path'), column('Volume', 'monthly_search_volume'), column('CPC', 'average_cpc_usd'), column('Checked', 'last_checked')],
      sort: [{ path: field('cluster_name'), direction: 'desc' }, { path: field('monthly_search_volume'), direction: 'desc' }],
      filter: { rules: [{ path: field('cluster_name'), operator: 'notIn', value: ['Automation platforms', 'Browser and AI automation', 'Invoice generator', 'general'] }] },
    },
    {
      id: 'low-cpc', name: 'Unique concepts below $5 CPC', path: '$.records',
      columns: [column('Cluster', 'cluster_name'), column('Keyword', 'keyword'), column('Volume', 'monthly_search_volume'), column('CPC', 'average_cpc_usd')],
      filter: { rules: [{ path: field('is_representative'), operator: 'eq', value: true }, { path: field('average_cpc_usd'), operator: 'lt', value: 5 }] },
    },
    {
      id: 'records', name: 'Records', path: '$.records',
      columns: [column('Keyword', 'keyword'), column('Cluster', 'cluster_name'), column('Path', 'path'), column('Volume', 'monthly_search_volume'), column('CPC', 'average_cpc_usd'), column('Competition', 'competition'), column('Checked', 'last_checked')],
    },
  ]
  return JSON.stringify({ $jsonviews: { version: 1, schema, views }, records }, null, 2)
}

const name = file ? basename(file) : `synthetic-${rows}`
const source = file ? readFileSync(file, 'utf8') : syntheticDocument(rows)
console.log(`${name}: ${(source.length / 1024 / 1024).toFixed(2)} MB, ${iterations} iterations (median / min, ms)`)

const results = []
function measure(label, run) {
  const times = []
  let result
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now()
    result = run()
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  results.push({ label, median, min: times[0] })
  console.log(`${label.padEnd(52)} ${median.toFixed(1).padStart(8)} ${times[0].toFixed(1).padStart(8)}`)
  return result
}

const sha = (text) => createHash('sha256').update(text).digest('hex')

measure('JSON.parse', () => JSON.parse(source))
// Alternating two spellings of the same document defeats the single-entry inspection cache.
const spellings = [source, `${source} `]
let turn = 0
measure('inspectJsonSource (cold)', () => core.inspectJsonSource(spellings[(turn += 1) % 2]))
const inspected = measure('inspectJsonSource (same text again)', () => core.inspectJsonSource(source))
const root = inspected.value
const compiled = measure('compileJsonViewMetadata', () => core.compileJsonViewMetadata(root))
measure('compileJsonViewMetadata (validateValues: false)', () => core.compileJsonViewMetadata(root, undefined, { validateValues: false }))
console.log(`  schema ${compiled.schema.length}, views ${compiled.views.length}, diagnostics ${compiled.diagnostics.length}, source diagnostics ${inspected.diagnostics.length}`)
const plain = root !== null && typeof root === 'object' && !Array.isArray(root)
  ? Object.fromEntries(Object.entries(root).filter(([key]) => key !== '$jsonviews'))
  : root
measure('inferJsonViewMetadata (no annotations)', () => core.inferJsonViewMetadata(plain))
measure('compileJsonViewMetadata (no annotations)', () => core.compileJsonViewMetadata(plain))

const viewDumps = {}
for (const view of compiled.views) {
  const viewRows = measure(`rows [${view.name}]`, () => core.applyJsonViewViewRows(root, view, compiled.schema))
  const projection = measure(`project [${view.name}] (${viewRows.length} rows)`, () => core.projectJsonViewCollection(root, view, compiled.schema))
  viewDumps[view.id] = { rows: viewRows.map((row) => row.sourcePath), columns: projection.columns.map((item) => ({ id: item.id, label: item.label, path: item.path.source })), records: projection.records }
}

const firstView = compiled.views[0]
const paths = firstView && Array.isArray(firstView.value) && firstView.value.length
  ? firstView.value.map((_, index) => [...firstView.sourcePath, index])
  : [[]]
const editPath = paths[Math.floor(paths.length / 2)]
measure(`jsonSourceRangesAtPaths (${paths.length} paths)`, () => core.jsonSourceRangesAtPaths(source, paths))
const replaced = measure('replaceJsonValueInSource (one value)', () => core.replaceJsonValueInSource(source, editPath, { replaced: true }))
// The root is the empty pointer; '/' would address a property named ''.
const pointer = editPath.length === 0 ? '' : '/' + editPath.map((segment) => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
const patched = measure('applyJsonPatchInSource (one replace op)', () => core.applyJsonPatchInSource(source, [{ op: 'replace', path: pointer, value: { patched: true } }]))
const formatted = measure('formatJsonSource', () => core.formatJsonSource(source))
const prefers = measure('prefersSource', () => core.prefersSource(source))

if (dumpDirectory) {
  mkdirSync(dumpDirectory, { recursive: true })
  const pathSource = (value) => (value && typeof value === 'object' && !Array.isArray(value) && 'segments' in value && 'source' in value ? value.source : value)
  const canonical = (value) => JSON.parse(JSON.stringify(value, (key, item) => pathSource(item)))
  const dump = {
    inspect: inspected.diagnostics.map(({ code, sourcePath, token, shadowed, start, end }) => ({ code, sourcePath, token, shadowed, start, end })),
    compile: {
      status: compiled.status, metadataSource: compiled.metadataSource, active: compiled.active, recognized: compiled.recognized,
      schema: canonical(compiled.schema),
      views: compiled.views.map(({ value: _value, ...view }) => canonical(view)),
      diagnostics: canonical(compiled.diagnostics),
    },
    views: viewDumps,
    edits: { replace: sha(replaced), patch: sha(patched), format: sha(formatted), prefersSource: prefers },
  }
  const target = `${dumpDirectory}/${name}.json`
  writeFileSync(target, JSON.stringify(dump, null, 1))
  console.log(`dumped ${target}`)
}
