import type { JsonViewsPresentationState } from '@script-it/json-views-react'

export interface CachedBrowserDocumentState {
  mode?: 'view' | 'source'
  presentationState?: JsonViewsPresentationState
}

export interface CachedBrowserDocument {
  revision?: number
  content: string
  filename: string
  relativePath?: string
  id?: string
  initialContent: string
  label?: string
  metadata?: Record<string, unknown>
  mode?: 'view' | 'source'
  presentationState?: JsonViewsPresentationState
}

export interface CachedBrowserWorkspace {
  version: 1
  activeDocumentIndex: number
  activeTemplateFilename?: string
  documents: CachedBrowserDocument[]
  templateStates?: Record<string, CachedBrowserDocumentState>
}

const DATABASE_NAME = 'json-views-browser-workspace'
const STORE_NAME = 'workspace'
const DOCUMENTS_STORE = 'documents'
const CHANNEL_NAME = 'json-views-workspace-changes'
const WORKSPACE_KEY = 'current'
const PRESENTATION_KEY = 'json-views-browser-presentation-v1'

interface CachedWorkspacePresentation {
  version: 1
  activeDocumentId?: string
  activeTemplateFilename?: string
  documents: Record<string, CachedBrowserDocumentState>
  templateStates?: Record<string, CachedBrowserDocumentState>
}

function documentStateKey(document: CachedBrowserDocument): string {
  return document.id ?? `filename:${document.filename}`
}

// IndexedDB cannot reliably start an asynchronous transaction during pagehide.
// Keep only the small presentation snapshot synchronous; source stays in IndexedDB.
export function writeBrowserPresentation(workspace: CachedBrowserWorkspace): void {
  const activeDocument = workspace.documents[workspace.activeDocumentIndex]
  const presentation: CachedWorkspacePresentation = {
    version: 1,
    ...(activeDocument ? { activeDocumentId: documentStateKey(activeDocument) } : {}),
    ...(workspace.activeTemplateFilename ? { activeTemplateFilename: workspace.activeTemplateFilename } : {}),
    documents: Object.fromEntries(workspace.documents.map((document) => [documentStateKey(document), {
      mode: document.mode,
      presentationState: document.presentationState,
    }])),
    templateStates: workspace.templateStates,
  }
  try {
    sessionStorage.setItem(PRESENTATION_KEY, JSON.stringify(presentation))
  } catch {
    // Do not let an older backup override later successful IndexedDB writes.
    try { sessionStorage.removeItem(PRESENTATION_KEY); localStorage.removeItem(PRESENTATION_KEY) } catch { /* Browser storage can be disabled. */ }
  }
}

function restorePresentation(workspace: CachedBrowserWorkspace): CachedBrowserWorkspace {
  try {
    const raw = sessionStorage.getItem(PRESENTATION_KEY) ?? localStorage.getItem(PRESENTATION_KEY)
    if (!raw) return workspace
    const presentation = JSON.parse(raw) as Partial<CachedWorkspacePresentation> | null
    if (!presentation || presentation.version !== 1 || !presentation.documents
      || !validTemplateStates(presentation.documents) || !validTemplateStates(presentation.templateStates)
      || (presentation.activeDocumentId !== undefined && typeof presentation.activeDocumentId !== 'string')
      || (presentation.activeTemplateFilename !== undefined && typeof presentation.activeTemplateFilename !== 'string')) return workspace
    // Move the legacy shared backup into this tab once; it must not override
    // every newly opened tab forever.
    if (sessionStorage.getItem(PRESENTATION_KEY) === null) sessionStorage.setItem(PRESENTATION_KEY, raw)
    localStorage.removeItem(PRESENTATION_KEY)
    const activeIndex = workspace.documents.findIndex((document) => documentStateKey(document) === presentation.activeDocumentId)
    const hasActiveSelection = activeIndex >= 0 || presentation.activeTemplateFilename !== undefined
    return {
      ...workspace,
      ...(hasActiveSelection ? { activeDocumentIndex: activeIndex, activeTemplateFilename: presentation.activeTemplateFilename } : {}),
      documents: workspace.documents.map((document) => {
        const state = presentation.documents![documentStateKey(document)]
        return state ? { ...document, mode: state.mode, presentationState: state.presentationState } : document
      }),
      templateStates: { ...workspace.templateStates, ...presentation.templateStates },
    }
  } catch {
    return workspace
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser storage request failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage transaction was aborted'))
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE_NAME, 2)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
    if (!database.objectStoreNames.contains(DOCUMENTS_STORE)) {
      const documents = database.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' })
      const workspace = request.transaction!.objectStore(STORE_NAME)
      const legacy = workspace.get(WORKSPACE_KEY)
      legacy.onsuccess = () => {
        if (legacy.result === undefined) return
        if (!validWorkspace(legacy.result)) { request.transaction!.abort(); return }
        const migrated = legacy.result.documents.map((document, index) => ({
          ...document, id: document.id ?? `legacy:${index}:${document.filename}`, revision: 1,
        }))
        for (const document of migrated) documents.put(document)
        workspace.put({ ...legacy.result, documents: [], documentIds: migrated.map((document) => document.id) }, WORKSPACE_KEY)
      }
    }
  }
  const database = await requestResult(request)
  database.onversionchange = () => database.close()
  return database
}

function validWorkspace(value: unknown): value is CachedBrowserWorkspace {
  if (!value || typeof value !== 'object') return false
  const workspace = value as Partial<CachedBrowserWorkspace>
  return workspace.version === 1
    && Number.isInteger(workspace.activeDocumentIndex)
    && Array.isArray(workspace.documents)
    && workspace.documents.every((document) => Boolean(document)
      && (document.revision === undefined || (Number.isSafeInteger(document.revision) && document.revision > 0))
      && typeof document.content === 'string'
      && typeof document.filename === 'string'
      && (document.relativePath === undefined || typeof document.relativePath === 'string')
      && (document.id === undefined || (typeof document.id === 'string' && document.id.length > 0))
      && typeof document.initialContent === 'string'
      && (document.label === undefined || typeof document.label === 'string')
      && (document.metadata === undefined || (document.metadata !== null && typeof document.metadata === 'object' && !Array.isArray(document.metadata)))
      && (document.mode === undefined || document.mode === 'view' || document.mode === 'source')
      && validPresentationState(document.presentationState))
    && (workspace.activeTemplateFilename === undefined || typeof workspace.activeTemplateFilename === 'string')
    && validTemplateStates(workspace.templateStates)
}

function validPresentationState(value: unknown): value is JsonViewsPresentationState | undefined {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as Partial<JsonViewsPresentationState>).version === 1)
}

function validTemplateStates(value: unknown): value is Record<string, CachedBrowserDocumentState> | undefined {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((state) => state !== null && typeof state === 'object' && !Array.isArray(state)
      && ((state as CachedBrowserDocumentState).mode === undefined || (state as CachedBrowserDocumentState).mode === 'view' || (state as CachedBrowserDocumentState).mode === 'source')
      && validPresentationState((state as CachedBrowserDocumentState).presentationState)))
}

async function readTransaction(transaction: IDBTransaction): Promise<CachedBrowserWorkspace | undefined> {
  const [manifest, records] = await Promise.all([
    requestResult(transaction.objectStore(STORE_NAME).get(WORKSPACE_KEY)),
    requestResult(transaction.objectStore(DOCUMENTS_STORE).getAll()),
  ])
  if (manifest === undefined && records.length === 0) return undefined
  const order: string[] = manifest?.documentIds ?? []
  const documents = (records as CachedBrowserDocument[]).sort((a, b) => order.indexOf(a.id!) - order.indexOf(b.id!))
  const workspace: unknown = { ...manifest, documents }
  if (!validWorkspace(workspace)) throw new Error('The saved workspace could not be read. Download your work before reloading.')
  return workspace
}

let baseline: CachedBrowserWorkspace | undefined
let loaded = false
let pendingWrite: Promise<unknown> = Promise.resolve()

export async function readBrowserWorkspace(): Promise<CachedBrowserWorkspace | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  const database = await openDatabase()
  try {
    const transaction = database.transaction([STORE_NAME, DOCUMENTS_STORE], 'readonly')
    const completed = transactionComplete(transaction)
    const [workspace] = await Promise.all([readTransaction(transaction), completed])
    baseline = workspace
    loaded = true
    return workspace ? restorePresentation(workspace) : undefined
  } finally {
    database.close()
  }
}

// Presentation belongs to each tab. Only document data participates in conflicts.
export function browserDocumentData(document?: CachedBrowserDocument): string | undefined {
  if (!document) return undefined
  const { id, filename, relativePath, content, initialContent, label, metadata } = document
  return JSON.stringify({ id, filename, relativePath, content, initialContent, label, metadata })
}

/** Same verdict as comparing `browserDocumentData` strings, without serializing
 * two copies of the document text for every comparison. Metadata still compares
 * by its JSON spelling, so key order matters there as before. */
export function sameBrowserDocumentData(left?: CachedBrowserDocument, right?: CachedBrowserDocument): boolean {
  if (!left || !right) return left === right
  return left.id === right.id && left.filename === right.filename && left.relativePath === right.relativePath
    && left.content === right.content && left.initialContent === right.initialContent && left.label === right.label
    && JSON.stringify(left.metadata) === JSON.stringify(right.metadata)
}

export interface BrowserWorkspaceWriteResult {
  workspace: CachedBrowserWorkspace
  conflicts: string[]
}

export function writeBrowserWorkspace(
  workspace: CachedBrowserWorkspace,
  base: CachedBrowserWorkspace | undefined = baseline,
): Promise<BrowserWorkspaceWriteResult> {
  writeBrowserPresentation(workspace)
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Browser storage is unavailable. Download your work to keep it.'))
  const write = pendingWrite.catch(() => undefined).then(async () => {
    if (!validWorkspace(workspace) || workspace.documents.some((document) => !document.id)
      || new Set(workspace.documents.map((document) => document.id)).size !== workspace.documents.length) {
      throw new Error('The workspace contains invalid or duplicate document identities. Download your work before reloading.')
    }
    if (!loaded) throw new Error('The workspace could not be loaded. Download your work, then reload before saving.')
    const database = await openDatabase()
    let transaction: IDBTransaction | undefined
    try {
      transaction = database.transaction([STORE_NAME, DOCUMENTS_STORE], 'readwrite')
      const completed = transactionComplete(transaction)
      // Attach immediately, including on malformed data or a failed put.
      void completed.catch(() => undefined)
      const current = await readTransaction(transaction)
      const prior = new Map(base?.documents.map((document) => [document.id!, document]))
      const local = new Map(workspace.documents.map((document) => [document.id!, document]))
      const remote = new Map(current?.documents.map((document) => [document.id!, document]))
      const merged = new Map(remote)
      const conflicts: string[] = []
      let changed = false
      const store = transaction.objectStore(DOCUMENTS_STORE)
      for (const id of new Set([...prior.keys(), ...local.keys()])) {
        const before = prior.get(id)
        const next = local.get(id)
        const saved = remote.get(id)
        if (sameBrowserDocumentData(next, before)) continue
        if (sameBrowserDocumentData(next, saved)) continue
        if (!sameBrowserDocumentData(saved, before) || saved?.revision !== before?.revision) {
          conflicts.push(id)
          continue
        }
        if (next) {
          const updated = { ...next, revision: (saved?.revision ?? 0) + 1 }
          store.put(updated)
          merged.set(id, updated)
        } else {
          store.delete(id)
          merged.delete(id)
        }
        changed = true
      }
      const documents = [...merged.values()]
      const activeId = workspace.documents[workspace.activeDocumentIndex]?.id
      const result: CachedBrowserWorkspace = {
        ...workspace, documents,
        activeDocumentIndex: documents.findIndex((document) => document.id === activeId),
      }
      transaction.objectStore(STORE_NAME).put({ ...result, documents: [], documentIds: documents.map((document) => document.id) }, WORKSPACE_KEY)
      await completed
      baseline = { ...result, documents: [...documents.filter((document) => !conflicts.includes(document.id!)),
        ...[...prior.values()].filter((document) => conflicts.includes(document.id!))] }
      if (changed) broadcastChange()
      return { workspace: result, conflicts }
    } catch (error) {
      try { transaction?.abort() } catch { /* Already completed or aborted. */ }
      throw error
    } finally {
      database.close()
    }
  })
  pendingWrite = write
  return write
}

function broadcastChange(): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage({ type: 'documents-changed' })
    channel.close()
  } catch { /* Focus reconciliation remains available when messaging is blocked. */ }
}

/** Notifications are hints; every reconciliation reads authoritative IndexedDB data. */
export function subscribeBrowserWorkspace(onChange: () => void): () => void {
  let channel: BroadcastChannel | undefined
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME)
      channel.onmessage = (event) => { if (event.data?.type === 'documents-changed') onChange() }
    } catch { /* Also reconcile when the tab becomes active. */ }
  }
  const visible = () => { if (document.visibilityState === 'visible') onChange() }
  window.addEventListener('focus', onChange)
  document.addEventListener('visibilitychange', visible)
  return () => {
    channel?.close()
    window.removeEventListener('focus', onChange)
    document.removeEventListener('visibilitychange', visible)
  }
}
