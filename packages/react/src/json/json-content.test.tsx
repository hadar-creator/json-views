// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { act, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderComponent, type RenderResult } from '../test/render.js'
import { FileContentView } from '../file-content-view.js'
import { CSVContent, JSONContent } from './json-content.js'
import { sourceTargetDecorations } from './json-source-editor.js'
import type { FileContentData } from '../lib/file-data.js'
import { ValueCellContent } from '../tabular-data-view.js'
import type { JsonViewsPresentationState } from '../viewer-state.js'

let rendered: RenderResult | null = null

afterEach(async () => {
  await rendered?.cleanup()
  rendered = null
  localStorage.clear()
  vi.restoreAllMocks()
})

// Drive the JSON viewer through the public entry point, the way a host does —
// a `.json` path selects the renderer and the text arrives as base64. The
// Encode the same UTF-8 bytes the host sends in its real payload.
function jsonFile(content: string): FileContentData {
  const bytes = new TextEncoder().encode(content)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return { source: { base64: btoa(binary) }, mimeType: 'application/json' }
}

function csvFile(content: string): FileContentData {
  const bytes = new TextEncoder().encode(content)
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return { source: { base64: btoa(binary) }, mimeType: 'text/csv' }
}

function headerTexts(container: HTMLElement): string[] {
  const headers = Array.from(container.querySelectorAll('th:not([aria-hidden="true"])')).map((th) => th.textContent?.trim() ?? '')
  return headers.length > 0 ? headers : Array.from(container.querySelectorAll('dt')).map((term) => term.textContent?.trim() ?? '')
}

function nestedValueForKey(container: HTMLElement, key: string): Element | null {
  const row = Array.from(container.querySelectorAll('tbody tr'))
    .find((candidate) => candidate.querySelector('th')?.textContent?.trim() === key)
  if (row) return row.querySelector('[aria-label="Open nested value"]')
  const term = Array.from(container.querySelectorAll('dt')).find((candidate) => candidate.textContent?.trim() === key)
  return term?.nextElementSibling?.querySelector('[aria-label="Open nested value"]') ?? null
}

function sourceEditor(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>('[data-id="jsonView-source-editor"]')
  const view = dom ? EditorView.findFromDOM(dom) : null
  if (!view) throw new Error('Expected CodeMirror source editor')
  return view
}

function sourceTargets(container: HTMLElement): unknown[] {
  const view = sourceEditor(container)
  const source = view.state.doc.toString()
  const values: unknown[] = []
  view.state.field(sourceTargetDecorations).between(0, view.state.doc.length, (from, to) => {
    values.push(JSON.parse(source.slice(from, to)))
  })
  return values
}

function activeInput(container: HTMLElement, selector = 'input'): HTMLInputElement {
  const input = container.querySelector(
    `[data-id="jsonView-schema-editor"] ${selector}, [data-id="atomic-direct-editor"] ${selector}`,
  )
  if (!(input instanceof HTMLInputElement)) throw new Error('Expected an active input editor')
  return input
}

function giveVirtualTableAViewport(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    bottom: 600,
    height: 600,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
}

async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a clickable element')
  await act(async () => {
    if (element.getAttribute('role') === 'tab') element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.click()
    await Promise.resolve()
  })
}

async function settleViewSave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350))
  })
}

async function selectTab(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a tab')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    if (element.getAttribute('role') === 'tab') element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.click()
    await Promise.resolve()
  })
}

async function hover(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a hoverable element')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 800))
  })
}

async function openDropdown(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a dropdown trigger')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    if (element.getAttribute('role') === 'tab') element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.click()
    await Promise.resolve()
  })
}

async function openChoiceControl(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a choice trigger')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    await Promise.resolve()
  })
}

async function focus(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected a focusable element')
  await act(async () => {
    element.focus()
    await Promise.resolve()
  })
}

async function fillControl(control: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(control, value)
    control.dispatchEvent(new Event('change', { bubbles: true }))
    control.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function selectControl(control: Element | null, value: string): Promise<void> {
  await openChoiceControl(control)
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const option = Array.from(document.querySelectorAll('[data-id="pill-select-option"]'))
    .filter((item) => item.getAttribute('data-value') === value)
    .at(-1) ?? null
  await openDropdown(option)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await Promise.resolve()
  })
}

async function drag(source: Element | undefined, target: Element | undefined, duringDrag?: () => void, offsetY = 60): Promise<void> {
  if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
    throw new Error('Expected drag source and target')
  }
  if (source.matches('[data-id="jsonView-kanban-card"]')) giveKanbanAViewport(source.closest('[data-id="jsonView-kanban-layout"]')!)
  const values = new Map<string, string>()
  const dataTransfer = {
    effectAllowed: 'none',
    getData: (type: string) => values.get(type) ?? '',
    setData: (type: string, value: string) => values.set(type, value),
  }
  const bounds = target.getBoundingClientRect()
  const point = { clientX: bounds.left + 20, clientY: bounds.top + offsetY }
  await act(async () => {
    const sourceBounds = source.getBoundingClientRect()
    const start = new MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: sourceBounds.left + 20, clientY: sourceBounds.top + 20 })
    Object.defineProperty(start, 'dataTransfer', { value: dataTransfer })
    source.dispatchEvent(start)
    await Promise.resolve()
  })
  await act(async () => {
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true, ...point })
    Object.defineProperty(over, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(over)
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  duringDrag?.()
  await act(async () => {
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, ...point })
    Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer })
    target.dispatchEvent(drop)
    await Promise.resolve()
  })
}

function giveKanbanAViewport(container: HTMLElement): void {
  const board = container.querySelector<HTMLElement>('[data-id="jsonView-kanban"]')!
  vi.spyOn(board, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
  vi.spyOn(board, 'clientHeight', 'get').mockReturnValue(600)
  container.querySelectorAll<HTMLElement>('[data-id="jsonView-kanban-column"]').forEach((column, index) => {
    vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(index * 268, 12, 256, 400))
    vi.spyOn(column, 'offsetHeight', 'get').mockReturnValue(400)
    const list = column.querySelector<HTMLElement>('[data-id="jsonView-kanban-cards"]')!
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(index * 268 + 10, 44, 236, 350))
    column.querySelectorAll<HTMLElement>('[data-id="jsonView-kanban-card"]').forEach((card, row) => {
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(index * 268 + 10, 50 + row * 150, 236, 140))
    })
  })
}

function EditableJsonHarness({ content }: { content: string }) {
  const [source, setSource] = useState(content)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState(content)
  const [saved, setSaved] = useState('')
  const [commitCount, setCommitCount] = useState(0)

  return (
    <>
      <FileContentView
        path="/workspaces/demo/assets/editable.json"
        data={jsonFile(source)}
        edit={{
          isEditing,
          editContent,
          onEditChange: setEditContent,
          onCommitContent: async (nextContent) => {
            setSaved(nextContent)
            setSource(nextContent)
            setCommitCount((count) => count + 1)
          },
        }}
      />
      <pre data-id="edit-saved">{saved}</pre>
      <output data-id="edit-commit-count">{commitCount}</output>
      <button type="button" data-id="outside-focus">Outside control</button>
      <button type="button" data-id="start-raw-edit" onClick={() => { setEditContent(source); setIsEditing(true) }}>Raw edit</button>
      <button type="button" data-id="replace-source" onClick={() => setSource(JSON.stringify({ name: 'Root updated' }))}>Replace source</button>
    </>
  )
}

function RootShapeDraftHarness() {
  const content = JSON.stringify({ name: 'Object root' })
  const [editContent, setEditContent] = useState(content)
  return <>
    <JSONContent
      content={content}
      edit={{
        isEditing: true,
        editContent,
        onEditChange: setEditContent,
        onCommitContent: async () => undefined,
      }}
    />
    <button type="button" data-id="replace-draft-with-array" onClick={() => setEditContent(JSON.stringify([{ name: 'Array root' }]))}>Replace draft</button>
  </>
}

function ArrayConversionHarness({ content }: { content: string }) {
  const [converted, setConverted] = useState('')
  const [requests, setRequests] = useState(0)
  const [commits, setCommits] = useState(0)
  return <>
    <JSONContent
      metadataPersistence="inferred"
      content={content}
      path="array.json"
      onRequestMetadataPersistence={(request) => {
        setConverted(request.convertedSource)
        setRequests((count) => count + 1)
        return false
      }}
      edit={{
        isEditing: false, editContent: content, onEditChange: () => undefined,
        onCommitContent: async () => { setCommits((count) => count + 1) },
      }}
    />
    <pre data-id="conversion-source">{converted}</pre>
    <output data-id="conversion-requests">{requests}</output>
    <output data-id="conversion-commits">{commits}</output>
  </>
}

function CsvConversionHarness({ content }: { content: string }) {
  const [converted, setConverted] = useState('')
  const [requests, setRequests] = useState(0)
  const [commits, setCommits] = useState(0)
  return <>
    <CSVContent
      metadataPersistence="inferred"
      content={content}
      path="people.csv"
      onRequestMetadataPersistence={(request) => {
        setConverted(request.convertedSource)
        setRequests((count) => count + 1)
        return false
      }}
      edit={{
        isEditing: false, editContent: content, onEditChange: () => undefined,
        onCommitContent: async () => { setCommits((count) => count + 1) },
      }}
    />
    <pre data-id="conversion-source">{converted}</pre>
    <output data-id="conversion-requests">{requests}</output>
    <output data-id="conversion-commits">{commits}</output>
  </>
}

function CachedExplicitViewHarness() {
  const [active, setActive] = useState<'array' | 'other'>('array')
  const [cache, setCache] = useState<Record<string, JsonViewsPresentationState>>({})
  const content = active === 'array'
    ? '[{"name":"Ada","status":"New","score":92},{"name":"Grace","status":"Done","score":84},{"name":"Katherine","status":"New","score":90}]'
    : '[{"label":"Other","value":1}]'
  return <>
    <button type="button" data-id="show-array" onClick={() => setActive('array')}>Array</button>
    <button type="button" data-id="show-other" onClick={() => setActive('other')}>Other</button>
    <JSONContent
      key={active}
      documentId={active}
      metadataPersistence="inferred"
      content={content}
      path={`${active}.json`}
      presentationState={cache[active]}
      onPresentationStateChange={(next) => setCache((current) => ({ ...current, [active]: next }))}
      onRequestMetadataPersistence={() => false}
      edit={{
        isEditing: false, editContent: content, onEditChange: () => undefined,
        onCommitContent: async () => undefined,
      }}
    />
    <output data-id="array-presentation-cache">{JSON.stringify(cache.array)}</output>
  </>
}

function EditableCsvHarness({ content }: { content: string }) {
  const [source, setSource] = useState(content)
  const [saved, setSaved] = useState('')
  return <>
    <FileContentView path="/workspaces/demo/assets/people.csv" data={csvFile(source)} edit={{
      isEditing: false, editContent: source, onEditChange: () => undefined,
      onCommitContent: async (next) => { setSaved(next); setSource(next) },
    }} />
    <pre data-id="csv-saved">{saved}</pre>
  </>
}

function OptimisticJsonHarness({
  content,
  onCommit,
}: {
  content: string
  onCommit: (nextContent: string) => Promise<void>
}) {
  return (
    <FileContentView
      path="/workspaces/demo/assets/optimistic.json"
      data={jsonFile(content)}
      edit={{
        isEditing: false,
        editContent: content,
        onEditChange: () => undefined,
        onCommitContent: onCommit,
      }}
    />
  )
}

function OptimisticJsonSourceHarness({
  content,
  onCommit,
}: {
  content: string
  onCommit: (nextContent: string) => Promise<void>
}) {
  const [source, setSource] = useState(content)
  return (
    <>
      <OptimisticJsonHarness content={source} onCommit={onCommit} />
      <button
        type="button"
        data-id="replace-optimistic-source"
        onClick={() => setSource(JSON.stringify({ name: 'Bob' }))}
      >
        Replace source
      </button>
    </>
  )
}

function deferredCommit() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function valueForKey(container: HTMLElement, key: string): string {
  const row = Array.from(container.querySelectorAll('tbody tr'))
    .find((candidate) => candidate.querySelector('th')?.textContent?.trim() === key)
  if (row) return row.querySelector('td')?.textContent?.trim() ?? ''
  const term = Array.from(container.querySelectorAll('dt')).find((candidate) => candidate.textContent?.trim() === key)
  return term?.nextElementSibling?.textContent?.trim() ?? ''
}

describe('JSON file view', () => {
  it('uses the Source tab instead of a duplicate source toggle', async () => {
    const content = JSON.stringify({
      rows: [{ name: 'Ada' }],
      $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows' }] },
    })
    rendered = await renderComponent(<JSONContent content={content} onSave={async () => undefined} />)

    const toolbar = rendered.container.querySelector('[data-id="json-viewer-toolbar"]')
    const customize = toolbar?.querySelector('[data-id="jsonView-edit-view"]')
    const source = toolbar?.querySelector('[data-id="jsonView-source-toggle"]')
    expect(customize).not.toBeNull()
    expect(source).toBeNull()
    expect(toolbar?.querySelector('[data-id="jsonView-json-tab-source"]')?.textContent).toBe('Source')
  })

  it('opens and saves source from inside an editable embedded frame', async () => {
    const original = '{"name":"Ada"}'
    const next = '{"name":"Grace"}'
    const save = vi.fn(async () => undefined)
    rendered = await renderComponent(<JSONContent content={original} edit={{
      isEditing: false,
      editContent: '',
      onEditChange: () => undefined,
      onCommitContent: save,
    }} />)

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    const sourceView = rendered.container.querySelector('[data-id="jsonView-source-view"]')
    const editor = sourceEditor(rendered.container)
    expect(rendered.container.querySelector('[aria-label="Format JSON"]')).not.toBeNull()
    expect(sourceView?.querySelector('[role="status"]')).toBeNull()
    expect(rendered.container.querySelector('[aria-label="Data is saved, views are not. Click to save."]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]')).not.toBeNull()
    expect(editor.state.doc.toString()).toBe(original)
    expect(editor.state.readOnly).toBe(false)
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]')?.getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: next } })
      await new Promise((resolve) => setTimeout(resolve, 325))
    })

    expect(save).toHaveBeenCalledOnce()
    expect(save.mock.calls[0][0]).toBe(next)
  })

  it('formats JSON inside the source panel without changing exact value tokens', async () => {
    const original = '{ "id":9007199254740993,"huge":1e400,"minusZero":-0,"x":1,"x":2 }\n'
    rendered = await renderComponent(<JSONContent content={original} onSave={async () => undefined} />)

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    await click(rendered.container.querySelector('[aria-label="Format JSON"]'))

    const source = sourceEditor(rendered.container).state.doc.toString()
    expect(source).toContain('9007199254740993')
    expect(source).toContain('1e400')
    expect(source).toContain('-0')
    expect(source).toContain('"x": 1,\n  "x": 2')
  })

  it('syntax highlights the exact editable JSON in CodeMirror', async () => {
    const source = '{"name":"Ada","count":42,"active":true,"empty":null}'
    rendered = await renderComponent(<JSONContent content={source} onSave={async () => undefined} />)

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    const editor = sourceEditor(rendered.container)
    expect(editor.state.doc.toString()).toBe(source)
    expect(editor.contentDOM.textContent).toBe(source)
    expect(editor.contentDOM.querySelectorAll('.cm-line span').length).toBeGreaterThan(0)
  })

  it('keeps syntax highlighting in the focused native editor', async () => {
    rendered = await renderComponent(<JSONContent content='{"name":"Ada"}' onSave={async () => undefined} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    const editor = sourceEditor(rendered.container)
    await act(async () => {
      editor.focus()
      await Promise.resolve()
    })

    expect(editor.hasFocus).toBe(true)
    expect(editor.contentDOM.textContent).toBe(editor.state.doc.toString())
    expect(editor.contentDOM.querySelectorAll('.cm-line span').length).toBeGreaterThan(0)
  })

  it('highlights the JSON range represented by the current table view', async () => {
    const tasks = [{ name: 'Ada' }, { name: 'Grace' }]
    const source = JSON.stringify({
      $jsonviews: { version: 1, schema: {}, views: [{ id: 'tasks', name: 'Tasks', path: '$.tasks' }] },
      tasks,
      archived: [{ name: 'Hidden' }],
    }, null, 2)
    rendered = await renderComponent(<JSONContent content={source} />)

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    expect(sourceTargets(rendered.container)).toEqual([tasks])

    await click(rendered.container.querySelector('[data-id="jsonView-source-view"]'))
    expect(sourceTargets(rendered.container)).toEqual([])
  })

  it('highlights the current record rather than its containing table', async () => {
    giveVirtualTableAViewport()
    const source = JSON.stringify({
      $jsonviews: { version: 1, schema: {}, views: [{ id: 'tasks', name: 'Tasks', path: '$.tasks' }] },
      tasks: [{ name: 'Ada', done: false }, { name: 'Grace', done: true }],
    }, null, 2)
    rendered = await renderComponent(<JSONContent content={source} />)

    await click(rendered.container.querySelector('[role="button"][aria-label="Open Ada"]'))
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    expect(sourceTargets(rendered.container)).toEqual([{ name: 'Ada', done: false }])
  })

  it.each(['table', 'kanban'])('highlights only filtered %s records in source order and scrolls to the first displayed match', async (display) => {
    const tasks = [
      { name: 'Ada', done: true, rank: 1, status: 'Later' },
      { name: 'Hidden', done: false, rank: 2, status: 'Active' },
      { name: 'Grace', done: true, rank: 3, status: 'Active' },
    ]
    const source = JSON.stringify({
      $jsonviews: { version: 1, views: [{
        id: 'tasks', name: 'Tasks', path: '$.tasks',
        ...(display === 'kanban'
          ? { display, groupBy: '$.tasks[*].status', groupOrder: ['Active', 'Later'] }
          : { sort: [{ path: '$.tasks[*].rank', direction: 'desc' }] }),
        filter: { rules: [{ path: '$.tasks[*].done', operator: 'eq', value: true }] },
      }] },
      tasks,
    }, null, 2)
    rendered = await renderComponent(<JSONContent content={source} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    expect(sourceTargets(rendered.container)).toEqual([tasks[0], tasks[2]])
    const editor = sourceEditor(rendered.container)
    expect(editor.state.doc.toString()).toBe(source)

    await click(editor.dom)
    expect(sourceTargets(rendered.container)).toEqual([])
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-tasks"]'))
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    expect(sourceTargets(rendered.container)).toEqual([tasks[0], tasks[2]])
  })

  it('highlights the filtered records after switching saved views', async () => {
    const tasks = [
      { name: 'Ada', done: false },
      { name: 'Grace', done: false },
      { name: 'Hidden', done: true },
    ]
    const source = JSON.stringify({
      $jsonviews: { version: 1, views: [
        { id: 'all', name: 'All', path: '$.tasks' },
        { id: 'open', name: 'Open', path: '$.tasks', filter: { rules: [{ path: '$.tasks[*].done', operator: 'eq', value: false }] } },
      ] },
      tasks,
    }, null, 2)
    rendered = await renderComponent(<JSONContent content={source} />)

    await selectTab(rendered.container.querySelector('[data-id="jsonView-json-tab-open"]'))
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    expect(sourceTargets(rendered.container)).toEqual(tasks.slice(0, 2))
  })

  it.each(['table', 'kanban'])('highlights search matches in a %s and leaves an empty result unhighlighted', async (display) => {
    const tasks = [{ name: 'Ada', status: 'Active' }, { name: 'Grace', status: 'Active' }]
    const source = JSON.stringify({
      $jsonviews: { version: 1, views: [{
        id: 'tasks', name: 'Tasks', path: '$.tasks',
        ...(display === 'kanban' ? { display, groupBy: '$.tasks[*].status' } : {}),
      }] }, tasks,
    })
    rendered = await renderComponent(<JSONContent content={source} presentationState={{ version: 1, queries: { 'view:tasks': 'Grace' } }} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    expect(sourceTargets(rendered.container)).toEqual([tasks[1]])
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-tasks"]'))
    await fillControl(rendered.container.querySelector('input[aria-label="Search rows"]') as HTMLInputElement, 'Nobody')
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    expect(sourceTargets(rendered.container)).toEqual([])
  })

  it.each(['table', 'kanban'])('leaves empty filtered %s results unhighlighted', async (display) => {
    const source = JSON.stringify({
      $jsonviews: { version: 1, views: [{
        id: 'tasks', name: 'Tasks', path: '$.tasks',
        ...(display === 'kanban' ? { display, groupBy: '$.tasks[*].status' } : {}),
        filter: { rules: [{ path: '$.tasks[*].name', operator: 'eq', value: 'Nobody' }] },
      }] }, tasks: [{ name: 'Ada', status: 'Active' }],
    })
    rendered = await renderComponent(<JSONContent content={source} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    expect(sourceTargets(rendered.container)).toEqual([])
  })

  it('highlights filtered rows after navigating to a natural-layout nested table', async () => {
    giveVirtualTableAViewport()
    const rows = [{ name: 'Ada', score: 1 }, { name: 'Grace', score: 2 }, { name: 'Katherine', score: 0 }]
    rendered = await renderComponent(<JSONContent content={JSON.stringify({ $jsonviews: { version: 1, views: [] }, rows })} />)
    await click(nestedValueForKey(rendered.container, 'rows'))
    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for score"]'))
    await click(document.querySelector('[data-id="tabular-filter-column"]'))
    await selectControl(document.querySelector('button[aria-label="Filter score condition"]'), 'gt')
    await fillControl(document.querySelector('input[aria-label="Filter score value"]') as HTMLInputElement, '1')
    await click(document.querySelector('[data-id="tabular-apply-filter"]'))
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    expect(sourceTargets(rendered.container)).toEqual([rows[1]])
  })

  it('shows source in read-only embeds without offering source edits', async () => {
    rendered = await renderComponent(<JSONContent content='{"name":"Ada"}' />)

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    expect(sourceEditor(rendered.container).state.readOnly).toBe(true)
    expect(rendered.container.querySelector('[role="status"]')).toBeNull()
  })

  it('uses theme-aware foreground colors for scalar table values', async () => {
    rendered = await renderComponent(<ValueCellContent value="Visible in dark mode" onOpen={() => undefined} />)

    const value = rendered.container.querySelector('[title="Visible in dark mode"]')
    expect(value?.classList.contains('text-foreground')).toBe(true)
    expect(value?.classList.contains('text-stone-900')).toBe(false)
  })

  it('can remove an optional date property when Clear is configured to remove', async () => {
    const source = JSON.stringify({
      $jsonviews: {
        version: 1,
        schema: { '$.due': { type: 'date', title: 'Due' } },
      },
      due: '2026-09-04',
    }, null, 2)
    const save = vi.fn(async () => undefined)
    rendered = await renderComponent(
      <JSONContent
        content={source}
        clearBehavior="remove"
        edit={{
          isEditing: false,
          editContent: source,
          onEditChange: () => undefined,
          onCommitContent: save,
        }}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit Due"]'))
    const clear = document.querySelector('[data-id="date-editor-clear"]')
    await click(clear)

    expect(save).toHaveBeenCalledOnce()
    expect(JSON.parse(save.mock.calls[0][0])).toEqual({
      $jsonviews: {
        version: 1,
        schema: { '$.due': { type: 'date', title: 'Due' } },
      },
    })
  })
  it('renders a key→object map as a flat table with a key column', async () => {
    const content = JSON.stringify({
      'document workflow automation': { keyword: 'document workflow automation', slug: 'doc-wf', rank: 268 },
      'invoice processing': { keyword: 'invoice processing', slug: 'invoice', rank: 12 },
      'data entry': { keyword: 'data entry', slug: 'data', rank: 45 },
    })

    rendered = await renderComponent(
      <FileContentView path="/workspaces/demo/assets/keywords.json" data={jsonFile(content)} />,
    )

    // The nested fields surface as column headers — only the flattened table
    // does this; the key/value view would keep them nested out of sight.
    const headers = headerTexts(rendered.container)
    expect(headers).toContain('key')
    expect(headers).toContain('keyword')
    expect(headers).toContain('slug')

    // The row-count footer is unique to the tabular view.
    expect(rendered.container.textContent).toMatch(/3\s+rows/)
  })

  it('deletes a keyed row by source identity', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      zulu: { name: 'Zulu', rank: 2 },
      alpha: { name: 'Alpha', rank: 1 },
      bravo: { name: 'Bravo', rank: 3 },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for name"]'))
    expect(document.querySelector('[data-id="tabular-sort-ascending"]')).toBeNull()
    await click(document.querySelector('[data-id="tabular-sort-column"]'))
    await click(document.querySelector('[data-id="tabular-sort-ascending"]'))
    const alphaRow = Array.from(rendered.container.querySelectorAll('tbody tr'))
      .find((row) => row.textContent?.includes('Alpha'))
    // Checkbox selection is the only deletion affordance — no per-row trash
    // column duplicates it.
    expect(rendered.container.querySelector('[data-id="tabular-row-actions"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="structured-data-delete-row"]')).toBeNull()
    await click(alphaRow?.querySelector('[data-id="tabular-row-select"] [role="checkbox"]') ?? null)

    const selectionBar = rendered.container.querySelector('[data-id="tabular-selection-bar"]')
    expect(selectionBar?.textContent).toContain('1 selected')
    await click(selectionBar?.querySelector('[data-id="structured-data-delete-selected-rows"]') ?? null)

    const dialogHost = rendered.container.querySelector('[data-id="tabular-data-dialog-host"]')
    const tableFrame = dialogHost?.querySelector('[data-id="tabular-data-frame"]')
    expect(dialogHost?.classList.contains('overflow-hidden')).toBe(false)
    expect(tableFrame?.classList.contains('overflow-hidden')).toBe(true)
    expect(tableFrame?.querySelector('[role="dialog"]')).toBeNull()
    expect(dialogHost?.querySelector('[role="dialog"]')?.textContent).toContain('Delete 1 row?')
    expect(dialogHost?.querySelector('[role="dialog"]')?.textContent).toContain('This action cannot be undone.')
    expect(dialogHost?.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull()
    await click(dialogHost?.querySelector('[data-id="structured-data-confirm-delete-selected-rows"]') ?? null)

    expect(JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}'))
      .toEqual({ zulu: { name: 'Zulu', rank: 2 }, bravo: { name: 'Bravo', rank: 3 } })
    expect(rendered.container.textContent).not.toContain('Alpha')
  })

  it('deletes the selected rows as one commit', async () => {
    giveVirtualTableAViewport()
    // Source order differs from the sorted display, so the assertion pins the
    // display-row → source-row mapping as well as the batch semantics.
    const content = JSON.stringify([
      { name: 'Charlie', rank: 3 },
      { name: 'Alpha', rank: 1 },
      { name: 'Bravo', rank: 2 },
    ])
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for name"]'))
    await click(document.querySelector('[data-id="tabular-sort-column"]'))
    await click(document.querySelector('[data-id="tabular-sort-ascending"]'))
    const rowFor = (name: string) => Array.from(rendered?.container.querySelectorAll('tbody tr') ?? [])
      .find((row) => row.textContent?.includes(name))
    await click(rowFor('Alpha')?.querySelector('[data-id="tabular-row-select"] [role="checkbox"]') ?? null)
    await click(rowFor('Charlie')?.querySelector('[data-id="tabular-row-select"] [role="checkbox"]') ?? null)

    const selectionBar = rendered.container.querySelector('[data-id="tabular-selection-bar"]')
    expect(selectionBar?.textContent).toContain('2 selected')
    expect(rendered.container.querySelector('[data-id="tabular-add-row"]')).toBeNull()
    expect(Array.from(selectionBar?.querySelectorAll('button') ?? []).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Clear 2 selected rows', 'Delete 2 rows', 'Copy paths'])
    const deleteRows = selectionBar?.querySelector('[data-id="structured-data-delete-selected-rows"]')
    expect(deleteRows?.textContent).toBe('')
    expect(deleteRows?.classList.contains('text-destructive')).toBe(true)
    await click(deleteRows ?? null)

    const dialogHost = rendered.container.querySelector('[data-id="tabular-data-dialog-host"]')
    expect(dialogHost?.querySelector('[role="dialog"]')?.textContent).toContain('Delete 2 rows?')
    await click(dialogHost?.querySelector('[data-id="structured-data-confirm-delete-selected-rows"]') ?? null)

    expect(JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '[]'))
      .toEqual([{ name: 'Bravo', rank: 2 }])
    // The batch lands as a single write — one commit, one conflict window.
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
    expect(rendered.container.querySelector('[data-id="tabular-selection-bar"]')).toBeNull()
  })

  it('adds a schema-shaped row to an array-backed table and opens it', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ id: 'contact-1', name: 'Ada', score: 12, active: true, status: 'new', tags: ['team'], due: '2026-09-04' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].id': { type: 'text', required: true },
          '$.rows[*].name': { type: 'text', required: true },
          '$.rows[*].score': { type: 'number', minimum: 10 },
          '$.rows[*].active': { type: 'checkbox' },
          '$.rows[*].status': { type: 'select', options: ['new', 'done'] },
          '$.rows[*].tags': { type: 'multi-select', options: ['team'] },
          '$.rows[*].due': { type: 'date' },
        },
        views: [{ id: 'rows', name: 'Rows', path: '$.rows' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const addRow = rendered.container.querySelector('[data-id="tabular-add-row"]')
    expect(addRow?.parentElement?.firstElementChild).toBe(addRow)
    expect(addRow?.parentElement?.lastElementChild?.textContent).toContain('1 row')
    await click(rendered.container.querySelector('[data-id="tabular-add-row"]'))

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.rows[1]).toEqual({ id: '', name: '', score: 10, active: false, status: null, tags: [], due: null })
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-diagnostics"]')).toBeNull()
    expect(rendered.container.textContent).not.toContain('Enter a valid date')
  })

  it.each([['text', ''], ['markdown', ''], ['number', 0], ['checkbox', false], ['date', null], ['select', null], ['multi-select', []]].flatMap(([type, initialValue]) => [undefined, [], [{ label: 'Name', path: '$.rows[*].name' }]].map((columns) => ({ type, initialValue, columns }))))('adds a $type property through pointer selection with columns=$columns', async ({ type, initialValue, columns }) => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ name: '' }, { name: '' }, { name: '' }],
      $jsonviews: {
        version: 1,
        schema: { '$.rows[*].name': { type: 'text', title: 'Name' } },
        views: [{ id: 'table', name: 'Table', path: '$.rows', columns }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="tabular-add-column"]'))
    const form = document.querySelector('form[aria-label="Add property"]')
    const name = form?.querySelector('input')
    if (!(name instanceof HTMLInputElement)) throw new Error('Expected a property name input')
    await fillControl(name, 'Estimate')
    await openChoiceControl(form?.querySelector('button[aria-label="Property type"]') ?? null)
    const option = document.querySelector(`[data-id="pill-select-option"][data-value="${type}"]`)
    if (!(option instanceof HTMLElement)) throw new Error('Expected type option')
    await act(async () => {
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    })
    expect(form?.isConnected).toBe(true)
    await click(option)
    await click(form?.querySelector('button[type="submit"]') ?? null)

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.rows).toEqual(Array.from({ length: 3 }, () => ({ name: '', estimate: initialValue })))
    expect(saved.$jsonviews.schema['$.rows[*].estimate']).toEqual({ type, title: 'Estimate', ...(['select', 'multi-select'].includes(type as string) ? { options: [] } : {}) })
    expect(saved.$jsonviews.views[0].columns.at(-1)).toEqual({ label: 'Estimate', path: '$.rows[*].estimate' })
    expect(rendered.container.querySelector(`button[aria-label="Column options for ${columns?.length ? 'Name' : 'name'}"]`)).not.toBeNull()
    expect(rendered.container.querySelector('button[aria-label="Column options for Estimate"]')).not.toBeNull()
  })

  it('deletes a property from every row and removes its metadata references', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ name: 'One', done: false }, { name: 'Two', done: true }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.rows[*].name': { type: 'text', title: 'Name' },
          '$.rows[*].done': { type: 'checkbox', title: 'Done' },
        },
        views: [{
          id: 'table', name: 'Table', path: '$.rows',
          columns: [
            { label: 'Name', path: '$.rows[*].name' },
            { label: 'Done', path: '$.rows[*].done' },
          ],
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for Done"]'))
    await click(document.querySelector('[data-id="tabular-delete-column"]'))
    expect(document.querySelector('[data-id="tabular-confirm-delete-column"]')?.parentElement?.parentElement?.textContent).toContain('Delete Done from every row?')
    await click(document.querySelector('[data-id="tabular-confirm-delete-column"]'))

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.rows).toEqual([{ name: 'One' }, { name: 'Two' }])
    expect(saved.$jsonviews.schema).not.toHaveProperty('$.rows[*].done')
    expect(saved.$jsonviews.views[0].columns).toEqual([{ label: 'Name', path: '$.rows[*].name' }])
    expect(rendered.container.querySelector('button[aria-label="Column options for Done"]')).toBeNull()
  })

  it('toggles every row from the header checkbox', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify([{ name: 'Alpha' }, { name: 'Bravo' }])
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    expect(rendered.container.querySelectorAll('thead tr:last-child th')).toHaveLength(1)
    expect(rendered.container.querySelectorAll('tbody tr:not([aria-hidden])')[0]?.querySelectorAll('td')).toHaveLength(1)
    expect(rendered.container.querySelector('[data-id="tabular-select-all-gutter"]')).toBeNull()
    expect(rendered.container.querySelector('th [data-id="tabular-select-all-slot"]')).not.toBeNull()
    await click(rendered.container.querySelector('[data-id="tabular-select-all-rows"]'))
    expect(rendered.container.querySelector('[data-id="tabular-selection-bar"]')?.textContent)
      .toContain('2 selected')
    await click(rendered.container.querySelector('[data-id="tabular-select-all-rows"]'))
    expect(rendered.container.querySelector('[data-id="tabular-selection-bar"]')).toBeNull()
  })

  it('keeps the selection slot separate from record actions and clears selection mode without opening a record', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({ rows: [{ name: 'Alpha' }, { name: 'Bravo' }], $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows', columns: [{ label: 'Name', path: '$.rows[*].name' }] }] } })} />)
    const table = rendered.container.querySelector('table')!
    const rows = Array.from(table.querySelectorAll('tbody tr[data-index]'))
    const slots = rows.map((row) => row.querySelector('[data-id="tabular-row-select"]')!)
    const icons = slots.map((slot) => slot.querySelector('[data-id="jsonView-row-page-icon"]'))
    const checkboxes = slots.map((slot) => slot.querySelector<HTMLButtonElement>('[role="checkbox"]')!)
    expect(icons.every(Boolean)).toBe(true)
    expect(checkboxes.every((checkbox) => checkbox.tabIndex === 0)).toBe(true)
    // Selection is a sibling of the record-opening button, so both have
    // separate accessible names and keyboard activation.
    expect(slots.every((slot) => slot.closest('[role="button"]') === null)).toBe(true)
    expect(table.getAttribute('data-selection-active')).toBe('false')

    await focus(checkboxes[0])
    expect(document.activeElement).toBe(checkboxes[0])
    await pressKey(checkboxes[0], ' ')
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).toBeNull()
    // jsdom does not synthesize a native button click on Space keyup.
    await click(checkboxes[0])
    expect(document.activeElement).toBe(checkboxes[0])
    expect(table.getAttribute('data-selection-active')).toBe('true')
    expect(rows[0].getAttribute('aria-selected')).toBe('true')
    expect(checkboxes[0].getAttribute('aria-checked')).toBe('true')
    expect(checkboxes[1].getAttribute('aria-checked')).toBe('false')
    expect(table.querySelector('[data-id="tabular-select-all-rows"]')?.getAttribute('aria-checked')).toBe('mixed')
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).toBeNull()

    await click(checkboxes[1])
    expect(table.querySelector('[data-id="tabular-select-all-rows"]')?.getAttribute('aria-checked')).toBe('true')
    await click(rendered.container.querySelector('[data-id="tabular-clear-selection"]'))
    expect(table.getAttribute('data-selection-active')).toBe('false')
    expect(checkboxes.every((checkbox) => checkbox.getAttribute('aria-checked') === 'false')).toBe(true)
    expect(slots.map((slot) => slot.querySelector('[data-id="jsonView-row-page-icon"]'))).toEqual(icons)
    // One data column plus the explicit view's add-property column; selection has no extra cell.
    expect(rows.every((row) => row.querySelectorAll('td').length === 2)).toBe(true)

    await focus(rendered.container.querySelector('[aria-label="Open Alpha"]'))
    await pressKey(document.activeElement as HTMLElement, 'Enter')
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
  })

  it('keeps selection available when a row is missing its title field', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({
      rows: [{ name: 'Alpha', rank: 1 }, { rank: 2 }],
      $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows', columns: [{ label: 'Name', path: '$.rows[*].name' }, { label: 'Rank', path: '$.rows[*].rank' }] }] },
    })} />)
    const checkboxes = rendered.container.querySelectorAll('[data-id="tabular-row-select"] [role="checkbox"]')
    expect(checkboxes).toHaveLength(2)
    await click(checkboxes[1])
    expect(rendered.container.querySelector('[data-id="tabular-selection-bar"]')?.textContent).toContain('1 selected')
    await click(rendered.container.querySelector('[aria-label="Open Untitled"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
  })

  it('keeps selection separate from the identifying first column', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({
      rows: [{ name: 'Alpha', id: 'row-1' }],
      $jsonviews: { version: 1, views: [{
        id: 'rows', name: 'Rows', path: '$.rows',
        columns: [{ label: 'ID', path: '$.rows[*].id' }],
      }] },
    })} />)

    const checkbox = rendered.container.querySelector('[data-id="tabular-row-select"] [role="checkbox"]')
    expect(checkbox?.closest('td')?.querySelector('[aria-label="Open row-1"]')).not.toBeNull()

    await click(checkbox)
    expect(rendered.container.querySelector('[data-id="tabular-selection-bar"]')?.textContent).toContain('1 selected')
    expect(rendered.container.querySelector('[data-id="atomic-direct-editor"]')).toBeNull()
  })

  it('disables row and header selection during a save', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<JSONContent content={JSON.stringify([{ name: 'Alpha' }, { name: 'Beta' }])} isSaving onSave={async () => undefined} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))
    const checkboxes = rendered.container.querySelectorAll<HTMLButtonElement>('[data-id="tabular-row-select"] [role="checkbox"], [data-id="tabular-select-all-rows"]')
    expect(checkboxes).toHaveLength(3)
    for (const checkbox of checkboxes) {
      expect(checkbox.disabled).toBe(true)
      await click(checkbox)
    }
    expect(rendered.container.querySelector('table')?.getAttribute('data-selection-active')).toBe('false')
  })

  it('copies row paths first and offers full records as the alternate copy format', async () => {
    giveVirtualTableAViewport()
    const previousClipboard = navigator.clipboard
    const writeText = vi.fn(async (_value: string) => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const content = '{"rows":[{"name":"Zulu","rank":2,"detail":"Hidden Z"},{"name":"Alpha","rank":1,"id":9007199254740993,"detail":"Hidden A"}],"$jsonviews":{"version":1,"views":[{"id":"rows","name":"Rows","path":"$.rows","columns":[{"label":"Name","path":"$.rows[*].name"},{"label":"Rank","path":"$.rows[*].rank"}],"sort":[{"path":"$.rows[*].name","direction":"asc"}]}]}}'

    try {
      rendered = await renderComponent(
        <FileContentView path="/workspaces/demo/assets/readonly.json" data={jsonFile(content)} />,
      )

      const rowFor = (name: string) => Array.from(rendered?.container.querySelectorAll('tbody tr') ?? [])
        .find((row) => row.textContent?.includes(name))
      await click(rowFor('Zulu')?.querySelector('[data-id="tabular-row-select"] [role="checkbox"]') ?? null)
      await click(rowFor('Alpha')?.querySelector('[data-id="tabular-row-select"] [role="checkbox"]') ?? null)
      const selectionBar = rendered.container.querySelector('[data-id="tabular-selection-bar"]')
      expect(selectionBar?.querySelector('[data-id="structured-data-delete-selected-rows"]')).toBeNull()
      const copyRows = selectionBar?.querySelector('[data-id="structured-data-copy-selected-rows"]')
      expect(copyRows?.getAttribute('aria-label')).toBe('Copy paths')
      expect(copyRows?.textContent).toBe('')
      await click(copyRows ?? null)

      expect(writeText).toHaveBeenLastCalledWith('["readonly.json#/rows/1","readonly.json#/rows/0"]')
      const rowCopyFormats = selectionBar?.querySelector('[data-id="structured-data-copy-selected-rows"]')
      expect(rowCopyFormats?.getAttribute('role')).toBe('group')
      expect(rowCopyFormats?.querySelector('[data-copy-format="path"]')?.getAttribute('aria-pressed')).toBe('true')
      expect(rowCopyFormats?.querySelector('[data-copy-format="path"]')?.textContent).toBe('Copiedpaths')
      expect(rowCopyFormats?.querySelector('[data-copy-format="record"]')?.textContent).toBe('Records')

      await click(rowCopyFormats?.querySelector('[data-copy-format="record"]') ?? null)
      expect(writeText).toHaveBeenLastCalledWith(`[
  {
    "name": "Alpha",
    "rank": 1,
    "id": 9007199254740993,
    "detail": "Hidden A"
  },
  {
    "name": "Zulu",
    "rank": 2,
    "detail": "Hidden Z"
  }
]`)
      expect(rowCopyFormats?.firstElementChild?.getAttribute('data-copy-format')).toBe('record')
      expect(rowCopyFormats?.querySelector('[data-copy-format="record"]')?.textContent).toBe('Copiedrecords')
      expect(rowCopyFormats?.querySelector('[data-copy-format="path"]')?.textContent).toBe('Paths')

      await click(selectionBar?.querySelector('[data-id="tabular-clear-selection"]') ?? null)
      await click(rendered.container.querySelector('[aria-label="Open Alpha"]'))
      const copyRecord = rendered.container.querySelector('[data-id="jsonView-copy-record"]')
      expect(copyRecord?.getAttribute('aria-label')).toBe('Copy path')
      expect(copyRecord?.textContent).toBe('')
      await click(copyRecord)

      expect(writeText).toHaveBeenLastCalledWith('readonly.json#/rows/1')
      const recordCopyFormats = rendered.container.querySelector('[data-id="jsonView-copy-record"]')
      expect(recordCopyFormats?.querySelector('[data-copy-format="path"]')?.textContent).toBe('Copiedpath')
      expect(recordCopyFormats?.querySelector('[data-copy-format="record"]')?.textContent).toBe('Record')

      await click(recordCopyFormats?.querySelector('[data-copy-format="record"]') ?? null)
      expect(writeText).toHaveBeenLastCalledWith(`{
  "name": "Alpha",
  "rank": 1,
  "id": 9007199254740993,
  "detail": "Hidden A"
}`)
      expect(recordCopyFormats?.firstElementChild?.getAttribute('data-copy-format')).toBe('record')
      expect(recordCopyFormats?.querySelector('[data-copy-format="record"]')?.textContent).toBe('Copiedrecord')
      expect(recordCopyFormats?.querySelector('[data-copy-format="path"]')?.textContent).toBe('Path')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
    }
  })

  it('keeps an ordinary object as a record of properties', async () => {
    const content = JSON.stringify({ name: 'Alice', role: 'admin', active: true })

    rendered = await renderComponent(
      <FileContentView path="/workspaces/demo/assets/config.json" data={jsonFile(content)} />,
    )

    // An object uses its selected title above the remaining properties.
    const headers = headerTexts(rendered.container)
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('Alice')
    expect(headers).toContain('Role')
    expect(headers).not.toContain('key')
    expect(rendered.container.textContent).not.toMatch(/\d+\s+rows/)
  })

  it('edits ordinary string, number, and boolean leaves without changing their types', async () => {
    rendered = await renderComponent(
      <EditableJsonHarness content={JSON.stringify({ name: 'Alice', count: 3, active: true })} />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const name = activeInput(rendered.container, 'input[type="text"]')
    await fillControl(name, 'Ada')
    await pressKey(name, 'Enter')

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit count"]'))
    const count = activeInput(rendered.container, 'input[inputmode="decimal"]')
    await fillControl(count, '4')
    await pressKey(count, 'Enter')

    await click(rendered.container.querySelector('[data-id="jsonView-checkbox-toggle"][aria-label="Uncheck active"]'))

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved).toEqual({ name: 'Ada', count: 4, active: false })
    expect(typeof saved.name).toBe('string')
    expect(typeof saved.count).toBe('number')
    expect(typeof saved.active).toBe('boolean')
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('3')
  })

  it('does not offer leaf editing for nulls or container values', async () => {
    rendered = await renderComponent(
      <EditableJsonHarness content={JSON.stringify({
        empty: null,
        details: { owner: 'Ada' },
        values: [1, 2],
        label: 'Editable',
      })} />,
    )
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit empty"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit details"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit values"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit label"]')).not.toBeNull()
  })

  it('uses the palette table-view glyph for collection cells', async () => {
    rendered = await renderComponent(
      <ValueCellContent value={[{ id: 'one' }]} onOpen={() => undefined} />,
    )

    const icon = rendered.container.querySelector('.lucide-table-2')
    expect(icon).not.toBeNull()
    expect(icon?.classList.contains('text-source-number')).toBe(true)
  })

  it('shows the parent view, row, and field as collection-detail breadcrumbs', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({
      rows: [{ name: 'Ada', skills: ['HTML', 'TypeScript'] }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'people',
          name: 'People',
          path: '$.rows',
          columns: [
            { label: 'Name', path: '$.rows[*].name' },
            { label: 'Skills', path: '$.rows[*].skills' },
          ],
        }],
      },
    })} />)

    const nestedCell = rendered.container.querySelector('tbody button[title="Expand value"]')
    expect([...rendered.container.querySelectorAll('tbody [data-id="option-pill"]')].map((pill) => pill.textContent)).toEqual(['HTML', 'TypeScript'])
    await click(nestedCell)

    const breadcrumb = rendered.container.querySelector('nav[aria-label="Breadcrumb"]')
    const back = breadcrumb?.querySelector('button')
    expect(breadcrumb?.querySelector('[data-id="jsonView-breadcrumb-path"]')?.textContent).toBe('People / Ada / Skills')
    expect(back?.getAttribute('aria-label')).toBe('Back to People table')
    expect(rendered.container.querySelector('.lucide-file')).toBeNull()
    const selection = rendered.container.querySelector('[data-id="tabular-row-select"]')
    expect(selection).not.toBeNull()
    expect(selection?.closest('.relative.h-full.pl-5')?.querySelector('[data-id="structured-value-cell"]')?.classList)
      .toContain('before:-left-5')

    await click(back ?? null)
    await click(rendered.container.querySelector('tbody button[title="Expand value"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-breadcrumb-path"]')?.textContent).toBe('People / Ada / Skills')
  })

  it('opens a nested object row from its title without entering title editing', async () => {
    giveVirtualTableAViewport()
    const parentLabel = 'Compare the three onboarding approaches in the attached notes.'
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({
      rows: [{
        name: parentLabel,
        attachments: [
          { id: 'file_onboarding_notes', file_name: 'onboarding-notes.md', purpose: 'context' },
          { id: 'file_plan', file_name: 'plan.md', purpose: 'plan' },
          { id: 'file_review', file_name: 'review.md', purpose: 'review' },
        ],
      }],
      $jsonviews: { version: 1, views: [{
        id: 'messages', name: 'Messages', path: '$.rows',
        columns: [
          { label: 'Name', path: '$.rows[*].name' },
          { label: 'Attachments', path: '$.rows[*].attachments' },
        ],
      }] },
    })} />)

    await click(rendered.container.querySelector('tbody [aria-label="Open nested value"]'))
    expect(rendered.container.querySelector('[aria-label="Open file_onboarding_notes"]')).not.toBeNull()
    const clippedParent = rendered.container.querySelector('[data-id="jsonView-breadcrumb-path"] [title]')
    expect(clippedParent?.textContent).toBe('Compare th…')
    expect(clippedParent?.getAttribute('title')).toBe(parentLabel)

    await click(rendered.container.querySelector('[aria-label="Open file_onboarding_notes"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('file_onboarding_notes')
    expect(Array.from(rendered.container.querySelectorAll('dt')).map((node) => node.querySelector('span')?.textContent ?? node.textContent)).toEqual(['file_name', 'purpose'])
    expect(rendered.container.querySelector('[data-id="atomic-direct-editor"]')).toBeNull()

    await click(rendered.container.querySelector('nav[aria-label="Breadcrumb"] button'))
    expect(rendered.container.querySelector('[aria-label="Open file_onboarding_notes"]')).not.toBeNull()
  })

  it('applies host table cell options to declared and general tables', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ name: 'Ada', notes: 'First line\nSecond line' }, { name: 'Grace', notes: 'Short' }],
      $jsonviews: { version: 1, views: [{
        id: 'people', name: 'People', path: '$.rows',
        columns: [
          { label: 'Name', path: '$.rows[*].name' },
          { label: 'Notes', path: '$.rows[*].notes' },
        ],
      }] },
    })
    rendered = await renderComponent(<JSONContent content={content} />)
    expect(rendered.container.querySelector('tbody [data-id="tabular-cell-content"]')?.hasAttribute('data-clamped')).toBe(true)
    await rendered.cleanup()

    rendered = await renderComponent(<JSONContent content={content} tableCells={{ overflow: 'grow' }} />)
    expect(rendered.container.querySelector('tbody [data-id="tabular-cell-content"]')).not.toBeNull()
    expect(rendered.container.querySelector('tbody [data-clamped]')).toBeNull()

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))
    await click(nestedValueForKey(rendered.container, 'rows'))
    expect(headerTexts(rendered.container)).toEqual(['name', 'notes'])
    expect(rendered.container.querySelector('tbody [data-id="tabular-cell-content"]')).not.toBeNull()
    expect(rendered.container.querySelector('tbody [data-clamped]')).toBeNull()
  })

  it('keeps a numeric id as the exact record title', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={'[{"id":9007199254740993,"count":1},{"id":2,"count":2},{"id":3,"count":3}]'} />)

    await click(rendered.container.querySelector('[aria-label="Open 9007199254740993"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('9007199254740993')
  })

  it.each([
    ['0', true],
    ['false', true],
    ['""', true],
    ['null', false],
  ])('renders a falsy JSON root (%s) and only edits supported leaves', async (content, editable) => {
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    expect(rendered.container.textContent).not.toContain('No viewable data')
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"]') !== null).toBe(editable)
  })

  it('accepts a valid source draft when its root changes from an object to an array', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<RootShapeDraftHarness />)

    await click(rendered.container.querySelector('[data-id="replace-draft-with-array"]'))

    expect(rendered.container.textContent).toContain('Array root')
    expect(rendered.container.textContent).not.toContain('Expected a non-array JSON root')
    expect(rendered.container.querySelector('[aria-label*="Invalid JSON"]')).toBeNull()
  })

  it('commits an unsaved leaf draft when focus moves outside the cell', async () => {
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({ name: 'Alice' })} />)

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const name = activeInput(rendered.container)
    await fillControl(name, 'Saved on blur')
    await focus(rendered.container.querySelector('[data-id="outside-focus"]'))

    expect(rendered.container.querySelector('[data-id="atomic-direct-editor"]')).toBeNull()
    expect(JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')).toEqual({
      name: 'Saved on blur',
    })
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
  })

  it('keeps the draft visible and disabled until persistence finishes', async () => {
    const pending = deferredCommit()
    rendered = await renderComponent(
      <OptimisticJsonHarness
        content={JSON.stringify({ name: 'Alice' })}
        onCommit={() => pending.promise}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const name = activeInput(rendered.container)
    await fillControl(name, 'Ada')
    await pressKey(name, 'Enter')

    expect(activeInput(rendered.container).value).toBe('Ada')
    expect(activeInput(rendered.container).disabled).toBe(true)

    await act(async () => pending.resolve())
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('Ada')
  })

  it('allows only one atomic save at a time', async () => {
    const pending = deferredCommit()
    const onCommit = vi.fn(() => pending.promise)
    rendered = await renderComponent(
      <OptimisticJsonHarness
        content={JSON.stringify({ name: 'Alice', city: 'London' })}
        onCommit={onCommit}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const name = activeInput(rendered.container)
    await fillControl(name, 'Ada')
    await pressKey(name, 'Enter')

    const cityEdit = rendered.container.querySelector<HTMLElement>(
      '[data-id="atomic-edit-value"][aria-label="Edit city"]',
    )
    expect(cityEdit?.getAttribute('aria-disabled')).toBe('true')
    expect(onCommit).toHaveBeenCalledOnce()

    await act(async () => pending.resolve())
    expect(cityEdit?.getAttribute('aria-disabled')).toBe('false')
  })

  it('retains the failed draft with a visible persistence error', async () => {
    const pending = deferredCommit()
    rendered = await renderComponent(
      <OptimisticJsonHarness
        content={JSON.stringify({ name: 'Alice' })}
        onCommit={() => pending.promise}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const name = activeInput(rendered.container)
    await fillControl(name, 'Ada')
    await pressKey(name, 'Enter')
    expect(activeInput(rendered.container).value).toBe('Ada')

    await act(async () => pending.reject(new Error('Save failed')))

    expect(activeInput(rendered.container).value).toBe('Ada')
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('Save failed')
  })

  it('retains a recoverable draft when source changes during persistence', async () => {
    const pending = deferredCommit()
    rendered = await renderComponent(
      <OptimisticJsonSourceHarness
        content={JSON.stringify({ name: 'Alice' })}
        onCommit={() => pending.promise}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const name = activeInput(rendered.container)
    await fillControl(name, 'Ada')
    await pressKey(name, 'Enter')
    await click(rendered.container.querySelector('[data-id="replace-optimistic-source"]'))

    expect(activeInput(rendered.container).value).toBe('Ada')
    await act(async () => pending.reject(new Error('Save failed')))
    expect(activeInput(rendered.container).value).toBe('Ada')
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('keeps an invalid number open when focus moves outside the cell', async () => {
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({ count: 3 })} />)

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit count"]'))
    const count = activeInput(rendered.container)
    await fillControl(count, 'not a number')
    await focus(rendered.container.querySelector('[data-id="outside-focus"]'))

    expect(rendered.container.querySelector('[data-id="jsonView-schema-editor"]')).not.toBeNull()
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe('Value must be a finite number')
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
  })

  it('returns to the root when an external update removes the open path', async () => {
    rendered = await renderComponent(
      <EditableJsonHarness content={JSON.stringify({ profile: { name: 'Ada' } })} />,
    )
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    await click(nestedValueForKey(rendered.container, 'profile'))
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]')).not.toBeNull()

    await click(rendered.container.querySelector('[data-id="replace-source"]'))


    expect(rendered.container.textContent).toContain('Root updated')
    expect(rendered.container.querySelector('button[title="Back"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]')).not.toBeNull()
  })

  it('commits edits to the currently navigated nested path only', async () => {
    rendered = await renderComponent(
      <EditableJsonHarness content={JSON.stringify({
        name: 'Root',
        profile: { name: 'Ada', stats: { count: 1 } },
      })} />,
    )
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    await click(nestedValueForKey(rendered.container, 'profile'))

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit name"]'))
    const nestedName = activeInput(rendered.container, 'input[type="text"]')
    await fillControl(nestedName, 'Grace')
    await pressKey(nestedName, 'Enter')

    await click(nestedValueForKey(rendered.container, 'stats'))

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit count"]'))
    const nestedCount = activeInput(rendered.container, 'input[inputmode="decimal"]')
    await fillControl(nestedCount, '2')
    await pressKey(nestedCount, 'Enter')

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved).toEqual({
      name: 'Root',
      profile: { name: 'Grace', stats: { count: 2 } },
    })
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('2')
  })

  it('edits a primitive array element at its exact index', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify([1, 2, 3])} />)

    const editValues = rendered.container.querySelectorAll('[data-id="atomic-edit-value"][aria-label="Edit Value"]')
    expect(editValues).toHaveLength(3)
    await click(editValues[1])
    const value = activeInput(rendered.container, 'input[inputmode="decimal"]')
    await fillControl(value, '20')
    await pressKey(value, 'Enter')

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? 'null')
    expect(saved).toEqual([1, 20, 3])
  })

  it('edits a generic record-table cell without changing a sibling row', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify([
      { name: 'Ada', rank: 1, value: 1 },
      { name: 'Grace', rank: 2, value: 'pending' },
      { name: 'Katherine', rank: 3, value: true },
    ])
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const adaRow = Array.from(rendered.container.querySelectorAll('tbody tr'))
      .find((row) => row.textContent?.includes('Ada'))
    await click(adaRow?.querySelector('[data-id="atomic-edit-value"][aria-label="Edit Value"]') ?? null)
    const value = activeInput(rendered.container, 'input[inputmode="decimal"]')
    await fillControl(value, '2')
    await pressKey(value, 'Enter')

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? 'null')
    expect(saved).toEqual([
      { name: 'Ada', rank: 1, value: 2 },
      { name: 'Grace', rank: 2, value: 'pending' },
      { name: 'Katherine', rank: 3, value: true },
    ])
  })

  it('renders a heterogeneous map as separate properties', async () => {
    const content = JSON.stringify({
      database: { host: 'db', port: 5432 },
      cache: { ttl: 60, size: 100 },
    })

    rendered = await renderComponent(
      <FileContentView path="/workspaces/demo/assets/settings.json" data={jsonFile(content)} />,
    )
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    // Section keys stay as row headers; the dissimilar sections are not forced
    // into a sparse table.
    const headers = headerTexts(rendered.container)
    expect(headers).toEqual(['database', 'cache'])
    expect(rendered.container.querySelector('table')).toBeNull()
    expect(rendered.container.textContent).toContain('host: db')
    expect(rendered.container.textContent).toContain('ttl: 60')
  })

  it('opens the first declared view and projects, filters, and sorts nested columns', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [
        { name: 'Low', score: 40, owner: { email: 'low@example.com' } },
        { name: 'Mid', score: 75, owner: { email: 'mid@example.com' } },
        { name: 'High', score: 95, owner: { email: 'high@example.com' } },
      ],
      $jsonviews: {
        version: 1,
        views: [
          {
            id: 'priority', name: 'Priority', path: '$.leads',
            columns: [
              { label: 'Lead', path: '$.leads[*].name' },
              { label: 'Owner email', path: '$.leads[*].owner.email' },
              { label: 'Score', path: '$.leads[*].score' },
            ],
            filter: { match: 'all', rules: [{ path: '$.leads[*].score', operator: 'gte', value: 70 }] },
            sort: [{ path: '$.leads[*].score', direction: 'desc' }],
          },
          { id: 'all', name: 'All leads', path: '$.leads' },
        ],
      },
    })
    rendered = await renderComponent(<FileContentView path="/workspaces/demo/assets/leads.json" data={jsonFile(content)} />)

    const tabs = Array.from(rendered.container.querySelectorAll('[role="tab"]'))
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Priority', 'All leads', 'Table', 'Source'])
    expect(tabs[0]?.getAttribute('data-state')).toBe('active')
    expect(rendered.container.querySelector('[data-id="json-viewer-toolbar"]')?.classList).toContain('flex-nowrap')
    expect(rendered.container.querySelector('[data-id="jsonView-view-controls"]')?.classList).toContain('flex-1')
    expect(rendered.container.querySelector('[data-id="jsonView-json-tabs"]')?.classList).toContain('overflow-x-auto')
    await hover(tabs[0] ?? null)
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('/leads')
    expect(headerTexts(rendered.container)).toEqual(expect.arrayContaining(['Lead', 'Owner email', 'Score']))
    const rows = Array.from(rendered.container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '')
    expect(rows.join(' ')).not.toContain('Low')
    expect(rows.findIndex((row) => row.includes('High'))).toBeLessThan(rows.findIndex((row) => row.includes('Mid')))
  })

  it('emits and restores visual state without changing JSON metadata', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ name: 'Alpha', score: 1 }, { name: 'Beta', score: 2 }],
      $jsonviews: {
        version: 1,
        views: [
          { id: 'names', name: 'Names', path: '$.rows' },
          { id: 'scores', name: 'Scores', path: '$.rows' },
        ],
      },
    })
    let cached: JsonViewsPresentationState | undefined
    rendered = await renderComponent(
      <JSONContent
        documentId="cached-document"
        path="cached.json"
        content={content}
        onPresentationStateChange={(state) => { cached = state }}
      />,
    )

    await selectTab(rendered.container.querySelector('[data-id="jsonView-json-tab-scores"]'))
    await click(rendered.container.querySelector('[data-id="jsonView-search-button"]'))
    const search = rendered.container.querySelector('input[aria-label="Search rows"]')
    if (!(search instanceof HTMLInputElement)) throw new Error('Expected search input')
    await fillControl(search, 'Beta')
    const resize = rendered.container.querySelector('[aria-label^="Resize "]')
    if (!(resize instanceof HTMLElement)) throw new Error('Expected resize handle')
    await act(async () => {
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
      await Promise.resolve()
    })

    expect(cached?.activeView).toBe('view:scores')
    expect(cached?.queries?.['view:scores']).toBe('Beta')
    expect(Object.values(cached?.tables ?? {}).some((state) => Object.values(state.columnWidths ?? {}).includes(250))).toBe(true)
    expect(content).not.toContain('presentationState')

    await rendered.cleanup()
    rendered = null
    rendered = await renderComponent(
      <JSONContent documentId="cached-document" path="cached.json" content={content} presentationState={cached} />,
    )

    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-scores"]')?.getAttribute('data-state')).toBe('active')
    expect((rendered.container.querySelector('input[aria-label="Search rows"]') as HTMLInputElement | null)?.value).toBe('Beta')
    expect(rendered.container.textContent).toContain('Beta')
    expect(rendered.container.textContent).not.toContain('Alpha')
    expect(rendered.container.querySelector('[aria-label^="Resize "]')?.getAttribute('aria-valuenow')).toBe('250')
  })

  it('confirms array conversion from the save indicator before requesting persistence', async () => {
    const onSave = vi.fn(async () => undefined)
    const onConversion = vi.fn(async (_request: { convertedSource: string }) => true)
    const records = [{ name: 'Ada' }]
    rendered = await renderComponent(<JSONContent content={JSON.stringify(records)} onSave={onSave} onRequestMetadataPersistence={onConversion} />)
    const indicator = () => rendered!.container.querySelector('button[aria-label="Data is saved, views are not. Click to save."]')
    await click(indicator())
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('data property')
    expect(onConversion).not.toHaveBeenCalled()
    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === 'Cancel') ?? null)
    expect(onConversion).not.toHaveBeenCalled()
    await click(indicator())
    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === 'Convert to object-root JSON') ?? null)
    expect(onConversion).toHaveBeenCalledOnce()
    const converted = JSON.parse(onConversion.mock.calls[0][0].convertedSource)
    expect(converted.data).toEqual(records)
    expect(converted.$jsonviews.version).toBe(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('keeps inferred view edits temporary until explicitly saved', async () => {
    giveVirtualTableAViewport()
    const contacts = [
      { name: 'Ada', status: 'New', score: 92, active: true, tags: ['Engineering'], due: '2026-09-12', email: 'ada@example.com' },
      { name: 'Grace', status: 'Customer', score: 84, active: false, tags: ['Product'], due: '2026-09-18', email: 'grace@example.com' },
    ]
    contacts.push(
      { ...contacts[0], name: 'Katherine', email: 'katherine@example.com' },
      { ...contacts[1], name: 'Dorothy', email: 'dorothy@example.com' },
    )
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({ contacts })} />)

    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-contacts"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-contacts-board"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-contacts"]')?.getAttribute('data-state')).toBe('active')
    await selectTab(rendered.container.querySelector('[data-id="jsonView-json-tab-contacts"]'))
    expect(headerTexts(rendered.container)).toEqual(expect.arrayContaining(['Name', 'Status', 'Score', 'Active', 'Tags', 'Due', 'Email']))
    expect(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent).toBe('')
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('[aria-label="Show Email"]'))
    expect(document.querySelector('[data-id="jsonView-save-view"]')).toBeNull()
    await settleViewSave()

    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
    await click(rendered.container.querySelector('[aria-label="Data is saved, views are not. Click to save."]'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Adds a $jsonviews property')
    await click(Array.from(document.querySelectorAll('[role="dialog"] button')).find((button) => button.textContent === 'Save views') ?? null)

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.contacts).toEqual(contacts)
    expect(saved.$jsonviews.schema).toMatchObject({
      '$.contacts[*].status': { type: 'select', options: ['New', 'Customer'] },
      '$.contacts[*].score': { type: 'number' },
      '$.contacts[*].active': { type: 'checkbox' },
      '$.contacts[*].tags': { type: 'multi-select' },
      '$.contacts[*].due': { type: 'date' },
      '$.contacts[*].email': { type: 'email' },
    })
    expect(saved.$jsonviews.views).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'contacts', path: '$.contacts' }),
      expect.objectContaining({ id: 'contacts-board', display: 'kanban', groupBy: '$.contacts[*].status' }),
    ]))
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
  })

  it('omits a declared view when one of its columns never resolves', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      articles: [{ competitor: 'n8n', title: 'Agent sandbox guide', url: 'https://example.com/article' }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'summary',
          name: 'Summary',
          path: '$.articles',
          columns: [
            { label: 'Competitor', path: '$.articles[*].competitor' },
            { label: 'Article count', path: '$.articles[*].article_count' },
          ],
        }],
      },
    })
    rendered = await renderComponent(<FileContentView path="/workspaces/demo/assets/summary.json" data={jsonFile(content)} />)

    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-summary"]')).toBeNull()
    expect(headerTexts(rendered.container)).toContain('articles')
    expect(headerTexts(rendered.container)).not.toContain('$jsonviews')
    expect(headerTexts(rendered.container)).not.toContain('Article count')
    await click(rendered.container.querySelector('[data-id="jsonView-json-diagnostics"] summary'))
    expect(rendered.container.querySelector('[data-id="jsonView-json-diagnostics"]')?.textContent).toContain('does not resolve on any record')
  })

  it('shows the exact source path for malformed non-empty formatted values', async () => {
    const content = JSON.stringify({
      articles: [{ source_url: 'web-search:site:relay.app/blog', published_date: null }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.articles[*].source_url': { type: 'url' },
          '$.articles[*].published_date': { type: 'date' },
        },
      },
    })
    rendered = await renderComponent(<FileContentView path="/workspaces/demo/assets/articles.json" data={jsonFile(content)} />)

    const diagnostics = rendered.container.querySelector('[data-id="jsonView-json-diagnostics"]')?.textContent ?? ''
    expect(diagnostics).toContain('$.articles[0].source_url')
    expect(diagnostics).not.toContain('$.articles[0].published_date')
  })

  it('groups repeated validation failures behind one minimal issue control', async () => {
    const content = JSON.stringify({
      articles: [{ url: 'not-one' }, { url: 'not-two' }],
      $jsonviews: {
        version: 1,
        schema: { '$.articles[*].url': { type: 'url' } },
      },
    })
    rendered = await renderComponent(<FileContentView path="/workspaces/demo/assets/articles.json" data={jsonFile(content)} />)

    const diagnostics = rendered.container.querySelector('[data-id="jsonView-json-diagnostics"]')
    expect(diagnostics?.querySelector('summary')?.getAttribute('aria-label')).toBe('1 JSON issue')
    expect(diagnostics?.textContent).toContain('Enter a valid web URL (2)')
  })

  it('uses the unified table UI without adding a duplicate inferred view for a root array', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(
      <FileContentView
        path="/workspaces/demo/assets/array.json"
        data={jsonFile(JSON.stringify([{ name: 'Ada', score: 1 }, { name: 'Grace', score: 2 }, { name: 'Katherine', score: 3 }]))}
      />,
    )

    expect(rendered.container.querySelectorAll('[data-id="jsonView-json-tabs"] [role="tab"]')).toHaveLength(2)
    expect(rendered.container.querySelector('[data-id="json-viewer-toolbar"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-search-button"]')).not.toBeNull()
    expect(rendered.container.querySelector('input[aria-label="Search rows"]')).toBeNull()
    expect(headerTexts(rendered.container)).toContain('name')
  })

  it('edits CSV cells through the shared table without reserializing unrelated bytes', async () => {
    giveVirtualTableAViewport()
    const source = 'id,name,note\r\n001,"Ada","hello, world"\r\n002,Grace,plain\r\n'
    rendered = await renderComponent(<EditableCsvHarness content={source} />)
    expect(rendered.container.querySelectorAll('[data-id="jsonView-json-tabs"] [role="tab"]')).toHaveLength(2)
    expect(rendered.container.querySelector('[data-id="jsonView-add-view"]')?.getAttribute('aria-disabled')).toBe('false')
    expect(rendered.container.querySelector('[data-id="jsonView-edit-view"]')).not.toBeNull()
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(document.querySelector('[data-id="jsonView-save-view"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-root-array-wrap-banner"]')).toBeNull()
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })) })
    expect(rendered.container.querySelector('[data-id="tabular-add-column"]')).toBeNull()
    const adaRow = Array.from(rendered.container.querySelectorAll('tbody tr')).find((row) => row.textContent?.includes('Ada'))
    await click(adaRow?.querySelector('[aria-label="Open Ada"]') ?? null)
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit Name"]'))
    const name = activeInput(rendered.container)
    await fillControl(name, 'Ana')
    await pressKey(name, 'Enter')
    expect(rendered.container.querySelector('[data-id="csv-saved"]')?.textContent)
      .toBe('id,name,note\r\n001,"Ana","hello, world"\r\n002,Grace,plain\r\n')
  })

  it('keeps CSV presentation changes local and requests conversion only when a view is saved', async () => {
    giveVirtualTableAViewport()
    const content = 'name,status\r\nGrace,Done\r\nAda,New\r\n'
    rendered = await renderComponent(<CsvConversionHarness content={content} />)

    expect(rendered.container.querySelector('[data-id="jsonView-add-view"]')?.getAttribute('aria-disabled')).toBe('false')
    expect(rendered.container.querySelector('[data-id="jsonView-search-button"]')).not.toBeNull()
    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for Name"]'))
    await click(document.querySelector('[data-id="tabular-sort-column"]'))
    await click(document.querySelector('[data-id="tabular-sort-ascending"]'))
    const rows = Array.from(rendered.container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '')
    expect(rows.findIndex((row) => row.includes('Ada'))).toBeLessThan(rows.findIndex((row) => row.includes('Grace')))
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('0')
    expect(rendered.container.querySelector('[data-id="conversion-commits"]')?.textContent).toBe('0')

    await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-root-array-wrap-banner"]')).toBeNull()
    await click(document.querySelector('[data-id="jsonView-new-kanban"]'))
    const groupBy = document.querySelector('button[aria-label="New view group by"]')
    if (!(groupBy instanceof HTMLButtonElement)) throw new Error('Expected a group-by control')
    await selectControl(groupBy, '$[*].status')
    await click(document.querySelector('[data-id="jsonView-create-view"]'))

    const convertedSource = rendered.container.querySelector('[data-id="conversion-source"]')?.textContent ?? ''
    const converted = JSON.parse(convertedSource)
    expect(converted.data).toEqual([{ name: 'Grace', status: 'Done' }, { name: 'Ada', status: 'New' }])
    expect(converted.$jsonviews.views).toEqual([
      expect.objectContaining({ id: 'data', name: 'Data', path: '$.data', display: 'kanban', groupBy: '$.data[*].status' }),
    ])
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('1')
    expect(rendered.container.querySelector('[data-id="conversion-commits"]')?.textContent).toBe('0')
  })

  it('previews CSV view options locally and converts only after Save view', async () => {
    giveVirtualTableAViewport()
    const content = 'name,status\r\nGrace,Done\r\nAda,New\r\n'
    rendered = await renderComponent(<CsvConversionHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-root-array-wrap-banner"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-save-view"]')?.textContent).toBe('Save view')
    await click(document.querySelector('[data-id="jsonView-add-sort"]'))

    const rows = Array.from(rendered.container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '')
    expect(rows.findIndex((row) => row.includes('Ada'))).toBeLessThan(rows.findIndex((row) => row.includes('Grace')))
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('0')

    await click(document.querySelector('[data-id="jsonView-save-view"]'))
    const converted = JSON.parse(rendered.container.querySelector('[data-id="conversion-source"]')?.textContent ?? '{}')
    expect(converted.data).toEqual([{ name: 'Grace', status: 'Done' }, { name: 'Ada', status: 'New' }])
    expect(converted.$jsonviews.views[0]).toMatchObject({ path: '$.data', sort: [{ path: '$.data[*].name', direction: 'asc' }] })
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('1')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Conversion cancelled')
  })

  it('requests conversion before saving a root-array view and keeps the original unchanged when cancelled', async () => {
    giveVirtualTableAViewport()
    const content = '[\n  {"name":"Ada","status":"New","unsafe":9007199254740993},\n  {"name":"Grace","status":"Done","unsafe":2}\n]\n'
    rendered = await renderComponent(<ArrayConversionHarness content={content} />)

    expect(rendered.container.querySelectorAll('[data-id="jsonView-json-tabs"] [role="tab"]')).toHaveLength(2)
    expect(rendered.container.querySelector('[data-id="jsonView-edit-view"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-root-array-wrap-banner"]')).toBeNull()
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-root-array-wrap-banner"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-save-view"]')?.textContent).toBe('Save view')
    await click(document.querySelector('[data-id="jsonView-layout-kanban"]'))
    const groupBy = document.querySelector('button[aria-label="Group by"]')
    if (!(groupBy instanceof HTMLButtonElement)) throw new Error('Expected a group-by control')
    await selectControl(groupBy, '$[*].status')
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('0')
    await click(document.querySelector('[data-id="jsonView-save-view"]'))

    const savedSource = rendered.container.querySelector('[data-id="conversion-source"]')?.textContent ?? ''
    expect(savedSource).toMatch(/"unsafe":\s*9007199254740993/)
    const saved = JSON.parse(savedSource)
    expect(saved.data).toEqual([
      { name: 'Ada', status: 'New', unsafe: 9007199254740992 },
      { name: 'Grace', status: 'Done', unsafe: 2 },
    ])
    expect(saved.$jsonviews.schema).toHaveProperty('$.data[*].name')
    expect(saved.$jsonviews.views).toEqual([
      expect.objectContaining({ id: 'data', name: 'Data', path: '$.data', display: 'kanban', groupBy: '$.data[*].status' }),
    ])
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('1')
    expect(rendered.container.querySelector('[data-id="conversion-commits"]')?.textContent).toBe('0')
    expect(document.querySelector('[data-id="view-settings"]')).not.toBeNull()
  })

  it('reorders root-array columns from their titles and waits for Save view before converting', async () => {
    giveVirtualTableAViewport()
    const content = '[{"name":"Ada","status":"New","score":92},{"name":"Grace","status":"Done","score":84},{"name":"Katherine","status":"New","score":90}]'
    rendered = await renderComponent(<ArrayConversionHarness content={content} />)

    const nameTitle = rendered.container.querySelector('button[aria-label="Column options for name"]')
    const scoreTitle = rendered.container.querySelector('button[aria-label="Column options for score"]')
    expect((scoreTitle as HTMLButtonElement | null)?.draggable).toBe(true)
    await drag(scoreTitle ?? undefined, nameTitle ?? undefined)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    const reordered = headerTexts(rendered.container)
    expect(reordered.indexOf('score')).toBeLessThan(reordered.indexOf('name'))
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('0')

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('[data-id="jsonView-save-view"]'))

    const converted = JSON.parse(rendered.container.querySelector('[data-id="conversion-source"]')?.textContent ?? '{}')
    expect(converted.data).toEqual(JSON.parse(content))
    expect(converted.$jsonviews.views[0].columns.map((column: { path: string }) => column.path)).toEqual([
      "$.data[*]['score']",
      "$.data[*]['name']",
      "$.data[*]['status']",
    ])
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('1')
    expect(rendered.container.querySelector('[data-id="conversion-commits"]')?.textContent).toBe('0')
  })

  it('reorders root-array Kanban columns locally and persists them only with Save view', async () => {
    const content = '[{"name":"Ada","status":"New"},{"name":"Grace","status":"Done"}]'
    rendered = await renderComponent(<ArrayConversionHarness content={content} />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('[data-id="jsonView-layout-kanban"]'))
    const groupBy = document.querySelector('button[aria-label="Group by"]')
    if (!(groupBy instanceof HTMLButtonElement)) throw new Error('Expected a group-by control')
    await selectControl(groupBy, '$[*].status')

    giveKanbanAViewport(rendered.container)
    const newHandle = rendered.container.querySelector('[aria-label="Reorder New column"]')
    const doneColumn = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]'))
      .find((column) => column.getAttribute('data-group-value') === 'Done')
    await drag(newHandle ?? undefined, doneColumn, () => {
      expect(rendered?.container.querySelector<HTMLElement>('[data-id="jsonView-kanban-column-drop-indicator"]')?.hidden).toBe(false)
      expect(newHandle?.closest('[data-id="jsonView-kanban-column"]')?.getAttribute('data-column-dragging')).toBe('true')
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]')).map((column) => column.getAttribute('data-group-value')))
      .toEqual(['New', 'Done'])
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('0')

    await click(document.querySelector('[data-id="jsonView-save-view"]'))
    const converted = JSON.parse(rendered.container.querySelector('[data-id="conversion-source"]')?.textContent ?? '{}')
    expect(converted.data).toEqual(JSON.parse(content))
    expect(converted.$jsonviews.views[0].groupOrder).toEqual(['New', 'Done'])
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('1')
  })

  it('restores an unsaved root-array view draft after switching documents', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<CachedExplicitViewHarness />)

    await drag(
      rendered.container.querySelector('button[aria-label="Column options for score"]') ?? undefined,
      rendered.container.querySelector('button[aria-label="Column options for name"]') ?? undefined,
    )
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('[data-id="jsonView-add-filter"]'))
    await click(document.querySelector('[data-id="jsonView-add-sort"]'))

    expect(headerTexts(rendered.container).indexOf('score')).toBeLessThan(headerTexts(rendered.container).indexOf('name'))
    expect(rendered.container.textContent).toContain('Ada')
    expect(rendered.container.textContent).not.toContain('Grace')
    expect(rendered.container.querySelector('[data-id="array-presentation-cache"]')?.textContent).toContain('viewDrafts')

    await click(rendered.container.querySelector('[data-id="show-other"]'))
    await click(rendered.container.querySelector('[data-id="show-array"]'))

    expect(headerTexts(rendered.container).indexOf('score')).toBeLessThan(headerTexts(rendered.container).indexOf('name'))
    expect(rendered.container.textContent).toContain('Ada')
    expect(rendered.container.textContent).not.toContain('Grace')
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(document.querySelector('button[aria-label="Filter 1 property"]')?.textContent).toContain('Name')
    expect(document.querySelector('button[aria-label="Sort 1 property"]')?.textContent).toContain('Name')
  })

  it('keeps an explicit filter draft when View options is dismissed', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<ArrayConversionHarness content='[{"name":"Ada","status":"New"},{"name":"Grace","status":"Done"}]' />)
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('[data-id="jsonView-add-filter"]'))
    expect(rendered.container.textContent).toContain('Ada')
    expect(rendered.container.textContent).not.toContain('Grace')

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-id="view-settings"]')).toBeNull()
    expect(rendered.container.textContent).toContain('Ada')
    expect(rendered.container.textContent).not.toContain('Grace')
    expect(rendered.container.querySelector('[data-id="conversion-requests"]')?.textContent).toBe('0')

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(document.querySelector('button[aria-label="Filter 1 property"]')).not.toBeNull()
  })

  it('lets hosts preserve root arrays by disabling embedded view creation', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify([{ name: 'Ada' }])
    rendered = await renderComponent(
      <JSONContent
        content={content}
        path="array.json"
        metadataPersistence="inferred"
        allowRootArrayWrapping={false}
        edit={{
          isEditing: false,
          editContent: content,
          onEditChange: () => undefined,
          onCommitContent: async () => undefined,
        }}
      />,
    )

    expect(rendered.container.textContent).toContain('Ada')
    const addView = rendered.container.querySelector('[data-id="jsonView-add-view"]')
    expect(addView?.getAttribute('aria-disabled')).toBe('true')
    expect(addView?.getAttribute('aria-label')).toContain('requires a host')
  })

  it('keeps a short table content-sized inside a fill-height viewer', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(
      <FileContentView
        path="/workspaces/demo/assets/single.json"
        data={jsonFile(JSON.stringify([
          { name: 'First record', status: 'ready' },
          { name: 'Second record', status: 'ready' },
          { name: 'Third record', status: 'ready' },
        ]))}
        fillHeight
      />,
    )

    expect(rendered.container.querySelector('[data-id="tabular-data-dialog-host"]')?.classList.contains('flex-1')).toBe(false)
    expect(rendered.container.querySelector('[data-id="tabular-data-frame"]')?.classList.contains('flex-1')).toBe(false)
    expect(rendered.container.querySelector('[data-id="tabular-data-dialog-host"]')?.classList.contains('max-h-full')).toBe(true)
  })

  it('lets configured views use the full width of their host', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(
      <FileContentView
        path="/workspaces/demo/assets/full-width.json"
        data={jsonFile(JSON.stringify([
          { name: 'First record', status: 'ready' },
          { name: 'Second record', status: 'done' },
        ]))}
      />,
    )

    const content = rendered.container.querySelector('[data-id="json-viewer-content"]')
    expect(content?.classList.contains('w-full')).toBe(true)
    expect(content?.classList.contains('max-w-none')).toBe(true)
    expect(content?.classList.contains('max-w-6xl')).toBe(false)
  })

  it('applies schema widgets without requiring views or showing a Root-only tab', async () => {
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({
      status: 'new',
      $jsonviews: {
        version: 1,
        schema: { '$.status': { type: 'select' } },
      },
    })} />)

    expect(rendered.container.querySelectorAll('[data-id="jsonView-json-tabs"] [role="tab"]')).toHaveLength(2)
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit status"]'))
    expect(rendered.container.querySelector('[data-id="pill-select"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-diagnostics"]')).toBeNull()
  })

  it('searches and edits a root array without losing source row identity', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify([
      { name: 'Ada', value: 1 },
      { name: 'Grace', value: 2 },
      { name: 'Katherine', value: 4 },
    ])} />)

    expect(rendered.container.querySelector('[data-id="tabular-open-record"]')?.textContent).toBe('OPEN')

    await click(rendered.container.querySelector('[data-id="jsonView-search-button"]'))
    const search = rendered.container.querySelector('input[aria-label="Search rows"]')
    if (!(search instanceof HTMLInputElement)) throw new Error('Expected row search')
    await fillControl(search, 'Grace')
    expect(rendered.container.querySelector('tbody')?.textContent).not.toContain('Ada')
    expect(rendered.container.querySelector('tbody')?.textContent).toContain('Grace')

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit value"]'))
    const value = activeInput(rendered.container, 'input[inputmode="decimal"]')
    await fillControl(value, '3')
    await pressKey(value, 'Enter')

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? 'null')
    expect(saved).toEqual([{ name: 'Ada', value: 1 }, { name: 'Grace', value: 3 }, { name: 'Katherine', value: 4 }])
  })

  it.each(['select', 'multi-select'])('writes %s option colors into JSON and renders them after remounting', async (type) => {
    giveVirtualTableAViewport()
    const original = {
      rows: [{ name: 'Ada', audience: type === 'select' ? 'Agents' : ['Agents'] }],
      $jsonviews: {
        version: 1,
        schema: { '$.rows[*].audience': { type, options: ['Agents'], optionColors: { Agents: 'purple' } } },
        views: [{ id: 'rows', name: 'Rows', path: '$.rows', columns: [{ label: 'Name', path: '$.rows[*].name' }, { label: 'Audience', path: '$.rows[*].audience' }] }],
      },
    }
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify(original)} />)
    await click(rendered.container.querySelector('[role="button"][aria-label="Open Ada"]'))
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit audience"]'))
    await click(document.querySelector('button[aria-label="Change color for Agents"]'))
    await click(document.querySelector('button[aria-label="Set Agents color to green"]'))
    const source = rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? 'null'
    const saved = JSON.parse(source)
    expect(saved.rows).toEqual(original.rows)
    expect(saved.$jsonviews.schema['$.rows[*].audience']).toEqual({ ...original.$jsonviews.schema['$.rows[*].audience'], optionColors: { Agents: 'green' } })
    await rendered.cleanup()
    rendered = await renderComponent(<EditableJsonHarness content={source} />)
    expect(rendered.container.querySelector('[data-id="option-pill"]')?.getAttribute('data-option-color')).toBe('green')
  })

  it('edits a schema-backed projected value through the input widget', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new', 'closed'] },
        },
        views: [{
          id: 'leads', name: 'Leads', path: '$.leads',
          columns: [{ label: 'Lead', path: '$.leads[*].name' }, { label: 'Status', path: '$.leads[*].status' }],
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[role="button"][aria-label="Open Ada"]'))
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit status"]'))
    const closed = Array.from(document.querySelectorAll('[data-id="pill-select-option"]'))
      .find((option) => option.textContent?.includes('closed'))
    await click(closed ?? null)

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads[0]).toEqual({ name: 'Ada', status: 'closed' })
    expect(saved.$jsonviews).toEqual(JSON.parse(content).$jsonviews)
    expect(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit status"]')?.textContent).toContain('closed')
  })

  it('moves a Kanban card by updating its exact group field', async () => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new', assignees: ['Niv'] }, { name: 'Grace', status: 'closed', assignees: ['Noam'] }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new', 'closed'] },
        },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const columns = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]'))
    expect(columns).toHaveLength(2)
    const groupColors = columns.map((column) => column.getAttribute('data-group-color'))
    expect(groupColors.every(Boolean)).toBe(true)
    expect(new Set(groupColors).size).toBe(2)
    expect(columns.every((column) => column.querySelector('[data-id="option-pill"]'))).toBe(true)
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull()
    const adaCard = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-card"]'))
      .find((card) => card.textContent?.includes('Ada'))
    expect(adaCard?.textContent?.match(/Ada/g)).toHaveLength(1)
    const closedColumn = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]'))
      .find((column) => column.getAttribute('data-group-value') === 'closed')
    await drag(adaCard, closedColumn, () => {
      expect(adaCard?.getAttribute('aria-grabbed')).toBe('true')
      expect(closedColumn?.querySelector('[data-id="jsonView-kanban-card-preview"]')).not.toBeNull()
      expect(rendered?.container.textContent).not.toContain('Drop before')
    })

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads[0].status).toBe('closed')
    expect(saved.leads[1].status).toBe('closed')
    expect(rendered.container.textContent).not.toContain('Move to')
  })

  it('reorders Kanban columns and auto-saves their group values without changing records', async () => {
    const original = {
      leads: [{ name: 'Ada', status: 'new' }, { name: 'Grace', status: 'closed' }],
      $jsonviews: {
        version: 1,
        schema: { '$.leads[*].status': { type: 'select', options: ['new', 'closed'] } },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupOrder: ['new', 'closed'], groupBy: '$.leads[*].status' }],
      },
    }
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify(original)} />)

    giveKanbanAViewport(rendered.container)
    const closedHandle = rendered.container.querySelector('[aria-label="Reorder closed column"]')
    const newColumn = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]'))
      .find((column) => column.getAttribute('data-group-value') === 'new')
    expect(closedHandle?.closest('header')?.draggable).toBe(true)
    await drag(closedHandle ?? undefined, newColumn, () => {
      expect(closedHandle?.closest('[data-id="jsonView-kanban-column"]')?.getAttribute('data-column-dragging')).toBe('true')
      expect(rendered?.container.querySelector<HTMLElement>('[data-id="jsonView-kanban-column-drop-indicator"]')?.hidden).toBe(false)
    })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]')).map((column) => column.getAttribute('data-group-value')))
      .toEqual(['closed', 'new'])
    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads).toEqual(original.leads)
    expect(saved.$jsonviews.views[0].groupOrder).toEqual(['closed', 'new'])
  })

  it.each(['resolve', 'reject'] as const)('previews a column move immediately and handles a slow save that will %s', async (outcome) => {
    const pending = deferredCommit()
    const onCommit = vi.fn(() => pending.promise)
    rendered = await renderComponent(<OptimisticJsonHarness content={JSON.stringify({
      leads: [{ name: 'Ada', status: 'new' }, { name: 'Grace', status: 'closed' }],
      $jsonviews: { version: 1, views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupOrder: ['new', 'closed'], groupBy: '$.leads[*].status' }] },
    })} onCommit={onCommit} />)
    const order = () => Array.from(rendered!.container.querySelectorAll('[data-id="jsonView-kanban-column"]')).map(column => column.getAttribute('data-group-value'))
    await pressKey(rendered.container.querySelector<HTMLElement>('[aria-label="Reorder closed column"]')!, 'ArrowLeft')
    expect(order()).toEqual(['closed', 'new'])
    await pressKey(rendered.container.querySelector<HTMLElement>('[aria-label="Reorder closed column"]')!, 'ArrowRight')
    expect(onCommit).toHaveBeenCalledOnce()
    if (outcome === 'resolve') {
      await act(async () => pending.resolve())
      expect(order()).toEqual(['closed', 'new'])
    } else {
      await act(async () => pending.reject(new Error('Save failed')))
      // The document retains failed writes as a recoverable draft.
      expect(order()).toEqual(['closed', 'new'])
      expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain('Save failed')
      expect(Array.from(rendered.container.querySelectorAll('button')).some(button => button.textContent === 'Retry save')).toBe(true)
      await click(Array.from(rendered.container.querySelectorAll('button')).find(button => button.textContent === 'Discard unsaved changes') ?? null)
      expect(order()).toEqual(['new', 'closed'])
    }
  })

  it('moves and reorders cards with arrow keys through the same atomic save', async () => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new', rank: 0 }, { name: 'Grace', status: 'closed', rank: 0 }],
      $jsonviews: {
        version: 1,
        schema: { '$.leads[*].status': { type: 'select', options: ['new', 'closed'] } },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status', orderPath: '$.leads[*].rank' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    await act(async () => { rendered!.container.querySelector('[aria-label="Reorder Ada"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(document.body.textContent).not.toContain('Move to column')
    let saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads).toEqual([{ name: 'Ada', status: 'closed', rank: 1 }, { name: 'Grace', status: 'closed', rank: 0 }])
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
    await act(async () => { rendered!.container.querySelector('[aria-label="Reorder Ada"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })) })
    saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads.map((lead: { rank: number }) => lead.rank)).toEqual([0, 1])
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('2')
  })

  it('scrolls a tall Kanban board inside a fill-height viewer', async () => {
    const content = JSON.stringify({
      leads: Array.from({ length: 20 }, (_, index) => ({ name: `Lead ${index + 1}`, status: 'new' })),
      $jsonviews: {
        version: 1,
        schema: { '$.leads[*].status': { type: 'select', options: ['new'] } },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status' }],
      },
    })
    rendered = await renderComponent(
      <FileContentView path="/workspaces/demo/assets/tall-board.json" data={jsonFile(content)} fillHeight />,
    )

    const layout = rendered.container.querySelector('[data-id="jsonView-kanban-layout"]')
    const board = rendered.container.querySelector('[data-id="jsonView-kanban"]')
    expect(layout?.classList.contains('min-h-0')).toBe(true)
    expect(layout?.classList.contains('flex-1')).toBe(true)
    expect(board?.classList.contains('overflow-y-auto')).toBe(true)
  })

  it('uses the same pill editor inside Kanban cards', async () => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new', competitor: 'n8n' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new'] },
          '$.leads[*].competitor': { type: 'select', options: ['n8n', 'Zapier'] },
        },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit competitor"]'))
    expect(rendered.container.querySelector('[data-id="pill-select"]')).not.toBeNull()
    expect(rendered.container.textContent).not.toContain('Move to')
    expect(rendered.container.querySelector('button[aria-label^="Move "]')).toBeNull()
  })

  it('edits a multi-select field from Kanban record detail', async () => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new', tags: ['Engineering'] }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new'] },
          '$.leads[*].tags': { type: 'multi-select', options: ['Engineering', 'Product'] },
        },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-card"] button'))
      .find((button) => button.textContent?.includes('Ada')) ?? null)
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"][aria-label="Edit tags"]'))
    const product = Array.from(document.querySelectorAll('[data-id="multi-select-option"]'))
      .find((option) => option.textContent?.includes('Product'))
    await click(product ?? null)

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads[0].tags).toEqual(['Engineering', 'Product'])
  })

  it('opens the date popover with one click on a Kanban card', async () => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new', due: '2026-09-04' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new'] },
          '$.leads[*].due': { type: 'date' },
        },
        views: [{
          id: 'pipeline',
          name: 'Pipeline',
          path: '$.leads',
          display: 'kanban',
          groupBy: '$.leads[*].status',
          columns: [
            { label: 'Name', path: '$.leads[*].name' },
            { label: 'Due', path: '$.leads[*].due' },
            { label: 'Status', path: '$.leads[*].status' },
          ],
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-kanban-card"] [aria-label="Edit Due"]'))
    expect(document.querySelector('[data-id="date-editor-popover"]')).not.toBeNull()
    expect(document.querySelector('[role="gridcell"][aria-selected="true"] button')?.getAttribute('data-date')).toBe('2026-09-04')
  })

  it('preserves numeric Kanban group values when moving cards', async () => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', stage: 1 }, { name: 'Grace', stage: 2 }],
      $jsonviews: {
        version: 1,
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].stage' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const cards = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-card"]'))
    const adaCard = cards.find((card) => card.textContent?.includes('Ada'))
    const secondColumn = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]'))
      .find((column) => column.getAttribute('data-group-value') === '2')
    await drag(adaCard, secondColumn)

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads[0].stage).toBe(2)
  })

  it('keeps same-column Kanban order local unless orderPath persists it', async () => {
    const base = {
      leads: [{ name: 'Ada', status: 'new', rank: 0 }, { name: 'Grace', status: 'new', rank: 1 }],
      $jsonviews: {
        version: 1,
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status' }],
      },
    }
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify(base)} />)

    let cards = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-card"]'))
    await drag(
      cards.find((card) => card.textContent?.includes('Grace')),
      cards.find((card) => card.textContent?.includes('Ada')),
    )
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
    expect(Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-card"]')).map((card) => card.textContent?.includes('Ada')))
      .toEqual([false, true])

    await rendered.cleanup()
    rendered = null
    const persistent = {
      ...base,
      $jsonviews: {
        ...base.$jsonviews,
        views: base.$jsonviews.views.map((view) => ({ ...view, orderPath: '$.leads[*].rank' })),
      },
    }
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify(persistent)} />)
    cards = Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-card"]'))
    await drag(
      cards.find((card) => card.textContent?.includes('Grace')),
      cards.find((card) => card.textContent?.includes('Ada')),
    )

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads.map((lead: { rank: number }) => lead.rank)).toEqual([1, 0])
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
  })

  it.each([false, true])('lands in the previewed cross-column end slot (orderPath: %s)', async persistent => {
    const content = JSON.stringify({
      leads: [{ name: 'Ada', status: 'new', rank: 0 }, { name: 'Grace', status: 'closed', rank: 0 }, { name: 'Lin', status: 'closed', rank: 1 }],
      $jsonviews: { version: 1, views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupOrder: ['new', 'closed'], groupBy: '$.leads[*].status', ...(persistent ? { orderPath: '$.leads[*].rank' } : {}) }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    const ada = rendered.container.querySelector('[data-id="jsonView-kanban-card"]')!
    const target = rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]')[1]
    await drag(ada, target, () => {
      const preview = target.querySelector<HTMLElement>('[data-id="jsonView-kanban-card-preview"]')!
      expect(preview).not.toBeNull()
      expect(preview.style.transform).toBe('translateY(300px)')
      expect(rendered?.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
    }, 350)
    expect(Array.from(target.querySelectorAll('[data-id="jsonView-kanban-card"]')).map(card => card.querySelector('button:not([data-id])')?.textContent)).toEqual(['Grace', 'Lin', 'Ada'])
    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')!.textContent!)
    expect(saved.leads.map((row: { status: string }) => row.status)).toEqual(['closed', 'closed', 'closed'])
    expect(saved.leads.map((row: { rank: number }) => row.rank)).toEqual(persistent ? [2, 0, 1] : [0, 0, 1])
    expect(rendered.container.querySelector('[data-id="jsonView-kanban-card-preview"]')).toBeNull()
  })

  it('auto-saves embedded view changes without changing the data', async () => {
    giveVirtualTableAViewport()
    const original = {
      leads: [{ name: 'Ada', status: 'new', priority: 2 }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'leads', name: 'Leads', path: '$.leads',
          columns: [
            { label: 'Lead', path: '$.leads[*].name' },
            { label: 'Status', path: '$.leads[*].status' },
            { label: 'Priority', path: '$.leads[*].priority' },
          ],
        }],
      },
    }
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify(original)} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    const propertyRows = Array.from(document.querySelectorAll('[data-id="jsonView-property-option"]'))
    const nameRow = propertyRows.find((row) => row.getAttribute('data-field-path') === '$.leads[*].name')
    const statusRow = propertyRows.find((row) => row.getAttribute('data-field-path') === '$.leads[*].status')
    await drag(statusRow, nameRow)
    await click(document.querySelector('[aria-label="Show Priority"]'))
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
    expect(document.querySelector('[data-id="jsonView-save-view"]')).toBeNull()
    await settleViewSave()

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.leads).toEqual(original.leads)
    expect(saved.$jsonviews.views[0].columns).toEqual([
      { label: 'Status', path: '$.leads[*].status' },
      { label: 'Lead', path: '$.leads[*].name' },
    ])
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
  })

  it('does not turn a natural dictionary into a table when options open', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({ a: { name: 'A', nested: { body: 'long' } }, b: { name: 'B', nested: { body: 'long' } }, c: { name: 'C', nested: { body: 'long' } } })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    const headers = () => Array.from(rendered!.container.querySelectorAll('th')).map((node) => node.textContent)
    const before = headers()
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await settleViewSave()
    expect(headers()).toEqual(before)
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
  })

  it('does not rewrite an embedded view merely because View options opened', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ name: 'Ada' }],
      $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows' }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await settleViewSave()

    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
    expect(document.querySelector('[data-id="jsonView-save-view"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-auto-save-status"]')).toBeNull()
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Done')).toBe(false)
  })

  it('keeps view settings interactive while a nested choice menu is open', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', priority: 2 }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'leads',
          name: 'Leads',
          path: '$.leads',
          sort: [{ path: '$.leads[*].priority', direction: 'asc' }],
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    const settings = document.querySelector('[data-id="view-settings"]')
    await click(Array.from(settings?.querySelectorAll('summary') ?? []).find((summary) => summary.textContent?.includes('Sort')) ?? null)
    await openChoiceControl(settings?.querySelector('button[aria-label="Sort 1 property"]') ?? null)

    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(Array.from(document.querySelectorAll('[data-id="pill-select-option"]')).every((option) => option.classList.contains('w-full'))).toBe(true)
    await act(async () => {
      settings?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    expect(document.querySelector('[data-id="view-settings"]')).toBe(settings)
  })

  it('generates nested property paths without exposing JSONPath controls', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', owner: { email: 'ada@example.com' } }],
      $jsonviews: {
        version: 1,
        views: [{ id: 'leads', name: 'Leads', path: '$.leads', columns: [{ label: 'Lead', path: '$.leads[*].name' }] }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(document.querySelector('input[aria-label*="path" i]')).toBeNull()
    await click(document.querySelector('[aria-label="Show Owner › Email"]'))
    await settleViewSave()

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].columns).toEqual([
      { label: 'Lead', path: '$.leads[*].name' },
      { label: 'Owner › Email', path: '$.leads[*].owner.email' },
    ])
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
  })

  it('flushes an embedded view change when View options is dismissed', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada' }],
      $jsonviews: {
        version: 1,
        views: [{ id: 'leads', name: 'Leads', path: '$.leads', columns: [{ label: 'Lead', path: '$.leads[*].name' }] }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    const label = document.querySelector('input[aria-label="Name label"]')
    if (!(label instanceof HTMLInputElement)) throw new Error('Expected property label')
    await fillControl(label, 'Contact')
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    await settleViewSave()
    expect(document.querySelector('[data-id="view-settings"]')).toBeNull()
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))

    expect((document.querySelector('input[aria-label="Name label"]') as HTMLInputElement).value).toBe('Contact')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
  })

  it('renames, drags, sorts, and hides a property from its column heading', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', score: 1 }, { name: 'Grace', score: 2 }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'leads',
          name: 'Leads',
          path: '$.leads',
          columns: [
            { label: 'Name', path: '$.leads[*].name' },
            { label: 'Score', path: '$.leads[*].score' },
          ],
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for Name"]'))
    const rename = document.querySelector('input[aria-label="Rename Name"]')
    if (!(rename instanceof HTMLInputElement)) throw new Error('Expected column rename input')
    await fillControl(rename, 'Person')
    await act(async () => {
      rename.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    let saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].columns[0]).toEqual({ label: 'Person', path: '$.leads[*].name' })
    expect(headerTexts(rendered.container)).toContain('Person')

    const personHeader = rendered.container.querySelector('button[aria-label="Column options for Person"]')?.closest('th')
    const scoreHeader = rendered.container.querySelector('button[aria-label="Column options for Score"]')?.closest('th')
    await drag(scoreHeader, personHeader)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].columns).toEqual([
      { label: 'Score', path: '$.leads[*].score' },
      { label: 'Person', path: '$.leads[*].name' },
    ])
    const adaRow = Array.from(rendered.container.querySelectorAll('tbody tr')).find((row) => row.textContent?.includes('Ada'))
    const adaCells = adaRow ? Array.from(adaRow.querySelectorAll('td')) : []
    expect(adaCells[1]?.querySelector('[data-id="tabular-open-record"]')).toBeNull()
    expect(adaCells[0]?.querySelector('[data-id="tabular-open-record"]')).not.toBeNull()
    expect(adaCells[1]?.querySelector('[data-id="tabular-row-select"]')).toBeNull()
    expect(adaCells[0]?.querySelector('[data-id="tabular-row-select"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="tabular-select-all-rows"]')?.closest('th')?.textContent).toBe('Score')
    await click(adaCells[0]?.querySelector('[role="checkbox"]') ?? null)
    expect(rendered.container.querySelector('[data-id="tabular-selection-bar"]')?.textContent).toContain('1 selected')

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for Person"]'))
    await click(Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent?.includes('Move first')) ?? null)
    saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].columns.map((column: { label: string }) => column.label)).toEqual(['Person', 'Score'])
    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for Person"]'))
    await click(document.querySelector('[data-id="tabular-sort-column"]'))
    await click(document.querySelector('[data-id="tabular-sort-descending"]'))
    saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].sort).toEqual([{ path: '$.leads[*].name', direction: 'desc' }])
    expect(rendered.container.querySelector('table')?.getAttribute('data-selection-active')).toBe('false')
    const rows = Array.from(rendered.container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '')
    expect(rows.findIndex((row) => row.includes('Grace'))).toBeLessThan(rows.findIndex((row) => row.includes('Ada')))

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for Score"]'))
    await click(document.querySelector('[data-id="tabular-hide-column"]'))
    saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].columns).toEqual([{ label: 'Person', path: '$.leads[*].name' }])
    expect(headerTexts(rendered.container)).not.toContain('Score')
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('5')
  })

  it.each([
    { fields: ['name', 'code'], expected: 'Ada' },
    { fields: ['code', 'name'], expected: 'A-1' },
    { fields: ['code'], expected: 'A-1' },
    { fields: ['details.label', 'name'], expected: 'Nested Ada' },
    { fields: ['missing', 'name'], expected: 'Untitled' },
  ])('uses the first configured board column $fields for card and record headings', async ({ fields, expected }) => {
    const content = JSON.stringify({
      rows: [{ name: 'Ada', code: 'A-1', details: { label: 'Nested Ada' }, status: 'Open' }, { name: 'Grace', missing: 'Other', status: 'Open' }],
      $jsonviews: { version: 1, views: [{ name: 'Board', path: '$.rows', display: 'kanban', groupBy: '$.rows[*].status',
        columns: fields.map((field) => ({ label: field, path: `$.rows[*].${field}` })),
      }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    const card = rendered.container.querySelector('[data-id="jsonView-kanban-card"]')
    expect(card?.textContent).toContain(expected)
    await click(Array.from(card?.querySelectorAll('button') ?? []).find((button) => button.textContent === expected) ?? null)
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toBe(expected)
  })

  it('filters and clears a saved view from its column heading', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', score: 1 }, { name: 'Grace', score: 2 }],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'leads',
          name: 'Leads',
          path: '$.leads',
          columns: [
            { label: 'Name', path: '$.leads[*].name' },
            { label: 'Score', path: '$.leads[*].score' },
          ],
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const scoreMenu = () => rendered?.container.querySelector('button[aria-label="Column options for Score"]') ?? null
    await openDropdown(scoreMenu())
    await click(document.querySelector('[data-id="tabular-filter-column"]'))
    const condition = document.querySelector('button[aria-label="Filter Score condition"]')
    const value = document.querySelector('input[aria-label="Filter Score value"]')
    if (!(condition instanceof HTMLButtonElement) || !(value instanceof HTMLInputElement)) throw new Error('Expected column filter controls')
    await selectControl(condition, 'gte')
    await fillControl(value, '2')
    await click(document.querySelector('[data-id="tabular-apply-filter"]'))

    let saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].filter).toEqual({
      rules: [{ path: '$.leads[*].score', operator: 'gte', value: 2 }],
    })
    expect(rendered.container.querySelectorAll('tbody tr[data-index]')).toHaveLength(1)
    expect(rendered.container.querySelector('tbody')?.textContent).toContain('Grace')
    expect(rendered.container.querySelector('tbody')?.textContent).not.toContain('Ada')
    expect(scoreMenu()?.querySelector('[data-id="tabular-column-filter-active"]')).not.toBeNull()

    await openDropdown(scoreMenu())
    expect(document.querySelector('[data-id="tabular-filter-column"]')?.textContent).toContain('Edit filter')
    await click(document.querySelector('[data-id="tabular-filter-column"]'))
    await click(document.querySelector('[data-id="tabular-clear-filter"]'))

    saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0].filter).toBeUndefined()
    expect(rendered.container.querySelector('tbody')?.textContent).toContain('Ada')
    expect(rendered.container.querySelector('tbody')?.textContent).toContain('Grace')
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('2')
  })

  it('filters an inferred table from its column heading without changing source', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<FileContentView
      path="/workspaces/demo/assets/leads.json"
      data={jsonFile(JSON.stringify([{ name: 'Ada', score: 1 }, { name: 'Grace', score: 2 }, { name: 'Katherine', score: 0 }]))}
    />)

    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for score"]'))
    await click(document.querySelector('[data-id="tabular-filter-column"]'))
    const condition = document.querySelector('button[aria-label="Filter score condition"]')
    const value = document.querySelector('input[aria-label="Filter score value"]')
    if (!(condition instanceof HTMLButtonElement) || !(value instanceof HTMLInputElement)) throw new Error('Expected transient filter controls')
    await selectControl(condition, 'gt')
    await fillControl(value, '1')
    await click(document.querySelector('[data-id="tabular-apply-filter"]'))

    expect(rendered.container.querySelectorAll('tbody tr[data-index]')).toHaveLength(1)
    expect(rendered.container.querySelector('tbody')?.textContent).toContain('Grace')
    expect(rendered.container.querySelector('tbody')?.textContent).not.toContain('Ada')
    expect(rendered.container.textContent).toMatch(/1\s+row/)

    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))
    expect(sourceTargets(rendered.container)).toEqual([{ name: 'Grace', score: 2 }])
  })

  it('adds a view for the currently navigated collection without rewriting existing data', async () => {
    giveVirtualTableAViewport()
    const content = '{\n  "$jsonviews":{"version":1,"views":[]},\n  "rows" : [{"name":"Ada","unsafe":9007199254740993}]\n}\n'
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const addView = rendered.container.querySelector('[data-id="jsonView-add-view"]')
    expect(addView?.textContent).toBe('')
    expect(addView?.getAttribute('aria-label')).toBe('New view')
    await click(nestedValueForKey(rendered.container, 'rows'))
    await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-root-array-wrap-banner"]')).toBeNull()
    const addViewMenu = document.querySelector('[data-id="jsonView-add-view-menu"]')
    expect(rendered.container.contains(addViewMenu)).toBe(false)
    expect(addViewMenu?.getAttribute('style')).toContain('position: fixed')
    expect(document.querySelector('select[aria-label="New view path"]')).toBeNull()
    expect((document.querySelector('input[aria-label="New view name"]') as HTMLInputElement).value).toBe('Rows')
    expect(document.querySelector('[data-id="jsonView-new-table"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-id="jsonView-new-html"]')).toBeNull()
    await click(document.querySelector('[data-id="jsonView-create-view"]'))

    const savedSource = rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? ''
    expect(savedSource).toMatch(/"unsafe":\s*9007199254740993/)
    const saved = JSON.parse(savedSource)
    expect(saved.$jsonviews.views).toEqual([{ id: 'rows', name: 'Rows', path: '$.rows' }])
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-rows"]')?.textContent).toContain('Rows')
  })

  it('hides internal metadata from record navigation while allowing a root view', async () => {
    const content = JSON.stringify({
      rows: [{ name: 'Ada' }],
      $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows' }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await selectTab(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))
    // Internal view metadata is intentionally hidden from the record page.
    expect(nestedValueForKey(rendered.container, '$jsonviews')).toBeNull()

    const addView = rendered.container.querySelector('[data-id="jsonView-add-view"]')
    expect(addView?.getAttribute('aria-disabled')).not.toBe('true')
    await click(addView)
    expect(document.querySelector('[data-id="jsonView-add-view-menu"]')).not.toBeNull()
    expect(document.querySelector('[data-id="jsonView-add-view-menu"]')?.textContent).not.toContain('$jsonviews')
  })

  it('defaults a new view to the current collection and creates a Kanban', async () => {
    const content = JSON.stringify({
      projects: [{ name: 'Website', status: 'Active' }],
      contacts: [{ name: 'Ada', status: 'Customer' }],
      $jsonviews: {
        version: 1,
        schema: {
          '$.projects[*].status': { type: 'select', options: ['Active'] },
          '$.contacts[*].status': { type: 'select', options: ['Customer'] },
        },
        views: [{ id: 'contacts', name: 'Contacts', path: '$.contacts' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
    expect(document.querySelector('select[aria-label="New view path"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-add-view-menu"]')?.getAttribute('style')).toContain('position: fixed')
    expect((document.querySelector('input[aria-label="New view name"]') as HTMLInputElement).value).toBe('Contacts')
    await click(document.querySelector('[data-id="jsonView-new-kanban"]'))
    const groupBy = document.querySelector('button[aria-label="New view group by"]')
    expect(groupBy).toBeInstanceOf(HTMLButtonElement)
    expect(groupBy?.textContent).toContain('Status')
    await click(document.querySelector('[data-id="jsonView-create-view"]'))

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views).toEqual([
      { id: 'contacts', name: 'Contacts', path: '$.contacts' },
      { id: 'contacts-2', name: 'Contacts 2', path: '$.contacts', display: 'kanban', groupBy: '$.contacts[*].status' },
    ])
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-contacts-2"]')?.textContent).toContain('Contacts 2')
  })

  it('saves record paths as pages and arrays in natural layouts', async () => {
    const content = JSON.stringify({
      profile: { name: 'Ada', tags: ['founder', 'engineer'] },
      rows: [{ name: 'Grace' }],
      $jsonviews: { version: 1, views: [] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(nestedValueForKey(rendered.container, 'profile'))
    await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
    expect(document.querySelector('select[aria-label="New view path"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-new-table"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-new-page"]')).toBeNull()
    expect(document.querySelector('[data-id="jsonView-add-view-menu"]')?.textContent).toContain('natural JSON layout')
    await click(document.querySelector('[data-id="jsonView-create-view"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-record-back"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('Ada')

    const tagsTerm = Array.from(rendered.container.querySelectorAll('dt')).find((term) => term.textContent === 'tags')
    await click(tagsTerm?.nextElementSibling?.querySelector('button[title="Expand value"]') ?? null)
    await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
    expect(document.querySelector('[data-id="jsonView-add-view-menu"]')?.textContent).toContain('natural JSON layout')
    expect((document.querySelector('input[aria-label="New view name"]') as HTMLInputElement).value).toBe('Profile › Tags')
    await click(document.querySelector('[data-id="jsonView-create-view"]'))

    await selectTab(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))
    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views).toEqual([
      { id: 'profile', name: 'Profile', path: '$.profile' },
      { id: 'profile-tags', name: 'Profile › Tags', path: '$.profile.tags' },
    ])
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-profile-tags"]')?.textContent).toContain('Profile › Tags')
  })

  it('keeps unrecognized title candidates as properties', async () => {
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({ extracted_at: '2026-09-14T07:30:13.283889', csm_lead: 'Rachel Miller', total_stuck_accounts: 5 })} />)
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')).toBeNull()
    expect(rendered.container.querySelector('dl')?.textContent).toContain('Csm lead')
    expect(rendered.container.querySelector('dl')?.textContent).toContain('Rachel Miller')
    expect(rendered.container.querySelector('[data-id="jsonView-record-title-label"]')).toBeNull()
  })

  it('labels a recognized title without duplicating its value', async () => {
    rendered = await renderComponent(<EditableJsonHarness content={JSON.stringify({ name: 'Rachel Miller', total_stuck_accounts: 5 })} />)
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('Rachel Miller')
    const label = rendered.container.querySelector('[data-id="jsonView-record-title-label"]')
    expect(label?.textContent).toBe('Name')
    expect(label?.getAttribute('title')).toBe('name')
    expect(rendered.container.querySelector('dl')?.textContent).not.toContain('Rachel Miller')
  })

  it('renders, edits, and renames a record view without a display override', async () => {
    const content = JSON.stringify({
      rows: [{ title: '', url: 'https://example.com' }],
      $jsonviews: {
        version: 1,
        views: [{ id: 'record', name: 'Record', path: '$.rows[0]' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-record-back"]')).toBeNull()
    const heading = rendered.container.querySelector('[data-id="jsonView-record-title"]')
    expect(heading?.textContent).toContain('Untitled')
    expect(Array.from(rendered.container.querySelectorAll('dt')).some((term) => term.textContent === 'title')).toBe(false)

    await click(heading?.querySelector('[data-id="atomic-edit-value"]') ?? null)
    const input = rendered.container.querySelector('input[aria-label="Edit title"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('Expected title editor')
    await fillControl(input, 'Draft title')
    await pressKey(input, 'Enter')

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.rows[0].title).toBe('Draft title')
    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await settleViewSave()
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('1')
    const name = document.querySelector('input[aria-label="View name"]')
    if (!(name instanceof HTMLInputElement)) throw new Error('Expected view name editor')
    await fillControl(name, 'Renamed record')
    await settleViewSave()
    const renamed = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(renamed.$jsonviews.views[0]).toEqual({ id: 'record', name: 'Renamed record', path: '$.rows[0]' })
    expect(rendered.container.querySelector('[data-id="jsonView-record-title"]')?.textContent).toContain('Draft title')
  })

  it('uses heading-sized editing for a schema-driven record title', async () => {
    const content = JSON.stringify({
      rows: [{ name: 'Ada' }],
      $jsonviews: {
        version: 1,
        schema: { '$.rows[*].name': { type: 'text', title: 'Name' } },
        views: [{ id: 'record', name: 'Record', path: '$.rows[0]' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    const heading = rendered.container.querySelector('[data-id="jsonView-record-title"]')
    await click(heading?.querySelector('[data-id="atomic-edit-value"]') ?? null)

    expect(heading?.classList.contains('flex-1')).toBe(true)
    expect(heading?.querySelector('[data-id="jsonView-schema-editor"]')?.classList.contains('text-xl')).toBe(true)
    const input = heading?.querySelector('input[aria-label="Edit Name"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    expect(input?.classList.contains('focus:ring-inset')).toBe(true)
  })

  it('saves field-driven Kanban, filter, and sort configuration', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [
        { name: 'Ada', status: 'Active', priority: 2 },
        { name: 'Grace', status: 'Paused', priority: 1 },
      ],
      $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows' }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    expect(document.querySelector('input[aria-label*="path" i]')).toBeNull()
    expect(document.querySelector('input[aria-label*="orderPath" i]')).toBeNull()
    await click(document.querySelector('[data-id="jsonView-layout-kanban"]'))
    const groupBy = document.querySelector('button[aria-label="Group by"]')
    if (!(groupBy instanceof HTMLButtonElement)) throw new Error('Expected Group by picker')
    await selectControl(groupBy, '$.rows[*].status')

    await click(document.querySelector('[data-id="jsonView-add-filter"]'))
    const filterProperty = document.querySelector('button[aria-label="Filter 1 property"]')
    if (!(filterProperty instanceof HTMLButtonElement)) throw new Error('Expected filter property picker')
    await selectControl(filterProperty, '$.rows[*].status')
    const filterValue = document.querySelector('button[aria-label="Filter 1 value"]')
    if (!(filterValue instanceof HTMLButtonElement)) throw new Error('Expected inferred filter values')
    await selectControl(filterValue, 'Active')

    await click(document.querySelector('[data-id="jsonView-add-sort"]'))
    const sortProperty = document.querySelector('button[aria-label="Sort 1 property"]')
    const sortDirection = document.querySelector('button[aria-label="Sort 1 direction"]')
    if (!(sortProperty instanceof HTMLButtonElement) || !(sortDirection instanceof HTMLButtonElement)) throw new Error('Expected sort controls')
    await selectControl(sortProperty, '$.rows[*].priority')
    await selectControl(sortDirection, 'desc')
    await settleViewSave()

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views[0]).toMatchObject({
      display: 'kanban',
      groupBy: '$.rows[*].status',
      filter: { rules: [{ path: '$.rows[*].status', operator: 'eq', value: 'Active' }] },
      sort: [{ path: '$.rows[*].priority', direction: 'desc' }],
    })
  })

  it('clears a filter value when its property changes', async () => {
    const content = JSON.stringify({
      rows: [
        { priority: 'Low', active: false },
        { priority: 'High', active: true },
      ],
      $jsonviews: {
        version: 1,
        views: [{
          id: 'rows',
          name: 'Rows',
          path: '$.rows',
          filter: { rules: [{ path: '$.rows[*].active', operator: 'neq', value: false }] },
        }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    const settings = document.querySelector('[data-id="view-settings"]')
    await click(Array.from(settings?.querySelectorAll('summary') ?? []).find((summary) => summary.textContent?.includes('Filter')) ?? null)
    const filterProperty = settings?.querySelector('button[aria-label="Filter 1 property"]')
    await selectControl(filterProperty ?? null, '$.rows[*].priority')

    const filterValue = settings?.querySelector('button[aria-label="Filter 1 value"]')
    expect(filterValue?.textContent).toContain('Select a value')
    await openChoiceControl(filterValue ?? null)
    expect(Array.from(document.querySelectorAll('[data-id="pill-select-option"]')).map((option) => option.getAttribute('data-value')))
      .toEqual([null, 'Low', 'High'])
  })

  it('renames, duplicates, and deletes views from the secondary menu', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      rows: [{ name: 'Ada' }],
      $jsonviews: { version: 1, views: [{ id: 'rows', name: 'Rows', path: '$.rows' }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    const name = document.querySelector('input[aria-label="View name"]')
    if (!(name instanceof HTMLInputElement)) throw new Error('Expected view name')
    await fillControl(name, 'People')
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('0')
    await settleViewSave()
    await click(document.querySelector('button[aria-label="Duplicate view"]'))
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('2')

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('button[aria-label="Delete view"]'))
    await click(document.querySelector('[data-id="jsonView-confirm-delete-view"]'))

    const saved = JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}')
    expect(saved.$jsonviews.views).toEqual([{ id: 'rows', name: 'People', path: '$.rows' }])
    expect(rendered.container.querySelector('[data-id="edit-commit-count"]')?.textContent).toBe('3')
  })

  it('uses date-specific filter labels and operators', async () => {
    const content = JSON.stringify({
      rows: [{ due: '2026-09-04' }],
      $jsonviews: {
        version: 1,
        schema: { '$.rows[*].due': { type: 'date' } },
        views: [{ id: 'dates', name: 'Dates', path: '$.rows' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await click(rendered.container.querySelector('[data-id="jsonView-edit-view"]'))
    await click(document.querySelector('[data-id="jsonView-add-filter"]'))
    const condition = document.querySelector('button[aria-label="Filter 1 condition"]')
    if (!(condition instanceof HTMLButtonElement)) throw new Error('Expected filter condition')
    await openChoiceControl(condition)
    expect(Array.from(document.querySelectorAll('[data-id="pill-select-option"]')).map((option) => option.textContent?.trim())).toEqual([
      'is',
      'is not',
      'is before',
      'is on or before',
      'is after',
      'is on or after',
      'is empty',
      'is not empty',
    ])
  })

  it('shows legacy body text in the table and opens its record editor', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', notes: 'Long-form notes', details: 'More details\nSecond line' }],
      $jsonviews: { version: 1, schema: { '$.leads[*].notes': { type: 'body' } },
        views: [{ id: 'leads', name: 'Leads', path: '$.leads' }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    expect(rendered.container.textContent).toContain('Long-form notes')
    const openText = rendered.container.querySelector('button[aria-label="Open notes in record"]')
    await click(openText)
    const editor = rendered.container.querySelector('textarea[aria-label="Edit notes"]') as HTMLTextAreaElement
    expect(editor?.value).toBe('Long-form notes')
    expect(document.activeElement).toBe(editor)
    expect(rendered.container.textContent).toContain('More details')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, 'Updated notes')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { editor.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(JSON.parse(rendered.container.querySelector('[data-id="edit-saved"]')?.textContent ?? '{}').leads[0].notes).toBe('Updated notes')
  })

  it('opens a record normally from its title without creating a body', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', notes: 'First line\nSecond line' }],
      $jsonviews: { version: 1, views: [{ id: 'leads', name: 'Leads', path: '$.leads' }] },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)
    await click(rendered.container.querySelector('[role="button"][aria-label="Open Ada"]'))
    expect(rendered.container.querySelector('textarea')).toBeNull()
    expect(rendered.container.textContent).toContain('First line')
    expect(rendered.container.querySelector('[data-id="jsonView-add-body"]')).toBeNull()
  })

  it('keeps Markdown properties reachable through unfiltered Root navigation', async () => {
    giveVirtualTableAViewport()
    const content = JSON.stringify({
      leads: [{ name: 'Ada', notes: 'Long-form notes' }],
      $jsonviews: {
        version: 1,
        schema: { '$.leads[*].notes': { type: 'markdown' } },
        views: [{ id: 'leads', name: 'Leads', path: '$.leads' }],
      },
    })
    rendered = await renderComponent(<EditableJsonHarness content={content} />)

    await selectTab(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]'))
    await click(nestedValueForKey(rendered.container, 'leads'))
    if (!rendered.container.querySelector('[data-id="jsonView-record-view"]')) await click(rendered.container.querySelector('[aria-label="Open nested value"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-record-view"]')).not.toBeNull()
    expect(valueForKey(rendered.container, 'notes')).toContain('Long-form notes')
    await click(rendered.container.querySelector('[aria-label="Edit notes"]'))
    expect((rendered.container.querySelector('textarea') as HTMLTextAreaElement)?.value).toBe('Long-form notes')
  })

  it('shows configured Kanban groups for an empty record collection', async () => {
    const content = JSON.stringify({
      leads: [],
      $jsonviews: {
        version: 1,
        schema: {
          '$.leads[*].status': { type: 'select', options: ['new', 'closed'] },
        },
        views: [{ id: 'pipeline', name: 'Pipeline', path: '$.leads', display: 'kanban', groupBy: '$.leads[*].status' }],
      },
    })
    rendered = await renderComponent(<FileContentView path="/workspaces/demo/assets/empty.json" data={jsonFile(content)} />)

    expect(Array.from(rendered.container.querySelectorAll('[data-id="jsonView-kanban-column"]')).map((column) => column.textContent))
      .toEqual(expect.arrayContaining([expect.stringContaining('new'), expect.stringContaining('closed')]))
  })

  it('omits invalid views, hides the Root-only tab strip, and keeps visible diagnostics', async () => {
    const content = JSON.stringify({
      leads: [],
      $jsonviews: { version: 1, views: [{ id: 'missing', name: 'Missing', path: '$.nope' }] },
    })
    rendered = await renderComponent(<FileContentView path="/workspaces/demo/assets/invalid-view.json" data={jsonFile(content)} />)

    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-missing"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-root"]')).not.toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-json-diagnostics"] summary')?.getAttribute('aria-label')).toBe('1 JSON issue')
  })
})


describe('valid JSON edge-case regressions', () => {
  function ExplicitRootTable({ content, onSave = async () => {}, objectColumns = false }: { content: string; onSave?: (source: string) => Promise<void>; objectColumns?: boolean }) {
    const [metadata, setMetadata] = useState<Record<string, unknown>>({ version: 1, views: [{ id: 'data', name: 'Data', path: '$', ...(objectColumns ? { columns: [{ label: 'name', path: '$[*].name' }, { label: 'payload', path: '$[*].payload' }] } : {}) }] })
    return <JSONContent content={content} metadata={metadata} onMetadataChange={async (next) => { setMetadata(next) }} onSave={onSave} />
  }
  const fixture = (name: string) => readFileSync(`../core/test/fixtures/json-edge-cases/${name}.json`, 'utf8')
  const visibleRows = (container: HTMLElement) => Array.from(container.querySelectorAll('tbody tr')).map((row) => row.textContent ?? '').filter(Boolean)
  async function sort(column: string, direction: 'ascending' | 'descending') {
    await openDropdown(rendered!.container.querySelector(`button[aria-label="Column options for ${column}"]`))
    await click(document.querySelector('[data-id="tabular-sort-column"]'))
    await click(document.querySelector(`[data-id="tabular-sort-${direction}"]`))
  }

  it.each(['ascending', 'descending'] as const)('sorts legal object values %s without losing the viewer', async (direction) => {
    giveVirtualTableAViewport()
    const content = fixture('object-sort')
    const save = vi.fn(async () => undefined)
    rendered = await renderComponent(<ExplicitRootTable content={content} onSave={save} objectColumns />)
    await sort('payload', direction)
    const rows = visibleRows(rendered.container)
    expect(rows[0]).toContain(direction === 'ascending' ? 'alpha' : 'beta')
    expect(rendered.container.textContent).not.toContain('could not render')
    expect(save).not.toHaveBeenCalled()
  })

  it.each(['ascending', 'descending'] as const)('sorts large numeric IDs %s using exact source tokens', async (direction) => {
    giveVirtualTableAViewport()
    const save = vi.fn(async () => undefined)
    rendered = await renderComponent(<ExplicitRootTable content={fixture('large-integer-sort')} onSave={save} />)
    await sort('id', direction)
    const rows = visibleRows(rendered.container)
    expect(rows[0]).toContain(direction === 'ascending' ? '9007199254740992' : '9007199254740993')
    expect(rows[1]).toContain(direction === 'ascending' ? '9007199254740993' : '9007199254740992')
    expect(save).not.toHaveBeenCalled()
  })

  it.each([
    { source: '[9007199254740993,9007199254740992]', column: 'Value' },
    { source: '[[9007199254740993,"larger"],[9007199254740992,"smaller"]]', column: '0' },
    { source: '{"$jsonviews":{"version":1,"views":[]},"z":{"id":9007199254740993,"name":"larger"},"a":{"id":9007199254740992,"name":"smaller"},"b":{"id":9007199254740994,"name":"largest"}}', column: 'id', nested: true },
  ])('retains exact paths when sorting $column in a natural table', async ({ source, column, nested }) => {
    giveVirtualTableAViewport()
    // A plain dictionary without annotations uses the general JSON table.
    const content = nested ? source.replace('"$jsonviews":{"version":1,"views":[]},', '') : source
    rendered = await renderComponent(<JSONContent content={content} />)
    await sort(column, 'ascending')
    expect(visibleRows(rendered.container)[0]).toContain('9007199254740992')
  })

  it('filters exact IDs and refuses to silently round a typed operand', async () => {
    giveVirtualTableAViewport()
    rendered = await renderComponent(<ExplicitRootTable content={fixture('large-integer-sort')} />)
    await openDropdown(rendered.container.querySelector('button[aria-label="Column options for id"]'))
    await click(document.querySelector('[data-id="tabular-filter-column"]'))
    await selectControl(document.querySelector('button[aria-label="Filter id condition"]'), 'gt')
    await fillControl(document.querySelector('input[aria-label="Filter id value"]') as HTMLInputElement, '9007199254740993')
    await click(document.querySelector('[data-id="tabular-apply-filter"]'))
    expect(document.body.textContent).toContain('needs exact numeric source text')
    expect(visibleRows(rendered.container)).toHaveLength(2)
    await fillControl(document.querySelector('input[aria-label="Filter id value"]') as HTMLInputElement, '9007199254740992')
    await click(document.querySelector('[data-id="tabular-apply-filter"]'))
    const rows = visibleRows(rendered.container)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('larger')
  })

  it.each(['table', 'kanban'])('applies an exact saved numeric filter in a %s', async (display) => {
    giveVirtualTableAViewport()
    const source = `{"rows":[{"name":"larger","id":9007199254740993,"status":"Open"},{"name":"smaller","id":9007199254740992,"status":"Open"}],"$jsonviews":{"version":1,"views":[{"id":"v","name":"V","path":"$.rows","display":"${display}",${display === 'kanban' ? '"groupBy":"$.rows[*].status",' : ''}"filter":{"rules":[{"path":"$.rows[*].id","operator":"eq","value":9007199254740993}]}}]}}`
    rendered = await renderComponent(<JSONContent content={source} />)
    expect(rendered.container.textContent).toContain('larger')
    expect(rendered.container.querySelector('button[aria-label="Open smaller"]')).toBeNull()
    expect(rendered.container.textContent).not.toContain('could not render')
  })

  it('keeps overly nested valid JSON recoverable with a deliberate limit message', async () => {
    const source = fixture('deep-nesting')
    const save = vi.fn(async () => undefined)
    rendered = await renderComponent(<JSONContent content={source} onSave={save} />)
    const details = Array.from(rendered.container.querySelectorAll('button')).find((button) => button.getAttribute('aria-label')?.includes('Click for details'))!
    await act(async () => { details.click() })
    expect(document.body.textContent).toContain('supported nesting limit of 512')
    expect(rendered.container.textContent).not.toContain('Maximum call stack')
    expect(sourceEditor(rendered.container).state.doc.toString()).toBe(source)
    expect(save).not.toHaveBeenCalled()
  })
})
