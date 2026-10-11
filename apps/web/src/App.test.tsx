import { act, useState, type ReactNode } from 'react'
import { IDBFactory } from 'fake-indexeddb'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import { embedJsonViewMetadata } from './document-model.js'
import * as documentModel from './document-model.js'
import * as browserWorkspace from './browser-workspace.js'
import type { JsonViewsPresentationState } from '@script-it/json-views-react'
import { createShareLink, readShareHash } from './share-link.js'
import { formatJsonSource } from '@script-it/json-views-core'
import { analytics } from './analytics.js'
import { readFileSync } from 'node:fs'

const viewerProbe = vi.hoisted(() => ({ device: 'desktop' as 'mobile' | 'desktop', commit: undefined as ((source: string) => Promise<void>) | undefined }))

// Host tests keep document persistence and exercise the embedded source control
// through a small package stand-in.
vi.mock('@script-it/json-views-react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@script-it/json-views-react')>(),
  useJsonViewsDevice: () => viewerProbe.device,
  JsonViewsProvider: ({ children }: { children: ReactNode }) => children,
  createDefaultWidgetRegistry: () => ({ register: () => ({}) }),
  InlineFeedbackAction: ({ ariaLabel, disabled, feedback, icon, label, onClick, title }: { ariaLabel?: string; disabled?: boolean; feedback?: string; icon: ReactNode; label: string; onClick: () => void; title?: string }) => (
    <button type="button" aria-label={ariaLabel ?? label} aria-live="polite" disabled={disabled} title={title} onClick={onClick}>
      {icon}<span>{feedback}</span>
    </button>
  ),
  JSONContent: ({ content, edit, isDirty, isSaving, onRequestMetadataPersistence, onPresentationStateChange, onSourceVisibleChange, presentationState, renderMarkdown, saveError, sourceVisible }: { content: string; edit: { onCommitContent: (next: string) => Promise<void>; onEditChange: (next: string) => void }; isDirty?: boolean; isSaving?: boolean; onRequestMetadataPersistence?: (request: unknown) => Promise<boolean>; onPresentationStateChange?: (state: JsonViewsPresentationState) => void; onSourceVisibleChange?: (visible: boolean) => void; presentationState?: JsonViewsPresentationState; renderMarkdown?: (content: string) => ReactNode; saveError?: string; sourceVisible?: boolean }) => {
    const [mountedSource] = useState(content)
    viewerProbe.commit = edit.onCommitContent
    return (
    <div>
      {sourceVisible
        ? <div data-testid="source-view">
            <button type="button" onClick={() => edit.onEditChange(formatJsonSource(content))}>Format</button>
            <span role="status">{saveError ? 'Save failed' : isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Saved'}</span>
            <button type="button" aria-label="Hide JSON source" aria-pressed="true" onClick={() => onSourceVisibleChange?.(false)} />
            <textarea aria-label="JSON source" value={content} onChange={(event) => edit.onEditChange(event.target.value)} />
          </div>
        : <pre data-testid="viewer-source">{content}</pre>}
      {!sourceVisible && <button type="button" aria-label="Show JSON source" aria-pressed="false" onClick={() => onSourceVisibleChange?.(true)} />}
      <output data-testid="viewer-mounted-source" hidden>{mountedSource}</output>
      <output data-testid="presentation-view">{presentationState?.activeView}</output>
      {renderMarkdown?.('## Markdown heading\n\n**Bold** and ~~removed~~\n\n<span>Embedded HTML</span>\n\n<svg viewBox="0 0 100 100" role="img" aria-label="Diagram"><circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-width="2"></circle><text x="50" y="50" text-anchor="middle">Diagram</text></svg>\n\n<a href="javascript:alert(1)">Unsafe link</a><script>alert("unsafe")</script>')}
      <button type="button" onClick={() => { void edit.onCommitContent(content.replace('99', '100')).catch(() => undefined) }}>Simulate visual edit</button>
      {onPresentationStateChange && <button type="button" onClick={() => onPresentationStateChange({ version: 1, activeView: 'view:remembered' })}>Simulate view selection</button>}
      {onRequestMetadataPersistence && <button type="button" onClick={() => { void onRequestMetadataPersistence({
        reason: 'save-view', sourceFormat: 'json-array', proposedFilename: 'array.json',
        convertedSource: '{"$jsonviews":{"version":1,"schema":{},"views":[]},"data":[]}',
      }) }}>Request conversion</button>}
    </div>
  )},
  CSVContent: ({ content, edit, isDirty, isSaving, onRequestMetadataPersistence, onSourceVisibleChange, saveError, sourceVisible }: { content: string; edit: { onCommitContent: (next: string) => Promise<void>; onEditChange: (next: string) => void }; isDirty?: boolean; isSaving?: boolean; onRequestMetadataPersistence?: (request: unknown) => Promise<boolean>; onSourceVisibleChange?: (visible: boolean) => void; saveError?: string; sourceVisible?: boolean }) => (
    <div>
      {sourceVisible
        ? <div data-testid="source-view">
            <span role="status">{saveError ? 'Save failed' : isSaving ? 'Saving…' : isDirty ? 'Unsaved changes' : 'Saved'}</span>
            <button type="button" aria-label="Hide CSV source" aria-pressed="true" onClick={() => onSourceVisibleChange?.(false)} />
            <textarea aria-label="CSV source" value={content} onChange={(event) => edit.onEditChange(event.target.value)} />
          </div>
        : <pre data-testid="viewer-source">{content}</pre>}
      {!sourceVisible && <button type="button" aria-label="Show CSV source" aria-pressed="false" onClick={() => onSourceVisibleChange?.(true)} />}
      <button type="button" onClick={() => { void edit.onCommitContent(content.replace('Ada', 'Grace')).catch(() => undefined) }}>Simulate CSV edit</button>
      {onRequestMetadataPersistence && <button type="button" onClick={() => { void onRequestMetadataPersistence({
        reason: 'save-view', sourceFormat: 'csv', proposedFilename: 'people.json',
        convertedSource: '{"$jsonviews":{"version":1,"schema":{},"views":[]},"data":[{"id":"001","name":"Ada"}]}',
      }) }}>Request CSV conversion</button>}
    </div>
  ),
}))

let root: Root
let container: HTMLDivElement
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

function jsonResponse(content: string, revision = 'revision-1', filename = 'original.json') {
  return new Response(JSON.stringify({ content, revision, filename }), { headers: { 'content-type': 'application/json' } })
}

async function mount(token?: string, hash = '') {
  history.replaceState(null, '', `${token ? `/?token=${token}` : '/'}${hash}`)
  await act(async () => { root.render(<App />) })
}

async function button(label: string) {
  const target = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  expect(target, `button ${label}`).toBeDefined()
  await act(async () => { target!.click() })
}

async function upload(name: string, text: string | Promise<string>) {
  const input = container.querySelector('input[type=file]')!
  Object.defineProperty(input, 'files', { value: [{ name, text: () => Promise.resolve(text) }], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

async function changeSource(source: string) {
  const textarea = container.querySelector('textarea')!
  expect(textarea).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, source)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function waitForAutoSave() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 325)) })
}

function displayedSource() {
  return container.querySelector('textarea')?.value ?? container.querySelector('[data-testid="viewer-source"]')?.textContent
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

async function mountExampleWorkspace() {
  vi.mocked(browserWorkspace.writeBrowserWorkspace).mockRestore()
  vi.stubGlobal('indexedDB', new IDBFactory())
  sessionStorage.clear()
  vi.stubEnv('MODE', 'development')
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('manifest.json')) return Response.json([
      { sourceFile: 'about.json', annotationFile: 'about.annotations.json', title: 'About' },
      { sourceFile: 'tasks.json', annotationFile: 'tasks.annotations.json', title: 'Tasks' },
    ])
    if (url.endsWith('.annotations.json')) return Response.json({
      version: 1,
      schema: { '$.rows[*].audience': { type: 'multi-select', options: ['Agents'], optionColors: { Agents: 'purple' } } },
      views: [{ id: 'table', name: 'Table', path: '$.rows', display: 'table' }],
    })
    return new Response('{"rows":[{"name":"Original","audience":["Agents"]}]}')
  })
  await mount()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)) })
  expect(displayedSource()).toContain('Original')
}

beforeEach(() => {
  vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
  viewerProbe.device = 'desktop'
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete (document as Document & { modelContext?: unknown }).modelContext
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('document host', () => {
  it.each(['option color', 'cell value', 'view settings', 'raw source'] as const)('persists example %s edits and restores one saved document after reopening', async (kind) => {
    await mountExampleWorkspace()
    await waitForAutoSave()
    expect((await browserWorkspace.readBrowserWorkspace())?.documents).toEqual([])
    const original = displayedSource()!
    const changed = JSON.parse(original)
    if (kind === 'option color') changed.$jsonviews.schema['$.rows[*].audience'].optionColors.Agents = 'green'
    else if (kind === 'view settings') changed.$jsonviews.views[0].name = 'Renamed table'
    else changed.rows[0].name = 'Edited'
    const source = JSON.stringify(changed)
    if (kind === 'raw source') {
      await button('Show JSON source')
      await changeSource(source)
      await waitForAutoSave()
    } else {
      await act(async () => { await viewerProbe.commit!(source) })
    }
    const saved = await browserWorkspace.readBrowserWorkspace()
    expect(saved?.documents).toHaveLength(1)
    expect(saved?.documents[0]).toMatchObject({ id: 'example:about.json', content: source, initialContent: original })
    expect(saved?.activeDocumentIndex).toBe(0)
    expect(saved?.activeTemplateFilename).toBeUndefined()

    await act(async () => root.unmount())
    sessionStorage.clear() // Closing a tab also discards its presentation backup.
    root = createRoot(container)
    await mount()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)) })
    expect(displayedSource()).toBe(source)
    expect(container.querySelectorAll('button[aria-label="Open about.json"]')).toHaveLength(1)
    expect(window.jsonViews!.list().filter((document) => document.id === 'example:about.json')).toHaveLength(1)
    expect(window.jsonViews!.source('example:about.json')).toBe(source)
    await button('Open tasks.json')
    expect(displayedSource()).toContain('Original')
    await button('Open about.json')
    expect(displayedSource()).toBe(source)
  })

  it('reports failed example saves and retains the draft for retry', async () => {
    await mountExampleWorkspace()
    const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockRejectedValue(new Error('Storage full'))
    const changed = displayedSource()!.replace('Original', 'Edited')
    await act(async () => { await expect(viewerProbe.commit!(changed)).rejects.toThrow('Storage full') })
    expect(displayedSource()).toBe(changed)
    expect(container.textContent).toContain('Storage full')
    expect((await browserWorkspace.readBrowserWorkspace())?.documents ?? []).toEqual([])
    write.mockRestore()
    await act(async () => { await viewerProbe.commit!(changed) })
    expect((await browserWorkspace.readBrowserWorkspace())?.documents[0].content).toBe(changed)
  })

  it('adopts an example first saved by another tab before applying local edits', async () => {
    await mountExampleWorkspace()
    await button('Show JSON source')
    await waitForAutoSave()
    const base = (await browserWorkspace.readBrowserWorkspace())!
    const original = displayedSource()!
    const remote = original.replace('Original', 'Remote edit')
    await act(async () => {
      await browserWorkspace.writeBrowserWorkspace({ ...base, documents: [{
        id: 'example:about.json', filename: 'about.json', initialContent: original, content: remote,
      }] }, base)
    })
    await focusAndFlush()
    expect(displayedSource()).toBe(remote)
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(container.querySelectorAll('button[aria-label="Open about.json"]')).toHaveLength(1)
    const changed = JSON.parse(remote)
    changed.$jsonviews.schema['$.rows[*].audience'].optionColors.Agents = 'green'
    await act(async () => { await viewerProbe.commit!(JSON.stringify(changed)) })
    const saved = JSON.parse((await browserWorkspace.readBrowserWorkspace())!.documents[0].content)
    expect(saved.rows[0].name).toBe('Remote edit')
    expect(saved.$jsonviews.schema['$.rows[*].audience'].optionColors.Agents).toBe('green')
  })

  it('enables safe GitHub-flavored Markdown with embedded HTML for record bodies', async () => {
    await mount()

    expect(container.querySelector('.json-views-markdown h2')?.textContent).toBe('Markdown heading')
    expect(container.querySelector('.json-views-markdown strong')?.textContent).toBe('Bold')
    expect(container.querySelector('.json-views-markdown del')?.textContent).toBe('removed')
    expect(Array.from(container.querySelectorAll('.json-views-markdown span')).some((span) => span.textContent === 'Embedded HTML')).toBe(true)
    expect(container.querySelector('.json-views-markdown svg')?.getAttribute('viewBox')).toBe('0 0 100 100')
    expect(container.querySelector('.json-views-markdown circle')?.getAttribute('stroke')).toBe('currentColor')
    expect(container.querySelector('.json-views-markdown svg')?.getAttribute('aria-label')).toBe('Diagram')
    expect(container.querySelector('.workspace .json-views-markdown a')?.hasAttribute('href')).toBe(false)
    expect(container.querySelector('.json-views-markdown script')).toBeNull()
  })

  it('labels the public editor as beta in the product header', async () => {
    await mount()

    expect(container.querySelector('.beta-badge')?.textContent).toBe('Beta')
    expect(container.querySelector('.brand')?.getAttribute('aria-label')).toBe('JSON Views beta home')
  })

  it('collapses and restores the left sidebar while preserving the preference', async () => {
    await mount()

    const sidebar = container.querySelector('#document-sidebar') as HTMLElement
    expect(sidebar.hidden).toBe(false)
    await button('Hide left sidebar')
    expect(sidebar.hidden).toBe(true)
    expect(container.querySelector('button[aria-label="Show left sidebar"]')?.getAttribute('aria-expanded')).toBe('false')
    expect(localStorage.getItem('json-views-sidebar-collapsed')).toBe('true')

    await button('Show left sidebar')
    expect(sidebar.hidden).toBe(false)
    expect(container.querySelector('button[aria-label="Hide left sidebar"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(localStorage.getItem('json-views-sidebar-collapsed')).toBe('false')
  })

  it('embeds representative annotations and rebases root arrays into a data property', () => {
    const source = '[{"name":"Ada"}]'
    const annotation = {
      version: 1,
      schema: { '$[*].name': { type: 'text' } },
      views: [{ id: 'people', name: 'People', path: '$', columns: [{ label: 'Name', path: '$[*].name' }] }],
    }
    expect(JSON.parse(embedJsonViewMetadata(source, annotation))).toEqual({
      $jsonviews: {
        version: 1,
        schema: { '$.data[*].name': { type: 'text' } },
        views: [{ id: 'people', name: 'People', path: '$.data', columns: [{ label: 'Name', path: '$.data[*].name' }] }],
      },
      data: [{ name: 'Ada' }],
    })
  })

  it('uses a closed mobile drawer without overwriting the desktop sidebar preference', async () => {
    viewerProbe.device = 'mobile'
    const prototype = HTMLDialogElement.prototype
    const originalShowModal = prototype.showModal
    const originalClose = prototype.close
    prototype.showModal = function () { this.open = true }
    prototype.close = function () { this.open = false }
    try {
      localStorage.setItem('json-views-sidebar-collapsed', 'false')
      await mount()
      const drawer = container.querySelector<HTMLDialogElement>('#document-sidebar')!
      expect(drawer.open).toBe(false)
      await button('Show left sidebar')
      expect(drawer.open).toBe(true)
      await button('Create JSON document')
      expect(drawer.open).toBe(false)
      expect(localStorage.getItem('json-views-sidebar-collapsed')).toBe('false')
      await act(async () => { viewerProbe.device = 'desktop'; root.render(<App />) })
      expect(container.querySelector('#document-sidebar')?.tagName).toBe('ASIDE')
      expect((container.querySelector('#document-sidebar') as HTMLElement).hidden).toBe(false)
    } finally {
      prototype.showModal = originalShowModal
      prototype.close = originalClose
    }
  })

  it('keeps added JSON documents in a sidebar and restores each document independently', async () => {
    const workspaceWrite = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace')
    await mount()
    await upload('alpha.json', '{"name":"Alpha"}')
    await upload('beta.json', '{"name":"Beta"}')

    expect(container.querySelector('button[aria-label="Open untitled.json"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open alpha.json"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open beta.json"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open alpha.json"] .lucide-braces')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open alpha.json"] span')?.textContent).toBe('alpha')

    await act(async () => { (container.querySelector('button[aria-label="Open alpha.json"]') as HTMLButtonElement).click() })
    expect(container.querySelector('.document-title strong')?.textContent).toBe('alpha.json')
    await button('Show JSON source')
    expect(displayedSource()).toBe('{"name":"Alpha"}')
    await button('Hide JSON source')
    await button('Simulate view selection')
    await act(async () => { (container.querySelector('button[aria-label="Open beta.json"]') as HTMLButtonElement).click() })
    expect(container.querySelector('textarea')).toBeNull()
    expect(container.querySelector('[data-testid="presentation-view"]')?.textContent).toBe('root')
    await act(async () => { (container.querySelector('button[aria-label="Open alpha.json"]') as HTMLButtonElement).click() })
    expect(container.querySelector('[data-testid="presentation-view"]')?.textContent).toBe('root')
    await button('Show JSON source')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 140)) })
    expect(workspaceWrite.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      activeDocumentIndex: 1,
      documents: expect.arrayContaining([
        expect.objectContaining({
          filename: 'alpha.json',
          mode: 'source',
          presentationState: { version: 1, activeView: 'root' },
        }),
      ]),
    }))
  })

  it('opens the Agent Guide from the sidebar and copies its local and public website instructions', async () => {
    const previousClipboard = navigator.clipboard
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await mount()
      const guide = container.querySelector<HTMLAnchorElement>('.sidebar-actions a')!
      expect(guide.textContent?.trim()).toBe('Agent Guide')
      expect(guide.getAttribute('href')).toBe('./agent-prompt.md')
      expect(guide.getAttribute('aria-label')).toContain('window.jsonViews.help()')
      expect(container.querySelector('.sidebar-footer-actions button')?.getAttribute('aria-label')).toBe('Settings')
      expect(container.querySelector('.sidebar-footer-actions button[title="Upload JSON or CSV files"]')?.textContent?.trim()).toBe('Upload')
      const dialog = container.querySelector('dialog')!
      // jsdom lacks native dialog methods; keyboard/focus behavior is checked in the browser.
      dialog.showModal = () => { dialog.open = true }
      dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new Event('close')) }
      await act(async () => { guide.click() })

      expect(dialog.open).toBe(true)
      expect(writeText).not.toHaveBeenCalled()
      expect(dialog.querySelector('a[href="https://github.com/script-it/json-views"]')).not.toBeNull()
      expect(dialog.querySelector('a[href="https://github.com/script-it/json-views/tree/main/skills/json-views"]')).not.toBeNull()
      await button('Copy prompt')

      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('AI agents can use json-views.com'))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('json-views.com—a client-only app—through WebMCP'))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('WebMCP or its JavaScript API (`window.jsonViews.help()`)'))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Or run the [open-source app]'))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Consider installing its [agent skill]'))
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('https://github.com/script-it/json-views/tree/main/skills/json-views'))
      expect(dialog.textContent).toContain('Copied prompt')
      await button('Close Agent Guide')
      expect(dialog.open).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
    }
  })

  it('lets the user disable analytics from the cog menu and preserves the preference', async () => {
    const track = vi.spyOn(analytics, 'track').mockResolvedValue(true)
    await mount()

    await button('Settings')
    const dialog = container.querySelector('[role="dialog"]')
    const toggle = container.querySelector('input[role="switch"][aria-label="Allow anonymous analytics"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(dialog?.textContent).toContain('This website sends an optional small number of anonymous events so we know how to make it better.')
    expect(dialog?.querySelector('p strong u')?.textContent).toBe('optional')
    expect(dialog?.textContent).not.toContain('RudderStack')
    expect(dialog?.textContent).not.toContain('What is sent:')
    expect(dialog?.textContent).toContain('We never collect')
    expect(dialog?.textContent).toContain('saved only in this browser')
    expect(dialog?.textContent).toContain('one final anonymous disabled event')
    expect(dialog?.querySelector('.settings-option')?.compareDocumentPosition(dialog.querySelector('.settings-dialog-copy')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    await act(async () => { toggle.click() })
    expect(toggle.checked).toBe(false)
    expect(localStorage.getItem('json-views-analytics-enabled')).toBe('false')
    expect(track).toHaveBeenCalledWith('json_views_analytics_disabled', { interface: 'ui' })

    await act(async () => { toggle.click() })
    expect(toggle.checked).toBe(true)
    expect(track).toHaveBeenCalledWith('json_views_analytics_enabled', { interface: 'ui' })
    track.mockRestore()
  })

  it('classifies UI file creation and editing without sending file data', async () => {
    const track = vi.spyOn(analytics, 'track').mockResolvedValue(true)
    await mount()

    await button('Create JSON document')
    await upload('private.json', '{"value":99}')
    await button('Simulate visual edit')
    await button('Show JSON source')
    await changeSource('{"value":101}')
    await waitForAutoSave()

    expect(track).toHaveBeenCalledWith('json_views_document_created', expect.objectContaining({ interface: 'ui', method: 'blank', storage: 'browser' }))
    expect(track).toHaveBeenCalledWith('json_views_document_opened', expect.objectContaining({ format: 'json', interface: 'ui', method: 'upload', storage: 'browser' }))
    expect(track).toHaveBeenCalledWith('json_views_document_edited', expect.objectContaining({ edit_method: 'visual', interface: 'ui', storage: 'browser' }))
    expect(track).toHaveBeenCalledWith('json_views_document_edited', expect.objectContaining({ edit_method: 'source', interface: 'ui', storage: 'browser' }))
    for (const [, properties] of track.mock.calls) {
      expect(properties).not.toHaveProperty('content')
      expect(properties).not.toHaveProperty('filename')
      expect(properties).not.toHaveProperty('url')
    }
    track.mockRestore()
  })

  it('explains first-time sharing, remembers it, and copies the active document exactly', async () => {
    const previousClipboard = navigator.clipboard
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await mount()
      const source = '{ "id":9007199254740993,"emoji":"🏔️" }\r\n'
      await upload('shared.json', source)
      expect(container.querySelector('button[aria-label="Copy share link for shared.json"]')?.textContent?.trim()).toBe('')
      await button('Copy share link for shared.json')

      const explainer = container.querySelector('[role="dialog"]')
      expect(explainer?.textContent).toContain('How sharing works')
      expect(explainer?.textContent).toContain('does not upload your file')
      expect(explainer?.textContent).toContain('embeds the data directly in the share URL')
      expect(explainer?.textContent).toContain('Treat the link like the file itself')
      expect(explainer?.textContent).toContain('Anyone with the link can read its contents')
      expect(explainer?.textContent).toContain('Changes you make later will not update it')
      expect(writeText).not.toHaveBeenCalled()
      expect(localStorage.getItem('json-views-share-explainer-seen')).toBeNull()

      await button('Copy share link')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

      expect(writeText).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem('json-views-share-explainer-seen')).toBe('true')
      const sharedUrl = new URL(writeText.mock.calls[0][0])
      expect(sharedUrl.origin).toBe('https://json-views.com')
      expect(sharedUrl.search).toBe('')
      await expect(readShareHash(sharedUrl.hash)).resolves.toEqual({ filename: 'shared.json', source })
      expect(container.querySelector('button[aria-label="Copied share link for shared.json"]')?.textContent?.trim()).toBe('Link copied')

      await button('Copied share link for shared.json')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(container.querySelector('[role="dialog"]')).toBeNull()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
    }
  })

  it('opens shared JSON as a new active browser document without replacing the existing workspace', async () => {
    vi.spyOn(browserWorkspace, 'readBrowserWorkspace').mockResolvedValue({
      version: 1,
      activeDocumentIndex: 0,
      documents: [{ id: 'existing', filename: 'existing.json', content: '{"existing":true}', initialContent: '{"existing":true}' }],
    })
    const source = '{"shared":true,"message":"hello"}\n'
    const shared = await createShareLink({ filename: 'from-a-friend.json', source })

    await mount(undefined, new URL(shared.url).hash)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

    expect(container.querySelector('.document-title strong')?.textContent).toBe('from-a-friend.json')
    expect(displayedSource()).toBe(source)
    expect(container.querySelector('button[aria-label="Open existing.json"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open from-a-friend.json"]')).not.toBeNull()
  })

  it('explains and dismisses an invalid share link without sending the user to source', async () => {
    await mount(undefined, '#json=v1.g.invalid')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

    const alert = container.querySelector('.document-error')
    expect(alert?.textContent).toContain('This share link is incomplete or invalid.')
    expect(alert?.textContent).toContain('Ask the sender to create a new link, or share the file directly.')
    expect(alert?.textContent).not.toContain('Open source')

    await button('Dismiss')
    expect(container.querySelector('.document-error')).toBeNull()
  })

  it('creates a native starter table from the sidebar plus button', async () => {
    await mount()
    await button('Create JSON document')

    expect(container.querySelector('.document-title strong')?.textContent).toBe('untitled-2.json')
    expect(container.querySelector('textarea')).toBeNull()
    const created = JSON.parse(displayedSource() ?? '{}')
    expect(created.rows).toEqual([
      { name: '', done: false },
      { name: '', done: false },
      { name: '', done: false },
    ])
    expect(created.$jsonviews.views[0]).toMatchObject({ name: 'Table', path: '$.rows' })
    expect(created.$jsonviews.schema['$.rows[*].done']).toMatchObject({ type: 'checkbox', title: 'Done' })
  })

  it('opens and edits CSV without converting its source', async () => {
    await mount()
    await upload('people.csv', 'id,name\r\n001,Ada\r\n')
    expect(container.querySelector('button[aria-label="Open people.csv"] .lucide-table-2')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Open people.csv"] span')?.textContent).toBe('people')
    expect(displayedSource()).toBe('id,name\r\n001,Ada\r\n')
    await button('Simulate CSV edit')
    expect(displayedSource()).toBe('id,name\r\n001,Grace\r\n')
    await button('Show CSV source')
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('CSV source')
    expect(Array.from(container.querySelectorAll('button')).some((item) => item.textContent === 'Format')).toBe(false)
  })

  it('copies a CSV share link that preserves the exact source', async () => {
    const previousClipboard = navigator.clipboard
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      localStorage.setItem('json-views-share-explainer-seen', 'true')
      await mount()
      const source = '\ufeffid,name\r\n001,"Ada, Lovelace"\r\n'
      await upload('people.csv', source)
      await button('Copy share link for people.csv')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

      expect(writeText).toHaveBeenCalledTimes(1)
      const sharedUrl = new URL(writeText.mock.calls[0][0])
      expect(sharedUrl.hash).toMatch(/^#csv=v1\.g\./)
      await expect(readShareHash(sharedUrl.hash)).resolves.toEqual({ filename: 'people.csv', source })
      expect(container.querySelector('button[aria-label="Copied share link for people.csv"]')).not.toBeNull()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
    }
  })

  it('prevents copying an unreliable share link and offers the file instead', async () => {
    const previousClipboard = navigator.clipboard
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:download' }
      static revokeObjectURL() {}
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      localStorage.setItem('json-views-share-explainer-seen', 'true')
      await mount()
      let state = 123456789
      const values = Array.from({ length: 12_000 }, () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state.toString(36).padStart(7, '0')
      })
      await upload('large.json', JSON.stringify(values))
      await button('Copy share link for large.json')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

      const dialog = container.querySelector('[role="dialog"]')
      expect(dialog?.textContent).toContain('This file is too large to share as a link')
      expect(dialog?.textContent).toContain('embed the file itself in the URL')
      expect(dialog?.textContent).toContain('No data is uploaded to or stored on a server')
      expect(dialog?.textContent).toContain('messaging apps or browsers may truncate')
      expect(dialog?.textContent).toContain('share it directly instead')
      expect(writeText).not.toHaveBeenCalled()

      await button('Download file')
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
      expect(writeText).not.toHaveBeenCalled()
      expect(container.querySelector('[role="dialog"]')).toBeNull()
      expect(container.querySelector('button[aria-label="Downloaded large.json"]')?.textContent?.trim()).toBe('Download starting')
    } finally {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: previousClipboard })
    }
  })

  it('preserves CSV and creates a JSON copy after confirming view metadata conversion', async () => {
    await mount()
    await upload('people.csv', 'id,name\r\n001,Ada\r\n')
    await button('Request CSV conversion')

    const dialog = container.querySelector('[role="dialog"]')
    expect(dialog?.querySelector('[data-id="conversion-current-filename"]')?.textContent).toBe('people.csv')
    expect(dialog?.querySelector('[data-id="conversion-proposed-filename"]')?.textContent).toBe('people.json')
    expect(dialog?.textContent).toContain('Current · CSV')
    expect(dialog?.textContent).toContain('New · Object-root JSON')
    expect(dialog?.textContent).toContain('The original CSV is always preserved.')
    expect(Array.from(dialog?.querySelectorAll('button') ?? []).some((item) => item.textContent === 'Replace original')).toBe(false)
    await button('Create JSON copy')

    expect(container.querySelector('.document-title')?.textContent).toBe('people.json')
    expect(displayedSource()).toContain('$jsonviews')
    expect(container.querySelector('button[aria-label="Open people.csv"]')).not.toBeNull()
  })

  it('cancels conversion without changing the source and creates a separate JSON document on confirmation', async () => {
    await mount()
    await upload('array.json', '[{"name":"Ada"}]')
    await button('Request conversion')
    const firstDialog = container.querySelector('[role="dialog"]')
    expect(firstDialog?.querySelector('[data-id="conversion-current-filename"]')?.textContent).toBe('array.json')
    expect(firstDialog?.querySelector('[data-id="conversion-proposed-filename"]')?.textContent).toBe('array-2.json')
    expect(firstDialog?.textContent).toContain('Current · JSON array')
    await button('Cancel')
    expect(displayedSource()).toBe('[{"name":"Ada"}]')
    await button('Request conversion')
    await button('Create JSON copy')
    expect(container.querySelector('.document-title strong')?.textContent).toBe('array-2.json')
    expect(displayedSource()).toContain('$jsonviews')
    expect(container.querySelector('button[aria-label="Open array.json"]')).not.toBeNull()
  })

  it('exposes document creation, reading, editing, selection, and removal to the browser console', async () => {
    await mount()
    expect(window.jsonViews?.version).toBe(1)
    const guide = readFileSync('../../skills/json-views/SKILL.md', 'utf8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n\s*/, '')
      .replace(/\]\(references\/(?:jsonviews|html-views)\.md(#[^)]+)\)/g, ']($1)')
    const nuances = readFileSync('../../skills/json-views/references/jsonviews.md', 'utf8')
    const htmlReference = readFileSync('../../skills/json-views/references/html-views.md', 'utf8')
    expect(window.jsonViews?.help()).toBe(`${guide.trimEnd()}\n\n${nuances.trimEnd()}\n\n${htmlReference}`)

    let createdId = ''
    await act(async () => {
      createdId = (await window.jsonViews!.create('tasks.json', { tasks: [{ done: false, title: 'Ship' }] })).id
    })
    expect(window.jsonViews!.list().find((document) => document.id === createdId)).toMatchObject({
      active: true,
      filename: 'tasks.json',
      storage: 'browser',
      valid: true,
    })
    expect(window.jsonViews!.get(createdId)).toEqual({ tasks: [{ done: false, title: 'Ship' }] })

    await act(async () => {
      await window.jsonViews!.patch(createdId, [
        { op: 'test', path: '/tasks/0/done', value: false },
        { op: 'replace', path: '/tasks/0/done', value: true },
      ])
    })
    expect(window.jsonViews!.get('tasks.json')).toEqual({ tasks: [{ done: true, title: 'Ship' }] })
    expect(displayedSource()).toContain('"done": true')

    let writeResult: unknown
    await act(async () => {
      writeResult = await window.jsonViews!.setSource(createdId, JSON.stringify({
        exact: 'wrong',
        $jsonviews: { version: 1, schema: { '$.exact': { type: 'checkbox' } } },
      }))
    })
    expect(writeResult).toMatchObject({
      valid: true,
      diagnostics: [{
        scope: 'value',
        code: 'invalid-typed-value',
        message: 'Value must be true or false',
        severity: 'error',
        sourcePath: ['exact'],
        metadataPath: ['$jsonviews', 'schema', '$.exact'],
        metadataSource: 'embedded',
        help: {
          expected: expect.stringContaining('JSON boolean'),
          received: '"wrong"',
          examples: [true, false],
          fix: expect.stringContaining('Set'),
        },
      }],
    })
    expect(window.jsonViews!.diagnostics(createdId)).toMatchObject(writeResult as object)
    // Callers own what they receive: modifying it must not change later reads.
    const received = window.jsonViews!.diagnostics(createdId).diagnostics[0] as unknown as { message: string; sourcePath: Array<string | number>; help: { fix: string } }
    received.message = 'changed'
    received.sourcePath[0] = 'other'
    received.help.fix = 'changed'
    expect(window.jsonViews!.diagnostics(createdId).diagnostics[0]).toMatchObject({
      message: 'Value must be true or false',
      sourcePath: ['exact'],
      help: { fix: expect.stringContaining('Set') },
    })
    expect(window.jsonViews!.list({ includeDiagnosticCount: true }).find((document) => document.id === createdId))
      .toMatchObject({ diagnosticCount: 1 })
    await act(async () => { await window.jsonViews!.setSource(createdId, '{"exact":true}\n') })
    expect(window.jsonViews!.source(createdId)).toBe('{"exact":true}\n')
    await act(async () => { window.jsonViews!.select('untitled.json') })
    expect(container.querySelector('.document-title strong')?.textContent).toBe('untitled.json')
    await act(async () => { window.jsonViews!.remove(createdId) })
    expect(window.jsonViews!.list().some((document) => document.id === createdId)).toBe(false)
  })

  it('writes browser console updates through the CLI file connection', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"done":false}'))
    await mount('secret')
    fetchMock.mockResolvedValueOnce(jsonResponse('{\n  "done": true\n}\n', 'revision-2'))

    await act(async () => { await window.jsonViews!.patch('original.json', [{ op: 'replace', path: '/done', value: true }]) })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/document?token=secret')
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
      content: '{"done":true}',
      revision: 'revision-1',
    })
    expect(window.jsonViews!.get('original.json')).toEqual({ done: true })
  })

  it('registers WebMCP tools that manipulate the visible workspace', async () => {
    const track = vi.spyOn(analytics, 'track').mockResolvedValue(true)
    interface RegisteredTool {
      name: string
      execute(input: Record<string, unknown>): unknown | Promise<unknown>
    }
    const tools = new Map<string, RegisteredTool>()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: (tool: RegisteredTool) => { tools.set(tool.name, tool) },
      },
    })

    await mount()
    expect([...tools.keys()]).toEqual([
      'json_views_help',
      'json_views_list_documents',
      'json_views_get_link',
      'json_views_get_document',
      'json_views_get_diagnostics',
      'json_views_create_document',
      'json_views_patch_document',
      'json_views_set_source',
      'json_views_select_document',
      'json_views_delete_document',
    ])
    expect(tools.get('json_views_help')!.execute({})).toBe(window.jsonViews!.help())

    await act(async () => {
      await tools.get('json_views_create_document')!.execute({ filename: 'agent-tasks.json', value: { tasks: [{ done: false }] } })
    })
    const listed = tools.get('json_views_list_documents')!.execute({}) as Array<{ id: string; filename: string }>
    const created = listed.find((item) => item.filename === 'agent-tasks.json')!
    const beforeLink = location.href
    expect(tools.get('json_views_get_link')!.execute({ document: created.id })).toContain('#/files/agent-tasks.json')
    expect(location.href).toBe(beforeLink)

    let patchResult: unknown
    await act(async () => {
      patchResult = await tools.get('json_views_patch_document')!.execute({
        document: created.id,
        patch: [
          { op: 'replace', path: '/tasks/0/done', value: 'yes' },
          { op: 'add', path: '/$jsonviews', value: { version: 1, schema: { '$.tasks[*].done': { type: 'checkbox' } } } },
        ],
      })
    })
    expect(patchResult).toMatchObject({
      valid: true,
      diagnostics: [{
        scope: 'value',
        code: 'invalid-typed-value',
        message: 'Value must be true or false',
        severity: 'error',
        sourcePath: ['tasks', 0, 'done'],
        help: {
          expected: expect.stringContaining('JSON boolean'),
          received: '"yes"',
          examples: [true, false],
        },
      }],
    })
    expect(await tools.get('json_views_get_diagnostics')!.execute({ document: created.id })).toMatchObject(patchResult as object)
    const counted = tools.get('json_views_list_documents')!.execute({ includeDiagnosticCount: true }) as Array<{ id: string; diagnosticCount?: number }>
    expect(counted.find((document) => document.id === created.id)?.diagnosticCount).toBe(1)
    expect(await tools.get('json_views_get_document')!.execute({ document: created.id })).toMatchObject({ tasks: [{ done: 'yes' }] })

    await act(async () => {
      await tools.get('json_views_set_source')!.execute({ document: created.id, source: '{"exact":true}\n' })
    })
    expect(await tools.get('json_views_get_document')!.execute({ document: created.id, format: 'source' })).toBe('{"exact":true}\n')
    await act(async () => { await tools.get('json_views_select_document')!.execute({ document: 'untitled.json' }) })
    expect(container.querySelector('.document-title strong')?.textContent).toBe('untitled.json')
    await act(async () => { await tools.get('json_views_delete_document')!.execute({ document: created.id }) })
    expect((tools.get('json_views_list_documents')!.execute({}) as Array<{ id: string }>).some((item) => item.id === created.id)).toBe(false)
    window.jsonViews!.list()

    expect(track).toHaveBeenCalledWith('json_views_document_created', expect.objectContaining({ interface: 'webmcp', method: 'api', storage: 'browser' }))
    expect(track).toHaveBeenCalledWith('json_views_document_edited', expect.objectContaining({ edit_method: 'patch', interface: 'webmcp' }))
    expect(track).toHaveBeenCalledWith('json_views_document_edited', expect.objectContaining({ edit_method: 'source', interface: 'webmcp' }))
    expect(track).toHaveBeenCalledWith('json_views_document_deleted', expect.objectContaining({ interface: 'webmcp' }))
    expect(track).toHaveBeenCalledWith('json_views_document_read', expect.objectContaining({ interface: 'webmcp', read_method: 'list' }))
    expect(track).toHaveBeenCalledWith('json_views_document_read', expect.objectContaining({ interface: 'webmcp', read_method: 'parsed' }))
    expect(track).toHaveBeenCalledWith('json_views_document_read', expect.objectContaining({ interface: 'console', read_method: 'list' }))
    track.mockRestore()
  })

  it.each([
    ['bad.json', '{"rows":[}'],
    ['empty.json', ''],
  ])('saves arbitrary source text for %s and reports its JSON diagnostic', async (filename, invalid) => {
    const tools = new Map<string, { execute(input: Record<string, unknown>): unknown }>()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool: (tool: { name: string; execute(input: Record<string, unknown>): unknown }) => { tools.set(tool.name, tool) } },
    })
    await mount()
    await upload(filename, '{"kept":true}')
    const saved = await tools.get('json_views_set_source')!.execute({ document: filename, source: invalid })
    expect(saved).toMatchObject({ valid: false, diagnostics: [{ scope: 'source', code: 'invalid-json', severity: 'error' }] })
    expect(window.jsonViews!.source(filename)).toBe(invalid)
    expect(displayedSource()).toBe(invalid)
    await expect(tools.get('json_views_set_source')!.execute({ document: 'missing-document', source: invalid })).rejects.toThrow('No JSON document matches')
  })

  it('still rejects invalid CSV source without changing the document', async () => {
    await mount()
    await upload('bad.csv', 'name\nAda\n')
    await expect(window.jsonViews!.setSource('bad.csv', 'name\n"unfinished')).rejects.toMatchObject({
      name: 'JsonViewsSourceValidationError', diagnostics: [{ code: 'invalid-csv' }],
    })
    expect(window.jsonViews!.source('bad.csv')).toBe('name\nAda\n')
  })

  it('returns patch diagnostics and applies no operations when an RFC 6902 patch fails', async () => {
    const tools = new Map<string, { execute(input: Record<string, unknown>): unknown }>()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: { registerTool: (tool: { name: string; execute(input: Record<string, unknown>): unknown }) => { tools.set(tool.name, tool) } },
    })
    await mount()
    const original = window.jsonViews!.source('untitled.json')
    const rejected = await tools.get('json_views_patch_document')!.execute({
      document: 'untitled.json',
      patch: [
        { op: 'add', path: '/temporary', value: true },
        { op: 'test', path: '/missing', value: true },
      ],
    })
    expect(rejected).toMatchObject({
      ok: false,
      saved: false,
      diagnosticTarget: 'submitted-patch',
      diagnostics: [{
        scope: 'patch', code: 'missing-path', severity: 'error', operationIndex: 1, patchPath: '/missing',
        help: { expected: expect.any(String), fix: expect.any(String), capabilities: expect.any(Array) },
      }],
    })
    expect(window.jsonViews!.source('untitled.json')).toBe(original)
    expect(await tools.get('json_views_patch_document')!.execute({ document: 'untitled.json', patch: {} })).toMatchObject({
      ok: false, saved: false, diagnosticTarget: 'submitted-patch', diagnostics: [{ code: 'invalid-patch' }],
    })
    await expect(window.jsonViews!.patch('untitled.json', [{ op: 'replace', path: 'bad', value: true }]))
      .rejects.toMatchObject({ name: 'JsonViewsPatchValidationError', diagnostics: [{ code: 'invalid-pointer' }] })
    expect(window.jsonViews!.source('untitled.json')).toBe(original)
  })

  it('removes a sidebar document and opens the next available document', async () => {
    await mount()
    await upload('alpha.json', '{"name":"Alpha"}')
    await upload('beta.json', '{"name":"Beta"}')
    await act(async () => { (container.querySelector('button[aria-label="Open alpha.json"]') as HTMLButtonElement).click() })
    await act(async () => { (container.querySelector('button[aria-label="Delete alpha.json"]') as HTMLButtonElement).click() })

    expect(container.querySelector('button[aria-label="Open alpha.json"]')).toBeNull()
    expect(container.querySelector('.document-title strong')?.textContent).toBe('beta.json')
    expect(displayedSource()).toBe('{"name":"Beta"}')
  })

  it('keeps document selection and editing isolated after the document module reloads', async () => {
    vi.resetModules()
    const firstModule = await import('./document-model.js')
    const opener = vi.spyOn(documentModel, 'openDocument').mockImplementation(firstModule.openDocument)
    await mount()
    const firstId = window.jsonViews!.list()[0].id
    const original = window.jsonViews!.source(firstId)

    // Model the development hot reload: retain React state, replace only the factory.
    vi.resetModules()
    const reloadedModule = await import('./document-model.js')
    opener.mockImplementation(reloadedModule.openDocument)
    let lastId = ''
    await act(async () => { lastId = (await window.jsonViews!.create('last.json', { marker: 'last' })).id })

    expect(lastId).not.toBe(firstId)
    expect(window.jsonViews!.list().filter((document) => document.active).map((document) => document.id)).toEqual([lastId])
    expect(container.querySelector('.document-title')?.textContent).toBe('last.json')
    expect([...container.querySelectorAll('.document-open[aria-current="page"]')].map((element) => element.getAttribute('aria-label'))).toEqual(['Open last.json'])

    await act(async () => { await window.jsonViews!.patch(lastId, [{ op: 'replace', path: '/marker', value: 'edited last' }]) })
    expect(window.jsonViews!.source(firstId)).toBe(original)
    expect(displayedSource()).toContain('edited last')
    await act(async () => { (container.querySelector('button[aria-label="Open untitled.json"]') as HTMLButtonElement).click() })
    expect(displayedSource()).toBe(original)
    await act(async () => { (container.querySelector('button[aria-label="Open last.json"]') as HTMLButtonElement).click() })
    expect(displayedSource()).toContain('edited last')
    expect(container.querySelectorAll('.document-open[aria-current="page"]')).toHaveLength(1)

    await act(async () => { window.jsonViews!.remove(lastId) })
    expect(window.jsonViews!.list().map((document) => document.id)).toEqual([firstId])
    expect(displayedSource()).toBe(original)
    opener.mockRestore()
  })

  it('imports every source token verbatim and formats only on explicit request', async () => {
    await mount()
    const original = '{ "id":9007199254740993,"huge":1e400,"minusZero":-0,"x":1,"x":2 }\n'
    await upload('numbers.json', original)
    expect(displayedSource()).toBe(original)
    await button('Show JSON source')
    expect(displayedSource()).toBe(original)
    expect(container.querySelector('.document-bar button')?.textContent).not.toBe('Format')
    expect(container.querySelector('[data-testid="source-view"] button')?.textContent).toBe('Format')
    await act(async () => { container.querySelector('textarea')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    expect(displayedSource()).toBe(original)
    expect(fetchMock).not.toHaveBeenCalled()
    await button('Format')
    expect(displayedSource()).toContain('9007199254740993')
    expect(displayedSource()).toContain('1e400')
    expect(displayedSource()).toContain('-0')
    expect(displayedSource()).toContain('"x": 1,\n  "x": 2')
    expect(displayedSource()).not.toBe(original)
  })

  it('downloads the exact imported source, including duplicate keys and numeric spelling', async () => {
    const downloads: Blob[] = []
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL(value: Blob | MediaSource) {
        if (value instanceof Blob) downloads.push(value)
        return 'blob:download'
      }
      static revokeObjectURL() {}
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await mount()
    const original = '{"id":9007199254740993,"huge":1e400,"minusZero":-0,"x":1,"x":2}\r\n'
    await upload('exact.json', original)
    await act(async () => { (container.querySelector('button[aria-label="Download exact.json"]') as HTMLButtonElement).click() })
    expect(downloads).toHaveLength(1)
    expect(container.querySelector('button[aria-label="Downloaded exact.json"]')?.textContent?.trim()).toBe('Download starting')
    const downloaded = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(downloads[0])
    })
    expect(downloaded).toBe(original)
    await new Promise((resolve) => setTimeout(resolve, 1))
  })

  it('detaches Upload from the CLI destination and removes its URL capability', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"original":true}'))
    await mount('secret')
    expect(displayedSource()).toBe('{"original":true}')
    await upload('unrelated.json', '{"value":99}')
    await button('Simulate visual edit')
    expect(displayedSource()).toBe('{"value":100}')
    expect(container.querySelector('.document-title strong')?.textContent).toBe('unrelated.json')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(location.search).toBe('')
    expect(container.querySelector('.status')).toBeNull()
  })

  it('caches uploads from a CLI page while preserving existing browser documents and template state', async () => {
    const stored = {
      version: 1 as const, activeDocumentIndex: 0,
      documents: [{ id: 'existing-id', filename: 'existing.json', content: '{"existing":true}', initialContent: '{"existing":true}' }],
      templateStates: { 'template.json': { mode: 'source' as const } },
    }
    vi.spyOn(browserWorkspace, 'readBrowserWorkspace').mockResolvedValue(stored)
    const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
    fetchMock.mockResolvedValueOnce(jsonResponse('{"original":true}'))
    await mount('secret')
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    expect(write.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ activeDocumentIndex: 0, documents: [expect.objectContaining({ id: 'existing-id' })] }))
    await upload('uploaded.json', '{"value":99}')
    await button('Simulate view selection')
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    expect(write.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      activeDocumentIndex: 1,
      documents: [expect.objectContaining({ id: 'existing-id' }), expect.objectContaining({ filename: 'uploaded.json', presentationState: { version: 1, activeView: 'view:remembered' } })],
      templateStates: stored.templateStates,
    }))
    expect(write.mock.calls.at(-1)?.[0].documents.some((document) => document.filename === 'original.json')).toBe(false)
  })

  it('preserves a browser document created before the CLI workspace cache finishes loading', async () => {
    const cached = deferred<browserWorkspace.CachedBrowserWorkspace>()
    vi.spyOn(browserWorkspace, 'readBrowserWorkspace').mockReturnValue(cached.promise)
    const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
    fetchMock.mockResolvedValueOnce(jsonResponse('{"original":true}'))
    await mount('secret')
    await upload('uploaded.json', '{"uploaded":true}')
    await act(async () => { cached.resolve({ version: 1, activeDocumentIndex: 0, documents: [{ id: 'document-1', filename: 'old.json', content: '{}', initialContent: '{}' }] }) })
    await act(async () => { window.dispatchEvent(new Event('pagehide')) })
    const saved = write.mock.calls.at(-1)![0]
    expect(saved.documents.map((document) => document.filename).sort()).toEqual(['old.json', 'uploaded.json'])
    expect(saved.documents[saved.activeDocumentIndex].filename).toBe('uploaded.json')
    expect(new Set(saved.documents.map((document) => document.id)).size).toBe(2)
  })

  it('allows a captured edit callback after presentation state changes in the same session', async () => {
    await mount()
    await upload('edit.json', '{"value":99}')
    const commit = viewerProbe.commit!
    await button('Simulate view selection')
    await act(async () => { await commit('{"value":100}') })
    expect(displayedSource()).toBe('{"value":100}')
  })

  it('remounts the failed visual editor on an explicit local reload while retaining its cache', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"value":99}'))
    await mount('secret')
    await button('Simulate view selection')
    fetchMock.mockResolvedValueOnce(new Response('The file changed on disk', { status: 409 }))
    await button('Simulate visual edit')
    fetchMock.mockResolvedValueOnce(jsonResponse('{"value":200}', 'revision-2'))
    await button('Reload local file')
    expect(container.querySelector('[data-testid="viewer-mounted-source"]')?.textContent).toBe('{"value":200}')
    expect(container.querySelector('[data-testid="presentation-view"]')?.textContent).toBe('view:remembered')
    expect(container.querySelector('.recovery-notice')?.textContent).toContain('Download previous draft')
  })

  it('keeps invalid uploaded and opened local source recoverable', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"unfinished":'))
    await mount('secret')
    expect(displayedSource()).toBe('{"unfinished":')
    expect(container.querySelector('.document-error')).toBeNull()
    await changeSource('{"fixed":true}')
    fetchMock.mockResolvedValueOnce(jsonResponse('{"fixed":true}', 'revision-2'))
    await waitForAutoSave()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(displayedSource()).toBe('{"fixed":true}')
    await upload('broken.json', '{broken')
    expect(displayedSource()).toBe('{broken')
    expect(container.querySelector('.document-error')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not replace a newer source draft when an older save completes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"value":1}'))
    await mount('secret')
    await button('Show JSON source')
    await changeSource('{"draft":"first"}')
    const save = deferred<Response>()
    fetchMock.mockReturnValueOnce(save.promise)
    await waitForAutoSave()
    expect(container.querySelector('[role=status]')?.textContent).toBe('Saving…')
    await changeSource('{"draft":"second"}')
    await act(async () => { save.resolve(jsonResponse('{"draft":"first"}', 'revision-2')) })
    expect(displayedSource()).toBe('{"draft":"second"}')
    expect(container.querySelector('[role=status]')?.textContent).toBe('Unsaved changes')
    fetchMock.mockResolvedValueOnce(jsonResponse('{"draft":"second"}', 'revision-3'))
    await waitForAutoSave()
    const payload = JSON.parse(fetchMock.mock.calls[2][1]?.body as string)
    expect(payload.revision).toBe('revision-2')
    expect(payload.content).toBe('{"draft":"second"}')
  })

  it('retains failed drafts, reports conflicts, and uses the refreshed revision after reload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"value":1}'))
    await mount('secret')
    await button('Show JSON source')
    await changeSource('{"myEdit":true}')
    fetchMock.mockResolvedValueOnce(new Response('The file changed on disk', { status: 409 }))
    await waitForAutoSave()
    expect(displayedSource()).toBe('{"myEdit":true}')
    expect(container.querySelector('[role=alert]')?.textContent).toContain('file changed')
    fetchMock.mockResolvedValueOnce(jsonResponse('{"external":true}', 'external-revision'))
    await button('Reload local file')
    expect(displayedSource()).toBe('{"external":true}')
    expect(container.querySelector('.recovery-notice')?.textContent).toContain('Download previous draft')
    await changeSource('{"external":true,"mine":true}')
    fetchMock.mockResolvedValueOnce(jsonResponse('{"external":true,"mine":true}', 'revision-3'))
    await waitForAutoSave()
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body as string).revision).toBe('external-revision')
  })

  it('ignores an old local-file load after an upload takes ownership', async () => {
    const load = deferred<Response>()
    fetchMock.mockReturnValueOnce(load.promise)
    await mount('secret')
    await upload('mine.json', '{"uploaded":true}')
    await act(async () => { load.resolve(jsonResponse('{"original":true}')) })
    expect(displayedSource()).toBe('{"uploaded":true}')
    expect(container.querySelector('.document-title strong')?.textContent).toBe('mine.json')
  })

  it('does not replace a different sidebar document when a local reload resolves', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"value":1}'))
    await mount('secret')
    await upload('other.json', '{"other":true}')
    await button('Open original.json')
    await button('Show JSON source')
    fetchMock.mockResolvedValueOnce(new Response('The file changed on disk', { status: 409 }))
    await changeSource('{"draft":true}')
    await waitForAutoSave()
    const reload = deferred<Response>()
    fetchMock.mockReturnValueOnce(reload.promise)
    await button('Reload local file')
    await button('Open other.json')
    await act(async () => { reload.resolve(jsonResponse('{"reloaded":true}')) })
    expect(displayedSource()).toBe('{"other":true}')
    expect(container.querySelector('.document-title strong')?.textContent).toBe('other.json')
    await button('Open original.json')
    expect(displayedSource()).toBe('{"draft":true}')
  })

  it('ignores an old save error after a different document has been opened', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"value":1}'))
    await mount('secret')
    await button('Show JSON source')
    await changeSource('{"pending":true}')
    const save = deferred<Response>()
    fetchMock.mockReturnValueOnce(save.promise)
    await waitForAutoSave()
    await upload('mine.json', '{"uploaded":true}')
    await act(async () => { save.resolve(new Response('Old document save failed', { status: 500 })) })
    expect(displayedSource()).toBe('{"uploaded":true}')
    expect(container.textContent).not.toContain('Old document save failed')
  })

  it('recovers a failed initial connection without reusing the example document destination', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Server temporarily unavailable', { status: 503 }))
    await mount('secret')
    expect(container.querySelector('[role=alert]')?.textContent).toContain('Server temporarily unavailable')
    fetchMock.mockResolvedValueOnce(jsonResponse('{"reconnected":true}'))
    await button('Reload local file')
    expect(displayedSource()).toBe('{"reconnected":true}')
    expect(container.querySelector('.status')).toBeNull()
  })

  it('keeps the most recently chosen upload when file reads complete out of order', async () => {
    await mount()
    const first = deferred<string>()
    await upload('first.json', first.promise)
    await upload('second.json', '{"second":true}')
    await act(async () => { first.resolve('{"first":true}') })
    expect(displayedSource()).toBe('{"second":true}')
    expect(container.querySelector('.document-title strong')?.textContent).toBe('second.json')
  })

  it('keeps source blur read-only and skips unchanged saves', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{ "unchanged": true }\n'))
    await mount('secret')
    await button('Show JSON source')
    await act(async () => { container.querySelector('textarea')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    await waitForAutoSave()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(displayedSource()).toBe('{ "unchanged": true }\n')
    expect(container.querySelector('[role=status]')?.textContent).toBe('Saved')
  })
})


it('rejects early agent writes instead of losing them during workspace restore', async () => {
  const cached = deferred<browserWorkspace.CachedBrowserWorkspace>()
  vi.spyOn(browserWorkspace, 'readBrowserWorkspace').mockReturnValue(cached.promise)
  const shared = await createShareLink({ filename: 'shared.json', source: '{}' })
  await mount(undefined, new URL(shared.url).hash)
  await expect(window.jsonViews!.create('agent.json', { kept: true })).rejects.toThrow('still loading')
  await act(async () => { cached.resolve({ version: 1, activeDocumentIndex: 0, documents: [] }) })
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(container.textContent).not.toContain('Opening shared document…')
  })
  await act(async () => { await window.jsonViews!.create('agent.json', { kept: true }) })
  expect(window.jsonViews!.get('agent.json')).toEqual({ kept: true })
})

it('acknowledges agent creation only after browser storage completes', async () => {
  await mount()
  const storage = deferred<void>()
  const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockImplementation(async (workspace) => { await storage.promise; return { workspace, conflicts: [] } })
  let completed = false
  let result!: Promise<unknown>
  await act(async () => {
    result = window.jsonViews!.create('agent.json', { kept: true }).then(() => { completed = true })
  })
  expect(write).toHaveBeenCalled()
  expect(completed).toBe(false)
  await act(async () => { storage.resolve(); await result })
  expect(completed).toBe(true)
})

it('retains browser edits and reports storage failure until a successful retry', async () => {
  await mount()
  await upload('draft.json', '{"value":1}')
  const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockRejectedValue(new Error('Storage quota exceeded'))
  await act(async () => {
    await expect(window.jsonViews!.setSource('draft.json', '{"value":2}')).rejects.toThrow('Storage quota exceeded')
  })
  expect(window.jsonViews!.source('draft.json')).toBe('{"value":2}')
  expect(container.textContent).toContain('Storage quota exceeded')
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  write.mockImplementation(async (workspace) => ({ workspace, conflicts: [] }))
  await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry browser save')!.click() })
  expect(container.textContent).not.toContain('Storage quota exceeded')
})

async function mountWithBrowserStorage() {
  vi.mocked(browserWorkspace.writeBrowserWorkspace).mockRestore()
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('BroadcastChannel', undefined)
  await browserWorkspace.readBrowserWorkspace()
  await mount()
  await act(async () => { await window.jsonViews!.create('shared.json', { value: 1 }) })
  return (await browserWorkspace.readBrowserWorkspace())!
}

async function focusAndFlush() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    await new Promise((resolve) => setTimeout(resolve, 35))
  })
}

it('refreshes clean documents across tabs while retaining local selection and presentation', async () => {
  const base = await mountWithBrowserStorage()
  await button('Show JSON source')
  const remote = { ...base, documents: base.documents.map((document) => document.filename === 'shared.json'
    ? { ...document, content: '{"value":2}', mode: 'view' as const } : document) }
  remote.documents.push({ id: 'remote-new', filename: 'remote.json', content: '{}', initialContent: '{}' })
  await act(async () => { await browserWorkspace.writeBrowserWorkspace(remote, base) })
  await focusAndFlush()
  expect(displayedSource()).toBe('{"value":2}')
  expect(container.querySelector('textarea')).not.toBeNull()
  expect(window.jsonViews!.list().find((document) => document.filename === 'remote.json')).toBeDefined()
  expect(container.querySelector('.document-title')?.textContent).toContain('shared.json')
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('preserves conflicting source and saves it as a copy without overwriting the remote file', async () => {
  const base = await mountWithBrowserStorage()
  await button('Show JSON source')
  await changeSource('{"draft":true}')
  const remote = { ...base, documents: base.documents.map((document) => document.filename === 'shared.json'
    ? { ...document, content: '{"remote":true}' } : document) }
  await act(async () => { await browserWorkspace.writeBrowserWorkspace(remote, base) })
  await focusAndFlush()
  expect(displayedSource()).toBe('{"draft":true}')
  expect(container.textContent).toContain('Your draft is preserved')
  expect((await browserWorkspace.readBrowserWorkspace())?.documents.find((document) => document.filename === 'shared.json')?.content).toBe('{"remote":true}')
  await button('Save draft as copy')
  await focusAndFlush()
  expect(window.jsonViews!.source('shared.json')).toBe('{"remote":true}')
  expect(window.jsonViews!.source('shared-copy.json')).toBe('{"draft":true}')
  expect(container.textContent).not.toContain('Your draft is preserved')
  expect(container.textContent).toContain('Download previous draft')
  const stored = await browserWorkspace.readBrowserWorkspace()
  expect(stored?.documents.find((document) => document.filename === 'shared-copy.json')?.content).toBe('{"draft":true}')
})

it('loads the saved version after a conflict and permits subsequent editing', async () => {
  const base = await mountWithBrowserStorage()
  await button('Show JSON source')
  await changeSource('{"draft":true}')
  await act(async () => { await browserWorkspace.writeBrowserWorkspace({ ...base, documents: base.documents.map((document) => document.filename === 'shared.json'
    ? { ...document, content: '{"remote":true}' } : document) }, base) })
  await focusAndFlush()
  await button('Use saved version')
  await focusAndFlush()
  expect(displayedSource()).toBe('{"remote":true}')
  expect(container.textContent).toContain('Download previous draft')
  await act(async () => { await window.jsonViews!.setSource('shared.json', '{"resolved":true}') })
  expect((await browserWorkspace.readBrowserWorkspace())?.documents.find((document) => document.filename === 'shared.json')?.content).toBe('{"resolved":true}')
})

it('preserves typing that arrives while a remote update is being loaded', async () => {
  await mount()
  await upload('shared.json', '{"value":1}')
  await button('Show JSON source')
  const pending = deferred<browserWorkspace.BrowserWorkspaceWriteResult>()
  const write = vi.spyOn(browserWorkspace, 'writeBrowserWorkspace').mockReturnValueOnce(pending.promise)
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  const submitted = write.mock.calls.at(-1)![0]
  await changeSource('{"newerDraft":true}')
  await act(async () => { pending.resolve({ workspace: { ...submitted, documents: submitted.documents.map((document) => document.filename === 'shared.json'
    ? { ...document, content: '{"remote":true}', revision: 2 } : document) }, conflicts: [] }) })
  expect(displayedSource()).toBe('{"newerDraft":true}')
  expect(container.textContent).toContain('Your draft is preserved')
})

it('keeps a remotely deleted active document available until the user acknowledges it', async () => {
  const base = await mountWithBrowserStorage()
  await act(async () => { await browserWorkspace.writeBrowserWorkspace({ ...base, documents: base.documents.filter((document) => document.filename !== 'shared.json') }, base) })
  await focusAndFlush()
  expect(window.jsonViews!.source('shared.json')).toBe('{\n  "value": 1\n}\n')
  expect(container.textContent).toContain('deleted in another tab')
  await button('Save draft as copy')
  await focusAndFlush()
  expect(window.jsonViews!.list().some((document) => document.filename === 'shared.json')).toBe(false)
  expect(window.jsonViews!.get('shared-copy.json')).toEqual({ value: 1 })
  expect((await browserWorkspace.readBrowserWorkspace())?.documents.some((document) => document.filename === 'shared.json')).toBe(false)
})

it('keeps the CSV extension when saving repeated conflict copies', async () => {
  await mountWithBrowserStorage()
  await upload('people-copy.csv', 'name\nExisting\n')
  await upload('people.csv', 'name\nAda\n')
  await focusAndFlush()
  const base = (await browserWorkspace.readBrowserWorkspace())!
  await button('Show CSV source')
  await changeSource('name\nLocal draft\n')
  await act(async () => { await browserWorkspace.writeBrowserWorkspace({ ...base, documents: base.documents.map((document) => document.filename === 'people.csv'
    ? { ...document, content: 'name\nRemote\n' } : document) }, base) })
  await focusAndFlush()
  await button('Save draft as copy')
  await focusAndFlush()
  expect(window.jsonViews!.source('people-copy-2.csv')).toBe('name\nLocal draft\n')
  expect(window.jsonViews!.source('people.csv')).toBe('name\nRemote\n')
})

async function uploadFolder(files: { name: string; webkitRelativePath: string; text: () => Promise<string> }[]) {
  const input = container.querySelector('input[aria-label="Upload JSON or CSV folder"]')!
  expect(input.hasAttribute('webkitdirectory')).toBe(true)
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
}

it('imports JSON and CSV into nested folders and restores the tree from browser storage', async () => {
  await mountWithBrowserStorage()
  const skipped = vi.fn()
  await uploadFolder([
    { name: 'same.json', webkitRelativePath: 'project/first/same.json', text: async () => '{"first":1}' },
    { name: 'same.json', webkitRelativePath: 'project/second/deep/same.json', text: async () => '{"second":2}' },
    { name: 'people.csv', webkitRelativePath: 'project/second/deep/people.csv', text: async () => 'name\nAda\n' },
    { name: 'notes.txt', webkitRelativePath: 'project/ignored/notes.txt', text: skipped },
  ])
  expect(skipped).not.toHaveBeenCalled()
  expect(Array.from(container.querySelectorAll('summary')).map((node) => node.textContent)).toEqual(['project', 'first', 'second', 'deep'])
  await button('Open project/second/deep/same.json')
  expect(displayedSource()).toBe('{"second":2}')
  await waitForAutoSave()
  const saved = await browserWorkspace.readBrowserWorkspace()
  expect(saved?.documents.filter((doc) => doc.relativePath).map((doc) => doc.relativePath)).toEqual([
    'project/first/same.json', 'project/second/deep/people.csv', 'project/second/deep/same.json',
  ])
  await act(async () => root.unmount())
  root = createRoot(container)
  // The normal test mode skips startup hydration; exercise the real reload path.
  vi.stubEnv('MODE', 'development')
  await mount()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 35)) })
  await button('Open project/first/same.json')
  expect(displayedSource()).toBe('{"first":1}')
  await button('Open project/second/deep/people.csv')
  expect(displayedSource()).toBe('name\nAda\n')
  expect(container.querySelector('button[aria-label="Open project/second/deep/people.csv"] .lucide-table-2')).not.toBeNull()
  await button('Delete project/first/same.json')
  expect(container.querySelector('summary[title="project/first/"]')).toBeNull()
  expect(container.querySelector('summary[title="project/second/deep/"]')).not.toBeNull()
})

it('reports folders without JSON or CSV files without changing the open document', async () => {
  await mount()
  await upload('keep.json', '{"keep":true}')
  await uploadFolder([{ name: 'data.txt', webkitRelativePath: 'folder/data.txt', text: vi.fn() }])
  expect(displayedSource()).toBe('{"keep":true}')
  expect(container.textContent).toContain('No JSON or CSV files found in this folder.')
  expect(container.querySelector('.document-folder')).toBeNull()
  await button('Dismiss import message')
  expect(container.querySelector('.folder-notice')).toBeNull()
  expect(displayedSource()).toBe('{"keep":true}')
})

async function dragEvent(type: string, target: EventTarget, data: object) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: data })
  await act(async () => { target.dispatchEvent(event) })
  return event
}

it('accepts mixed file drops over the editor and leaves text dragging untouched', async () => {
  await mount()
  await button('Show JSON source')
  const editor = container.querySelector('textarea')!
  const skipped = vi.fn()
  const data = { types: ['Files'], items: [], files: [
    { name: 'dropped.json', text: async () => '{"dropped":true}' },
    { name: 'people.csv', text: async () => 'name\nAda\n' },
    { name: 'ignored.txt', text: skipped },
  ], dropEffect: 'none' }
  await dragEvent('dragenter', editor, data)
  expect(container.textContent).toContain('Drop files or folders anywhere')
  const over = await dragEvent('dragover', editor, data)
  expect(over.defaultPrevented).toBe(true)
  expect(data.dropEffect).toBe('copy')
  const drop = await dragEvent('drop', editor, data)
  expect(drop.defaultPrevented).toBe(true)
  expect(container.querySelector('.file-drop-overlay')).toBeNull()
  expect(skipped).not.toHaveBeenCalled()
  await button('Open people.csv')
  expect(displayedSource()).toBe('name\nAda\n')
  const textDrag = await dragEvent('drop', container, { types: ['text/plain'] })
  expect(textDrag.defaultPrevented).toBe(false)
})

it('handles folder drops with nested paths and clears the overlay when leaving the window', async () => {
  await mount()
  const data = { types: ['Files'], files: [], items: [{
    kind: 'file', getAsFile: () => null, webkitGetAsEntry: () => ({
      name: 'Dropped folder', isDirectory: true,
      createReader: () => {
        let read = false
        return { readEntries: (resolve: (entries: unknown[]) => void) => {
          resolve(read ? [] : [{ name: 'data.csv', isFile: true, file: (done: (file: object) => void) => done({ name: 'data.csv', text: async () => 'value\n42\n' }) }])
          read = true
        } }
      },
    }),
  }] }
  await dragEvent('dragenter', document.body, data)
  await dragEvent('dragleave', document.body, data)
  expect(container.querySelector('.file-drop-overlay')).toBeNull()
  await dragEvent('drop', document.body, data)
  await button('Open Dropped folder/data.csv')
  expect(displayedSource()).toBe('value\n42\n')
})

it('keeps file selection on Upload and opens folder selection through its chevron', async () => {
  await mount()
  const files = container.querySelector<HTMLInputElement>('input[aria-label="Upload JSON or CSV file"]')!
  const folder = container.querySelector<HTMLInputElement>('input[aria-label="Upload JSON or CSV folder"]')!
  const filesClick = vi.spyOn(files, 'click').mockImplementation(() => undefined)
  const folderClick = vi.spyOn(folder, 'click').mockImplementation(() => undefined)
  await button('Upload')
  expect(filesClick).toHaveBeenCalledOnce()
  expect(files.multiple).toBe(true)
  const options = container.querySelector<HTMLButtonElement>('button[aria-label="Upload options"]')!
  await act(async () => { options.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(item.textContent).toContain('Upload folder')
  await act(async () => item.click())
  expect(folderClick).toHaveBeenCalledOnce()
})
