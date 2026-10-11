import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { browserDocumentData, readBrowserWorkspace, sameBrowserDocumentData, subscribeBrowserWorkspace, writeBrowserWorkspace, type CachedBrowserDocument, type CachedBrowserWorkspace } from './browser-workspace.js'

const stored: CachedBrowserWorkspace = {
  version: 1,
  activeDocumentIndex: 0,
  documents: [
    { id: 'first', filename: 'first.json', content: '{"private":"source"}', initialContent: '{}', metadata: { version: 1 }, mode: 'view' },
    { id: 'second', filename: 'second.json', content: '[]', initialContent: '[]', mode: 'view' },
  ],
}

async function readStoredWorkspace() {
  vi.stubGlobal('indexedDB', new IDBFactory())
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('json-views-browser-workspace', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('workspace')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const transaction = request.result.transaction('workspace', 'readwrite')
      transaction.objectStore('workspace').put(stored, 'current')
      transaction.oncomplete = () => { request.result.close(); resolve() }
    }
  })
  return readBrowserWorkspace()
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('indexedDB', undefined)
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('recovers the last presentation change even when the IndexedDB write never commits', async () => {
  const presentationState = {
    version: 1 as const,
    activeView: 'view:scores',
    queries: { 'view:scores': 'Row 11' },
    viewDrafts: { '["root","$"]': { id: 'data', name: 'Data', path: '$', sort: [{ path: '$[*].name', direction: 'asc' }] } },
    tables: { scores: { columnWidths: { name: 250 } } },
  }
  const latest: CachedBrowserWorkspace = {
    ...stored,
    activeDocumentIndex: 1,
    documents: [stored.documents[0]!, { ...stored.documents[1]!, mode: 'source', presentationState }],
    templateStates: { 'example.json': { mode: 'source', presentationState } },
  }
  const pending = writeBrowserWorkspace(latest)
  const synchronousBackup = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!)
  expect(synchronousBackup.documents.second).toEqual({ mode: 'source', presentationState })
  expect(JSON.stringify(synchronousBackup)).not.toContain('private')
  expect(JSON.stringify(synchronousBackup)).not.toMatch(/"(?:content|initialContent|metadata)":/)
  await expect(pending).rejects.toThrow('Browser storage is unavailable')
  const restored = await readStoredWorkspace()
  expect(restored?.activeDocumentIndex).toBe(1)
  expect(restored?.documents[1]).toMatchObject(latest.documents[1])
  expect(restored?.documents[0]?.content).toBe(stored.documents[0]?.content)
  expect(restored?.templateStates).toEqual(latest.templateStates)
})

it('restores a template selection and safely ignores invalid presentation backups', async () => {
  await expect(writeBrowserWorkspace({ ...stored, activeDocumentIndex: -1, activeTemplateFilename: 'example.json' })).rejects.toThrow('Browser storage is unavailable')
  expect(await readStoredWorkspace()).toMatchObject({ activeDocumentIndex: -1, activeTemplateFilename: 'example.json' })
  sessionStorage.setItem(sessionStorage.key(0)!, '{broken')
  expect(await readStoredWorkspace()).toMatchObject(stored)
})

it('does not reapply a stale backup when a later synchronous write fails', async () => {
  await expect(writeBrowserWorkspace({ ...stored, activeDocumentIndex: 1 })).rejects.toThrow('Browser storage is unavailable')
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded') })
  await expect(writeBrowserWorkspace(stored)).rejects.toThrow('Browser storage is unavailable')
  expect(await readStoredWorkspace()).toMatchObject(stored)
})


async function twoTabs() {
  vi.stubGlobal('indexedDB', new IDBFactory())
  await readBrowserWorkspace()
  const first = (await writeBrowserWorkspace(stored)).workspace
  return { first, second: structuredClone(first) }
}

it('saves simultaneous edits to different documents independently', async () => {
  const { first, second } = await twoTabs()
  const firstEdit = { ...first, documents: [{ ...first.documents[0]!, content: '{"first":true}' }, first.documents[1]!] }
  const secondEdit = { ...second, documents: [second.documents[0]!, { ...second.documents[1]!, content: '[2]' }] }
  const results = await Promise.all([writeBrowserWorkspace(firstEdit, first), writeBrowserWorkspace(secondEdit, second)])
  expect(results.map((result) => result.conflicts)).toEqual([[], []])
  expect((await readBrowserWorkspace())?.documents.map((document) => document.content)).toEqual(['{"first":true}', '[2]'])
})

it('rejects same-document stale changes while saving an unrelated document', async () => {
  const { first, second } = await twoTabs()
  const a = { ...first, documents: [{ ...first.documents[0]!, content: '{"winner":true}' }, first.documents[1]!] }
  const b = { ...second, documents: [{ ...second.documents[0]!, content: '{"draft":true}' }, { ...second.documents[1]!, content: '[2]' }] }
  const results = await Promise.all([writeBrowserWorkspace(a, first), writeBrowserWorkspace(b, second)])
  expect(results[0].conflicts).toEqual([])
  expect(results[1].conflicts).toEqual(['first'])
  expect(results[1].workspace.documents.map((document) => document.content)).toEqual(['{"winner":true}', '[2]'])
  expect((await writeBrowserWorkspace(b, second)).conflicts).toEqual(['first'])
  expect((await readBrowserWorkspace())?.documents[0]?.content).toBe('{"winner":true}')
})

it('reconciles clean documents, additions and deletions without resurrecting deleted files', async () => {
  const { first, second } = await twoTabs()
  await writeBrowserWorkspace({ ...first, documents: [first.documents[1]!, { id: 'new', filename: 'new.json', content: '{}', initialContent: '{}' }] }, first)
  const reconciled = await writeBrowserWorkspace(second, second)
  expect(reconciled.conflicts).toEqual([])
  expect(reconciled.workspace.documents.map((document) => document.id)).toEqual(['second', 'new'])
  expect((await writeBrowserWorkspace(reconciled.workspace, reconciled.workspace)).workspace.documents).toEqual(reconciled.workspace.documents)
})

it('preserves an edit when another tab deletes its document', async () => {
  const { first, second } = await twoTabs()
  await writeBrowserWorkspace({ ...first, documents: [first.documents[1]!] }, first)
  const result = await writeBrowserWorkspace({ ...second, documents: [{ ...second.documents[0]!, content: '{"draft":true}' }, second.documents[1]!] }, second)
  expect(result.conflicts).toEqual(['first'])
  expect(result.workspace.documents.map((document) => document.id)).toEqual(['second'])
})

it('rejects a stale deletion after another tab edits the document', async () => {
  const { first, second } = await twoTabs()
  await writeBrowserWorkspace({ ...first, documents: [{ ...first.documents[0]!, content: '{"new":true}' }, first.documents[1]!] }, first)
  const result = await writeBrowserWorkspace({ ...second, documents: [second.documents[1]!] }, second)
  expect(result.conflicts).toEqual(['first'])
  expect(result.workspace.documents[0]?.content).toBe('{"new":true}')
})

it('uses revisions to reject changes based on a document that changed and changed back', async () => {
  const { first, second } = await twoTabs()
  const changed = (await writeBrowserWorkspace({ ...first, documents: [{ ...first.documents[0]!, content: '{"changed":true}' }, first.documents[1]!] }, first)).workspace
  await writeBrowserWorkspace(first, changed)
  const result = await writeBrowserWorkspace({ ...second, documents: [{ ...second.documents[0]!, content: '{"stale":true}' }, second.documents[1]!] }, second)
  expect(result.conflicts).toEqual(['first'])
})

it('allows identical concurrent edits and ignores presentation-only changes', async () => {
  const { first, second } = await twoTabs()
  await writeBrowserWorkspace({ ...first, activeDocumentIndex: 1 }, first)
  const edit = { ...second, documents: [{ ...second.documents[0]!, content: '{"same":true}' }, second.documents[1]!] }
  const results = await Promise.all([writeBrowserWorkspace(edit, first), writeBrowserWorkspace(edit, second)])
  expect(results.map((result) => result.conflicts)).toEqual([[], []])
  expect(results[1].workspace.documents[0]?.revision).toBe(2)
})

it('migrates legacy workspace records without losing content or stable identity', async () => {
  const migrated = await readStoredWorkspace()
  expect(migrated?.documents.map((document) => [document.id, document.revision])).toEqual([['first', 1], ['second', 1]])
  const next = (await writeBrowserWorkspace({ ...migrated!, documents: [{ ...migrated!.documents[0]!, content: '{"migrated":true}' }, migrated!.documents[1]!] }, migrated)).workspace
  expect(next.documents[0]?.revision).toBe(2)
  expect((await readBrowserWorkspace())?.documents).toEqual(next.documents)
})

it('uses notifications and focus as hints and closes listeners on cleanup', () => {
  const instances: { onmessage?: (event: { data: unknown }) => void; close: ReturnType<typeof vi.fn> }[] = []
  vi.stubGlobal('BroadcastChannel', class {
    onmessage?: (event: { data: unknown }) => void
    close = vi.fn()
    constructor() { instances.push(this) }
  })
  const callback = vi.fn()
  const cleanup = subscribeBrowserWorkspace(callback)
  instances[0]!.onmessage?.({ data: { type: 'unrelated' } })
  expect(callback).not.toHaveBeenCalled()
  instances[0]!.onmessage?.({ data: { type: 'documents-changed' } })
  window.dispatchEvent(new Event('focus'))
  expect(callback).toHaveBeenCalledTimes(2)
  cleanup()
  expect(instances[0]!.close).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event('focus'))
  expect(callback).toHaveBeenCalledTimes(2)
})

it('aborts earlier document writes if a later record cannot be stored', async () => {
  const { first } = await twoTabs()
  const invalid = { ...first, documents: [
    { ...first.documents[0]!, content: '{"mustNotCommit":true}' },
    { ...first.documents[1]!, content: '[2]', metadata: { uncloneable: () => undefined } },
  ] }
  await expect(writeBrowserWorkspace(invalid, first)).rejects.toThrow()
  expect((await readBrowserWorkspace())?.documents).toEqual(first.documents)
})

it('migrates the legacy shared presentation backup to this tab only', async () => {
  localStorage.setItem('json-views-browser-presentation-v1', JSON.stringify({
    version: 1, activeDocumentId: 'second', documents: { second: { mode: 'source' } },
  }))
  expect((await readStoredWorkspace())?.activeDocumentIndex).toBe(1)
  expect(localStorage.getItem('json-views-browser-presentation-v1')).toBeNull()
  expect(sessionStorage.getItem('json-views-browser-presentation-v1')).not.toBeNull()
  sessionStorage.clear()
  expect((await readBrowserWorkspace())?.activeDocumentIndex).toBe(0)
})

it('compares document data exactly like the serialized form it replaces', () => {
  const base: CachedBrowserDocument = { id: 'doc', filename: 'doc.json', content: '{"a":1}', initialContent: '{}', label: 'Doc', metadata: { version: 1, views: [] } }
  const variants: Array<CachedBrowserDocument | undefined> = [
    undefined,
    base,
    { ...base },
    { ...base, revision: 7, mode: 'source' },
    { ...base, content: '{"a":2}' },
    { ...base, initialContent: '{"a":1}' },
    { ...base, filename: 'other.json' },
    { ...base, relativePath: 'team/doc.json' },
    { ...base, relativePath: undefined },
    { ...base, label: undefined },
    { ...base, metadata: undefined },
    { ...base, metadata: { views: [], version: 1 } },
    { ...base, metadata: { version: 1, views: [], extra: null } },
    { id: 'doc', filename: 'doc.json', content: '{"a":1}', initialContent: '{}', label: 'Doc', metadata: { version: 1, views: [] }, relativePath: undefined },
  ]
  for (const left of variants) {
    for (const right of variants) {
      expect(sameBrowserDocumentData(left, right), `${browserDocumentData(left)} vs ${browserDocumentData(right)}`)
        .toBe(browserDocumentData(left) === browserDocumentData(right))
    }
  }
})
