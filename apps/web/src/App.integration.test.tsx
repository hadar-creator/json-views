import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from './App.js'
import * as browserWorkspace from './browser-workspace.js'
import { documentRouteHash } from './document-route.js'

if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  }) as DOMRectList
}
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}

let cleanup: (() => Promise<void>) | undefined

beforeEach(() => { vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] })) })

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const routeSource = JSON.stringify({
  $jsonviews: { version: 1, views: [
    { id: 'all', name: 'All tasks', path: '$.rows' },
    { id: 'board', name: 'Board / Ready', path: '$.rows', display: 'kanban', groupBy: '$.rows[*].status' },
  ] },
  rows: [{ name: 'A routed task', status: 'Ready' }],
})

async function mountNamedRoute(hash: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  history.replaceState(null, '', `/${hash}`)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
  vi.spyOn(browserWorkspace, 'readBrowserWorkspace').mockResolvedValue({
    version: 1, activeDocumentIndex: 0,
    documents: [
      { id: 'other', filename: 'other.json', content: '{}', initialContent: '{}' },
      { id: 'tasks', filename: 'tasks.json', relativePath: 'team/tasks.json', content: routeSource, initialContent: routeSource,
        mode: 'source', presentationState: { version: 1, activeView: 'view:all' } },
    ],
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  await act(async () => { root.render(<App />) })
  return container
}

function selectedTab(container: HTMLElement) {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent
}

it('opens the named file and view after restoration, and navigates the mounted viewer with Back/Forward', async () => {
  const hash = documentRouteHash({ file: 'team/tasks.json', view: 'Board / Ready' })
  const container = await mountNamedRoute(hash)
  expect(window.jsonViews!.list().find((item) => item.active)?.filename).toBe('tasks.json')
  expect(selectedTab(container)).toBe('Board / Ready')
  expect(container.querySelector('[data-id="jsonView-source-editor"]')).toBeNull()
  const source = window.jsonViews!.source('tasks')
  const boardUrl = window.jsonViews!.link('tasks', 'Board / Ready')
  const allUrl = window.jsonViews!.link('team/tasks.json', 'All tasks')
  expect(location.hash).toBe(hash)
  expect(selectedTab(container)).toBe('Board / Ready') // Producing a link is read-only.
  await act(async () => { location.hash = new URL(allUrl).hash; await new Promise((resolve) => setTimeout(resolve, 25)) })
  expect(selectedTab(container)).toBe('All tasks')
  await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 25)) })
  expect(location.href).toBe(boardUrl)
  expect(selectedTab(container)).toBe('Board / Ready')
  await act(async () => { history.forward(); await new Promise((resolve) => setTimeout(resolve, 25)) })
  expect(selectedTab(container)).toBe('All tasks')
  await act(async () => { window.jsonViews!.select('other.json') })
  expect(location.hash).toBe('#/files/other.json')
  await act(async () => { history.back(); await new Promise((resolve) => setTimeout(resolve, 25)) })
  expect(selectedTab(container)).toBe('All tasks')
  expect(window.jsonViews!.source('tasks')).toBe(source)
})

it('opens the leftmost view with a file-only URL and reports a missing view without selecting another tab', async () => {
  const container = await mountNamedRoute(documentRouteHash({ file: 'team/tasks.json' }))
  expect(selectedTab(container)).toBe('All tasks')
  await act(async () => { location.hash = documentRouteHash({ file: 'team/tasks.json', view: 'Missing' }); await new Promise((resolve) => setTimeout(resolve, 25)) })
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('View “Missing” was not found')
  expect(selectedTab(container)).toBe('All tasks')
  expect(location.hash).toContain('Missing')
})

it('reports a missing file after loading the workspace', async () => {
  const container = await mountNamedRoute('#/files/missing.json/views/Board')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('not available in this browser workspace')
  expect(window.jsonViews!.list().find((item) => item.active)?.filename).toBe('other.json')
})

it('flushes a pending viewer scroll into the browser workspace during pagehide', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  history.replaceState(null, '', '/')
  const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  await act(async () => { root.render(<App />) })
  const source = JSON.stringify({ rows: [{ name: 'Alpha' }], $jsonviews: { version: 1, views: [{ id: 'rows', path: '$.rows', name: 'Rows' }] } })
  const upload = container.querySelector('input[type=file]')!
  Object.defineProperty(upload, 'files', { value: [{ name: 'scroll.json', text: async () => source }], configurable: true })
  await act(async () => { upload.dispatchEvent(new Event('change', { bubbles: true })) })
  const scroll = container.querySelector('[data-id="tabular-data-frame"] > div') as HTMLDivElement
  await act(async () => {
    scroll.scrollLeft = 120
    scroll.scrollTop = 350
    scroll.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('pagehide'))
  })
  const cached = write.mock.calls.at(-1)![0].documents.find((document) => document.filename === 'scroll.json')
  expect(Object.values(cached?.presentationState?.tables ?? {})).toContainEqual(expect.objectContaining({ scrollLeft: 120, scrollTop: 350 }))
})

it('discards a failed visual draft on explicit reload and uses the latest local revision', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  history.replaceState(null, '', '/?token=integration')
  const response = (content: string, revision: string) => new Response(JSON.stringify({ filename: 'local.json', content, revision }))
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"name":"Alpha"}', 'r1'))
  vi.stubGlobal('fetch', fetchMock)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  await act(async () => { root.render(<App />) })
  await act(async () => { (container.querySelector('[aria-label="Edit Name"]') as HTMLElement).click() })
  const input = container.querySelector('input[aria-label="Edit Name"]') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'My draft')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  fetchMock.mockResolvedValueOnce(new Response('Conflict on disk', { status: 409 }))
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(container.textContent).toContain('Conflict on disk')
  fetchMock.mockResolvedValueOnce(response('{"name":"External"}', 'r2'))
  const reload = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Reload local file')!
  await act(async () => { reload.click() })
  expect(container.querySelector('input[aria-label="Edit Name"]')).toBeNull()
  expect(container.textContent).toContain('External')
  expect(container.textContent).not.toContain('My draft')
  expect(container.textContent).not.toContain('Conflict on disk')
  expect(container.textContent).toContain('Download previous draft')
})

it('renders the built viewer and retains source controls for malformed annotations', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  history.replaceState(null, '', '/')
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  await act(async () => { root.render(<App />) })
  expect(container.querySelector('button[data-id="jsonView-json-tab-source"]')).not.toBeNull()
  const source = '{"x":"value","$jsonviews":{"version":1,"schema":{"$.x":{"type":"select","options":{}}}}}'
  const upload = container.querySelector('input[type=file]')!
  Object.defineProperty(upload, 'files', { value: [{ name: 'annotations.json', text: async () => source }], configurable: true })
  await act(async () => { upload.dispatchEvent(new Event('change', { bubbles: true })) })
  const sourceButton = container.querySelector('button[data-id="jsonView-json-tab-source"]') as HTMLButtonElement
  expect(sourceButton).not.toBeNull()
  await act(async () => { sourceButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); sourceButton.click() })
  const editorDom = container.querySelector<HTMLElement>('[data-id="jsonView-source-editor"]')
  expect(editorDom?.querySelector('.cm-content')?.textContent).toBe(source)
  const hideSourceButton = container.querySelector('button[data-id="jsonView-json-tab-root"]') as HTMLButtonElement
  expect(sourceButton.getAttribute('aria-selected')).toBe('true')
  await act(async () => { hideSourceButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); hideSourceButton.click() })
  expect(container.querySelector('[data-id="jsonView-source-editor"]')).toBeNull()
  expect(container.querySelector('button[data-id="jsonView-json-tab-source"]')?.getAttribute('aria-selected')).toBe('false')
  expect(container.querySelector('.document-title strong')?.textContent).toBe('annotations.json')
})

async function mountStatusDocument(filename: string, source: string) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  history.replaceState(null, '', '/')
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup = async () => { await act(async () => root.unmount()); container.remove() }
  await act(async () => { root.render(<App />) })
  const upload = container.querySelector('input[type=file]')!
  Object.defineProperty(upload, 'files', { value: [{ name: filename, text: async () => source }], configurable: true })
  await act(async () => { upload.dispatchEvent(new Event('change', { bubbles: true })); })
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  return container
}
async function pressStatusButton(label: string) {
  const button = Array.from(document.querySelectorAll('button')).find((item) => item.getAttribute('aria-label') === label || item.textContent === label)
  expect(button, label).toBeDefined()
  await act(async () => { if (button!.getAttribute('role') === 'tab') button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); button!.click() })
}

it.each([
  ['people.json', '[{"name":"Ada"}]'],
  ['people.csv', 'name\r\nAda\r\n'],
  ['number.json', '9007199254740993'],
])('saves views through the viewer conversion control for %s', async (filename, source) => {
  vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
  const container = await mountStatusDocument(filename, source)
  const status = container.querySelector('[aria-label="Data is saved, views are not. Click to save."]')
  expect(container.querySelector('[data-id="jsonView-toolbar-actions"]')?.contains(status)).toBe(true)
  expect(container.querySelector('.document-title')?.contains(status)).toBe(false)
  await pressStatusButton('Data is saved, views are not. Click to save.')
  expect(container.querySelector('[data-jsonviews-metadata-persistence-dialog]')).not.toBeNull()
  await pressStatusButton('Cancel')
  expect(window.jsonViews!.source(filename)).toBe(source)
  await pressStatusButton('Data is saved, views are not. Click to save.')
  await pressStatusButton('Create JSON copy')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  const active = window.jsonViews!.list().find((item) => item.active)!
  const result = window.jsonViews!.source(active.id)
  expect(JSON.parse(result)).toHaveProperty('$jsonviews.version', 1)
  expect(window.jsonViews!.source(filename)).toBe(source)
  if (filename === 'number.json') expect(result).toContain('9007199254740993')
  expect(container.querySelector('[role="img"][aria-label="Data and views are saved."]')).not.toBeNull()
})

it('adds only annotations to an object root after explicit confirmation', async () => {
  vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
  const source = '{ "rows": [{"name":"Ada"}] }'
  const container = await mountStatusDocument('object.json', source)
  await pressStatusButton('Data is saved, views are not. Click to save.')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Adds a $jsonviews property')
  await pressStatusButton('Cancel')
  expect(window.jsonViews!.source('object.json')).toBe(source)
  await pressStatusButton('Data is saved, views are not. Click to save.')
  await pressStatusButton('Save views')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  const result = JSON.parse(window.jsonViews!.source('object.json'))
  expect(result.rows).toEqual([{ name: 'Ada' }])
  expect(Object.keys(result).sort()).toEqual(['$jsonviews', 'rows'])
  expect(container.querySelector('[role="img"][aria-label="Data and views are saved."]')).not.toBeNull()
})

it('keeps the viewer status honest when browser persistence fails', async () => {
  let reject!: (error: Error) => void
  vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockReturnValue(new Promise<Awaited<ReturnType<typeof browserWorkspace.writeBrowserWorkspace>>>((_, fail) => { reject = fail }))
  const container = await mountStatusDocument('pending.json', '{"name":"Ada"}')
  expect(container.querySelector('[role="img"][aria-label="Saving…"]')).not.toBeNull()
  await act(async () => { reject(new Error('Storage is full')) })
  expect(container.querySelector('button[aria-label="Changes are not saved. Click for details."]')).not.toBeNull()
  expect(container.querySelector('button[aria-label="Changes are not saved."]')).toBeNull()
})

it('does not show saving when only switching between views and source', async () => {
  const container = await mountStatusDocument('navigation.json', '{"name":"Ada"}')
  let release!: () => void
  vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation((workspace) => new Promise((resolve) => {
    release = () => resolve({ workspace, conflicts: [] })
  }))
  await pressStatusButton('Source')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  expect(container.querySelector('[role="img"][aria-label="Saving…"]')).toBeNull()
  expect(container.querySelector('[aria-label="Data is saved, views are not. Click to save."]')).not.toBeNull()
  await act(async () => { release() })
  await pressStatusButton('Table')
  await act(async () => { window.dispatchEvent(new Event('pagehide')) })
  expect(container.querySelector('[role="img"][aria-label="Saving…"]')).toBeNull()
  await act(async () => { release() })
})

it('parses a rewritten document a fixed number of times across the viewer, route, and API', async () => {
  await mountNamedRoute(documentRouteHash({ file: 'team/tasks.json', view: 'All tasks' }))
  const parse = vi.spyOn(JSON, 'parse')
  const parses = (source: string) => parse.mock.calls.filter(([input]) => input === source).length

  const rewritten = JSON.stringify({ ...JSON.parse(routeSource) as object, rows: [{ name: 'Rewritten task', status: 'Ready' }] })
  await act(async () => { await window.jsonViews!.setSource('tasks.json', rewritten) })
  // The viewer chooses its adapter, inspects the text, and reads the source
  // diagnostics; the route lists the views; the API result checks validity
  // and diagnostics; the host memoizes its parse error. Nothing else may
  // parse the whole document.
  expect(parses(rewritten)).toBe(7)

  await act(async () => { await window.jsonViews!.patch('tasks.json', [{ op: 'replace', path: '/rows/0/name', value: 'Patched task' }]) })
  const patched = window.jsonViews!.source('tasks.json')
  expect(patched).toContain('Patched task')
  expect(parses(patched)).toBe(7)
})
