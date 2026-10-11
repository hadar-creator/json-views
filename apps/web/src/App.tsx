import { documentFormat, embedJsonViewMetadata, filenameFromPath, openDocument, sourceError, untitledFilename, type OpenDocument, type RepresentativeSample } from './document-model.js'
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check, Download, Github, Moon, Plus, Settings, Share2, Sun, Upload, X } from 'lucide-react'
import {
  CSVContent, InlineFeedbackAction, JSONContent, JsonViewsProvider, useJsonViewsDevice,
  type JsonViewsPresentationState, type ObjectRootConversionRequest,
} from '@script-it/json-views-react'
import Markdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import {
  applyJsonPatchInSource, compileJsonViewMetadata, inspectCsvSource, inspectJsonSource, JsonPatchError, JsonDepthLimitError,
  sourceDiagnosticHelp, validateCsvSource,
} from '@script-it/json-views-core'
import { exampleTypes, exampleWidgets } from './representative-registry.js'
import { readBrowserWorkspace, sameBrowserDocumentData, subscribeBrowserWorkspace, writeBrowserPresentation, writeBrowserWorkspace, type CachedBrowserDocument, type CachedBrowserWorkspace } from './browser-workspace.js'
import {
  CONSOLE_HELP, jsonPatchDiagnostic, JsonViewsPatchValidationError, JsonViewsSourceValidationError, jsonSource,
  type JsonValue, type JsonViewsConsoleApi,
  type JsonViewsDiagnostic, type JsonViewsDocumentInfo, type JsonViewsDocumentInspection,
} from './console-api.js'
import { registerJsonViewsWebMcp } from './webmcp.js'
import { createShareLink, hasShareHash, MAX_SHARE_LINK_LENGTH, readShareHash, type ShareDocument } from './share-link.js'
import { analytics, isAnalyticsEnabled, setAnalyticsEnabled } from './analytics.js'
import { AgentGuide } from './AgentGuide.js'
import { UploadButton } from './UploadButton.js'
import { DocumentTree } from './DocumentTree.js'
import { collectDroppedFiles, readDocumentFiles, type CollectedFiles } from './folder-upload.js'
import { ResponsiveSidebar, SidebarToggle } from './ResponsiveSidebar.js'
import { documentRouteUrl, routeActiveView } from './document-route.js'
import { useDocumentRoute } from './use-document-route.js'

interface LocalDocument {
  content: string
  filename: string
  revision: string
}

type Theme = 'light' | 'dark'
type AnalyticsInterface = 'console' | 'ui' | 'webmcp'

const THEME_KEY = 'json-views-theme'
const SIDEBAR_KEY = 'json-views-sidebar-collapsed'
const SHARE_EXPLAINER_KEY = 'json-views-share-explainer-seen'
// Temporarily keep URL-embedded snapshots out of the public site while its
// Safe Browsing classification is reviewed. Tests and local development retain
// the feature so the implementation remains covered and recoverable.
const SNAPSHOT_SHARING_ENABLED = import.meta.env.MODE !== 'production'
const BLANK_JSON = '{\n}\n'
const NEW_TABLE_JSON = `${JSON.stringify({
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
  rows: [
    { name: '', done: false },
    { name: '', done: false },
    { name: '', done: false },
  ],
}, null, 2)}\n`

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

const HTML_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'svg', 'circle', 'text'],
  attributes: {
    ...defaultSchema.attributes,
    svg: ['ariaLabel', 'height', 'role', 'viewBox', 'width'],
    circle: ['cx', 'cy', 'fill', 'r', 'stroke', 'strokeLinecap', 'strokeWidth'],
    text: ['dominantBaseline', 'fill', 'fontFamily', 'fontSize', 'fontWeight', 'textAnchor', 'x', 'y'],
  },
}

function renderMarkdownBody(content: string): ReactNode {
  return (
    <div className="json-views-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, HTML_SANITIZE_SCHEMA]]}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </Markdown>
    </div>
  )
}

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch { /* Use the system theme when browser storage is unavailable. */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function initialSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_KEY) === 'true' } catch { return false }
}

function initialShareExplainerSeen(): boolean {
  try { return localStorage.getItem(SHARE_EXPLAINER_KEY) === 'true' } catch { return false }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch { /* Fall back for browsers that expose the API but deny access. */ }
  }
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard access was denied')
  } finally {
    textarea.remove()
  }
}

function download(content: string, filename: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([content], { type: /\.csv$/i.test(filename) ? 'text/csv' : 'application/json' }))
  link.download = filename
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(link.href), 0)
}

function documentDiagnostics(document: OpenDocument): JsonViewsDiagnostic[] {
  const source = document.controller.getSnapshot().content
  try {
    let root: unknown
    let sourceDiagnostics: JsonViewsDiagnostic[]
    if (documentFormat(document.filename) === 'csv') {
      const inspected = inspectCsvSource(source)
      root = inspected.root
      sourceDiagnostics = inspected.diagnostics.map((item) => ({
        scope: 'source',
        code: item.code,
        message: item.message,
        severity: item.severity,
        help: item.help,
        ...(item.path ? { sourcePath: item.path } : {}),
        ...(item.start === undefined ? {} : { start: item.start }),
        ...(item.end === undefined ? {} : { end: item.end }),
      }))
    } else {
      const inspected = inspectJsonSource(source)
      root = inspected.value
      sourceDiagnostics = inspected.diagnostics.map((item) => ({
        scope: 'source',
        code: item.code,
        message: item.message,
        severity: 'warning',
        help: item.help,
        token: item.token,
        sourcePath: item.sourcePath,
        start: item.start,
        end: item.end,
      }))
    }
    const compiled = compileJsonViewMetadata(
      root,
      exampleTypes,
      document.metadata === undefined ? {} : { metadata: document.metadata },
    )
    return [
      ...sourceDiagnostics,
      ...compiled.diagnostics.map((item): JsonViewsDiagnostic => ({
        ...item,
        severity: item.severity ?? 'error',
      })),
    ]
  } catch (error) {
    const code = error instanceof JsonDepthLimitError ? error.code : documentFormat(document.filename) === 'csv' ? 'invalid-csv' : 'invalid-json'
    return [{
      scope: 'source',
      code,
      message: error instanceof Error ? error.message : `Invalid ${documentFormat(document.filename).toUpperCase()}`,
      severity: 'error',
      help: sourceDiagnosticHelp(code),
    }]
  }
}

// Validity and diagnostics only change with a document's text, metadata, or
// filename. The API reads them for every document on each list() call and
// again after every write, so they are kept per controller until then.
interface DerivedDocumentState {
  content: string
  metadata: unknown
  filename: string
  valid?: boolean
  diagnostics?: readonly JsonViewsDiagnostic[]
}
const derivedDocumentState = new WeakMap<OpenDocument['controller'], DerivedDocumentState>()

function derivedState(document: OpenDocument): DerivedDocumentState {
  const content = document.controller.getSnapshot().content
  const cached = derivedDocumentState.get(document.controller)
  if (cached && cached.content === content && cached.metadata === document.metadata && cached.filename === document.filename) return cached
  const next: DerivedDocumentState = { content, metadata: document.metadata, filename: document.filename }
  derivedDocumentState.set(document.controller, next)
  return next
}

function documentValid(document: OpenDocument): boolean {
  const state = derivedState(document)
  state.valid ??= sourceError(state.content, state.filename) === undefined
  return state.valid
}

/** Shared with later reads. Read-only, so it can't be changed or handed to a caller without a copy. */
function cachedDocumentDiagnostics(document: OpenDocument): readonly JsonViewsDiagnostic[] {
  const state = derivedState(document)
  state.diagnostics ??= documentDiagnostics(document)
  return state.diagnostics
}

function documentAnalyticsProperties(document: OpenDocument, analyticsInterface: AnalyticsInterface) {
  return {
    format: documentFormat(document.filename),
    interface: analyticsInterface,
    storage: document.token ? 'local-file' : document.cacheable ? 'browser' : 'template',
  }
}
class ViewerBoundary extends Component<{ children: ReactNode; onSource: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    return this.state.failed ? (
      <div className="recovery-panel" role="alert">
        <p>This document could not be displayed. Your source is intact.</p>
        <button className="button secondary" type="button" onClick={this.props.onSource}>Open source to repair</button>
      </div>
    ) : this.props.children
  }
}

function restoreBrowserDocuments(cached: CachedBrowserWorkspace | undefined): OpenDocument[] {
  return cached?.documents.map((document) => ({
    ...openDocument(document.content, document.filename, {
      cacheable: true,
      id: document.id,
      relativePath: document.relativePath,
      label: document.label,
      metadata: document.metadata,
      mode: document.mode,
      presentationState: document.presentationState,
      revision: document.revision === undefined ? undefined : String(document.revision),
    }),
    initialContent: document.initialContent,
  })) ?? []
}

function availableConvertedFilename(proposedFilename: string, documents: readonly OpenDocument[]): string {
  const existing = new Set(documents.map((document) => document.filename))
  const extension = proposedFilename.match(/\.[^.]+$/)?.[0] ?? '.json'
  const base = proposedFilename.endsWith(extension) ? proposedFilename.slice(0, -extension.length) : proposedFilename
  let available = proposedFilename
  let suffix = 2
  while (existing.has(available)) available = `${base}-${suffix++}${extension}`
  return available
}

export function App() {
  const [initialToken] = useState(() => new URLSearchParams(location.search).get('token'))
  const [initialShareHash] = useState(() => hasShareHash(location.hash) ? location.hash : '')
  const [initialRouteHash] = useState(() => location.hash.startsWith('#/') ? location.hash : '')
  const [documents, setDocuments] = useState<OpenDocument[]>(() => [openDocument(BLANK_JSON, 'untitled.json')])
  const [activeDocumentId, setActiveDocumentId] = useState(() => documents[0].id)
  const documentsRef = useRef(documents)
  const activeDocumentIdRef = useRef(activeDocumentId)
  documentsRef.current = documents
  activeDocumentIdRef.current = activeDocumentId
  const documentSession = documents.find((document) => document.id === activeDocumentId) ?? documents[0]
  const { controller, filename, token } = documentSession
  const activeSession = useRef(documentSession)
  activeSession.current = documentSession
  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const { content } = snapshot
  const mode = documentSession.mode
  const setMode = useCallback((next: 'view' | 'source' | ((current: 'view' | 'source') => 'view' | 'source')) => {
    const documentId = activeDocumentIdRef.current
    setDocuments((current) => {
      const updated = current.map((document) => document.id === documentId
        ? { ...document, mode: typeof next === 'function' ? next(document.mode) : next }
        : document)
      documentsRef.current = updated
      return updated
    })
  }, [])
  const [connecting, setConnecting] = useState(Boolean(initialToken || initialShareHash || initialRouteHash) || import.meta.env.MODE !== 'test')
  const [hostError, setHostError] = useState('')
  const [workspaceSave, setWorkspaceSave] = useState<{ saving: boolean }>({ saving: false })
  const workspaceSaveGeneration = useRef(0)
  const [storageError, setStorageError] = useState('')
  const [workspaceConflicts, setWorkspaceConflicts] = useState<string[]>([])
  const persistenceQueue = useRef<Promise<unknown>>(Promise.resolve())
  const resolvingConflict = useRef(false)
  const [shareCopiedDocumentId, setShareCopiedDocumentId] = useState<string>()
  const [shareNotice, setShareNotice] = useState<{ documentId: string; message: string }>()
  const [shareExplainer, setShareExplainer] = useState<{ documentId: string; filename: string; source: string }>()
  const [shareExplainerSeen, setShareExplainerSeen] = useState(initialShareExplainerSeen)
  const [pendingShare, setPendingShare] = useState<{ documentId: string; filename: string; length: number; source: string; url: string }>()
  const [downloaded, setDownloaded] = useState<Record<string, string>>({})
  const [downloadConfirmedDocumentId, setDownloadConfirmedDocumentId] = useState<string>()
  const [recovery, setRecovery] = useState<{ content: string; filename: string }>()
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(initialSidebarCollapsed)
  const mobileBrowser = useJsonViewsDevice() === 'mobile'
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const sidebarCollapsed = mobileBrowser ? !mobileSidebarOpen : desktopSidebarCollapsed
  const closeSidebar = () => { if (mobileBrowser) setMobileSidebarOpen(false); else setDesktopSidebarCollapsed(true) }
  useEffect(() => { setMobileSidebarOpen(false) }, [mobileBrowser, activeDocumentId])
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(isAnalyticsEnabled)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const shareCopiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const downloadConfirmedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const sourceSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reportedApiReads = useRef(new Set<string>())
  const reportedUiEdits = useRef(new Set<string>())
  const [conversion, setConversion] = useState<{
    request: ObjectRootConversionRequest
    resolve: (accepted: boolean) => void
    document: OpenDocument
    baseSource: string
  }>()
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [importingFiles, setImportingFiles] = useState(false)
  const [importNotice, setImportNotice] = useState<{ message: string; autoDismiss?: boolean }>()
  useEffect(() => {
    if (!importNotice?.autoDismiss) return
    const timer = setTimeout(() => setImportNotice(undefined), 4000)
    return () => clearTimeout(timer)
  }, [importNotice])
  const [draggingFiles, setDraggingFiles] = useState(false)
  const loadGeneration = useRef(0)
  const localConnection = useRef<string | undefined>(initialToken ?? undefined)
  const browserWorkspaceReady = useRef(!initialToken && !initialShareHash && !initialRouteHash && import.meta.env.MODE === 'test')
  const cachedWorkspaceRef = useRef<CachedBrowserWorkspace | undefined>(undefined)
  const placeholderId = useRef(documents[0].id)
  // Parsing the whole document on every render is visible latency on large files.
  const parseError = useMemo(() => sourceError(content, filename), [content, filename])
  const { routeError, dismissRouteError } = useDocumentRoute({
    documents,
    activeDocumentId,
    ready: !connecting && browserWorkspaceReady.current,
    onNavigate: (target, activeView) => {
      const updated = documentsRef.current.map((document) => document.id === target.id ? {
        ...document,
        mode: 'view' as const,
        presentationState: { ...document.presentationState, version: 1 as const, activeView, navigation: undefined },
        viewerGeneration: document.viewerGeneration + 1,
      } : document)
      documentsRef.current = updated
      activeDocumentIdRef.current = target.id
      setDocuments(updated)
      setActiveDocumentId(target.id)
      setHostError('')
    },
  })
  const hasUnsavedChanges = documents.some((document) => {
    const documentSnapshot = document.controller.getSnapshot()
    return documentSnapshot.dirty || (!document.token && documentSnapshot.content !== (downloaded[document.id] ?? document.initialContent))
  })

  const requireWorkspaceReady = useCallback(() => {
    if (!browserWorkspaceReady.current) throw new Error('The workspace is still loading. Retry when it finishes.')
  }, [])

  const buildBrowserWorkspace = useCallback((): CachedBrowserWorkspace | undefined => {
    requireWorkspaceReady()
    const latestDocuments = documentsRef.current
    const previous = cachedWorkspaceRef.current
    const cacheableDocuments = latestDocuments.filter((document) => document.cacheable && (!initialToken || document.id !== placeholderId.current))
    const activeDocument = latestDocuments.find((document) => document.id === activeDocumentIdRef.current)
    if (initialToken && activeDocument?.id === placeholderId.current) return
    // Visiting a local file leaves the browser workspace's last selection intact.
    const previousActive = previous?.documents[previous.activeDocumentIndex]
    const activeIndex = cacheableDocuments.findIndex((document) => document.id === (activeDocument?.token ? previousActive?.id : activeDocument?.id))
    const activeTemplateFilename = activeDocument?.token
      ? previous?.activeTemplateFilename
      : activeDocument && !activeDocument.cacheable ? activeDocument.filename : undefined
    const workspace: CachedBrowserWorkspace = {
      version: 1,
      activeDocumentIndex: activeIndex,
      ...(activeTemplateFilename ? { activeTemplateFilename } : {}),
      documents: cacheableDocuments.map((document) => ({
        content: document.controller.getSnapshot().content,
        filename: document.filename,
        ...(document.relativePath ? { relativePath: document.relativePath } : {}),
        id: document.id,
        initialContent: document.initialContent,
        ...(document.label ? { label: document.label } : {}),
        ...(document.metadata ? { metadata: document.metadata } : {}),
        mode: document.mode,
        ...(document.presentationState ? { presentationState: document.presentationState } : {}),
      })),
      templateStates: { ...previous?.templateStates, ...Object.fromEntries(latestDocuments
        .filter((document) => !document.cacheable && !document.token)
        .map((document) => [document.filename, {
          mode: document.mode,
          ...(document.presentationState ? { presentationState: document.presentationState } : {}),
        }])) },
    }
    return workspace
  }, [initialToken, requireWorkspaceReady])

  const persistWorkspace = useCallback(() => {
    // Preserve presentation synchronously on pagehide, even if a save is queued.
    const presentation = buildBrowserWorkspace()
    if (presentation) writeBrowserPresentation(presentation)
    const pending = persistenceQueue.current.catch(() => undefined).then(async () => {
      const workspace = buildBrowserWorkspace()
      if (!workspace) return
      const base = cachedWorkspaceRef.current
      try {
        const result = await writeBrowserWorkspace(workspace, base)
        const conflicts = new Set(result.conflicts)
        const submitted = new Map(workspace.documents.map((document) => [document.id!, document]))
        const saved = new Map(result.workspace.documents.map((document) => [document.id!, document]))
        const previous = new Map(base?.documents.map((document) => [document.id!, document]))
        const updated: OpenDocument[] = []
        for (const document of documentsRef.current) {
          const remote = saved.get(document.id)
          if (!document.cacheable && !document.token && remote) {
            // Another tab may have edited this previously pristine example.
            // Adopt its source before advancing the conflict-detection baseline.
            const restored = restoreBrowserDocuments({ ...result.workspace, documents: [remote] })[0]
            document.controller.receive({ content: remote.content, revision: remote.revision === undefined ? undefined : String(remote.revision) }, { authoritative: true })
            updated.push({ ...restored, controller: document.controller, mode: document.mode, presentationState: document.presentationState })
            continue
          }
          if (!document.cacheable || document.token || !submitted.has(document.id)) {
            updated.push(document)
            continue
          }
          const before = submitted.get(document.id)!
          const live: CachedBrowserDocument = { ...document, content: document.controller.getSnapshot().content }
          const remoteChanged = !sameBrowserDocumentData(remote, before)
          // Typing can continue during the transaction. Never replace those newer edits.
          if (remoteChanged && !sameBrowserDocumentData(live, before)) conflicts.add(document.id)
          // Keep a remotely deleted active file open until acknowledged: a
          // field editor may still own a draft that has not reached the host.
          if (!remote && document.id === activeDocumentIdRef.current) conflicts.add(document.id)
          if (conflicts.has(document.id)) { updated.push(document); continue }
          if (!remote) continue
          if (sameBrowserDocumentData(live, before)) {
            const snapshot = document.controller.getSnapshot()
            const revision = remote.revision === undefined ? undefined : String(remote.revision)
            if (snapshot.content !== remote.content || snapshot.revision !== revision) {
              document.controller.receive({ content: remote.content, revision }, { authoritative: true })
            }
            const metadataChanged = document.filename !== remote.filename || document.relativePath !== remote.relativePath || document.label !== remote.label
              || JSON.stringify(document.metadata) !== JSON.stringify(remote.metadata)
            updated.push(metadataChanged ? { ...document, filename: remote.filename, relativePath: remote.relativePath, label: remote.label, metadata: remote.metadata } : document)
          } else updated.push(document)
        }
        // If a deletion raced with a remote edit, restore the local document so
        // its conflict can be resolved through the same controls as other edits.
        for (const before of workspace.documents) {
          if (updated.some((document) => document.id === before.id)) continue
          const remote = saved.get(before.id!)
          if (remote && !sameBrowserDocumentData(remote, before)) {
            conflicts.add(before.id!)
            updated.push(...restoreBrowserDocuments({ ...workspace, documents: [before] }))
          }
        }
        for (const remote of result.workspace.documents) {
          if (!submitted.has(remote.id!) && !updated.some((document) => document.id === remote.id)) {
            updated.push(...restoreBrowserDocuments({ ...result.workspace, documents: [remote] }))
          }
        }
        // Keep the old base for unresolved conflicts, including remote deletions.
        cachedWorkspaceRef.current = {
          ...result.workspace,
          documents: [...result.workspace.documents.filter((document) => !conflicts.has(document.id!)),
            ...[...previous.values()].filter((document) => conflicts.has(document.id!))],
        }
        if (updated.length === 0) updated.push(openDocument(BLANK_JSON, 'untitled.json'))
        if (!updated.some((document) => document.id === activeDocumentIdRef.current)) {
          activeDocumentIdRef.current = updated[0].id
          setActiveDocumentId(updated[0].id)
        }
        if (updated.length !== documentsRef.current.length || updated.some((document, index) => document !== documentsRef.current[index])) {
          documentsRef.current = updated
          setDocuments(updated)
        }
        setWorkspaceConflicts((current) => {
          const next = [...conflicts]
          return current.length === next.length && current.every((id) => conflicts.has(id)) ? current : next
        })
        setStorageError('')
        return { ...result, conflicts: [...conflicts] }
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : 'Browser save failed. Download your work to keep it.')
        throw error
      }
    })
    persistenceQueue.current = pending
    return pending
  }, [buildBrowserWorkspace])

  useEffect(() => subscribeBrowserWorkspace(() => {
    if (browserWorkspaceReady.current) void persistWorkspace().catch(() => undefined)
  }), [persistWorkspace])

  const addDocuments = useCallback((opened: OpenDocument[], origin: 'conversion' | 'upload') => {
    if (!initialToken) requireWorkspaceReady()
    if (!opened.length) return
    const updated = [...documentsRef.current, ...opened]
    documentsRef.current = updated
    setDocuments(updated)
    activeDocumentIdRef.current = opened[0].id
    setActiveDocumentId(opened[0].id)
    localConnection.current = undefined
    setConnecting(false)
    setHostError('')
    const url = new URL(location.href)
    if (url.searchParams.has('token')) {
      url.searchParams.delete('token')
      history.replaceState(null, '', url)
    }
    for (const document of opened) void analytics.track(origin === 'upload' ? 'json_views_document_opened' : 'json_views_document_created', {
      ...documentAnalyticsProperties(document, 'ui'),
      method: origin,
    })
  }, [initialToken, requireWorkspaceReady])

  const addDocument = useCallback((next: string, nextFilename: string, origin: 'conversion' | 'upload') => {
    addDocuments([openDocument(next, filenameFromPath(nextFilename))], origin)
  }, [addDocuments])

  const addBlankDocument = useCallback(() => {
    if (!initialToken) requireWorkspaceReady()
    const opened = openDocument(NEW_TABLE_JSON, untitledFilename(documentsRef.current))
    const updated = [...documentsRef.current, opened]
    documentsRef.current = updated
    setDocuments(updated)
    activeDocumentIdRef.current = opened.id
    setActiveDocumentId(opened.id)
    setHostError('')
    void analytics.track('json_views_document_created', {
      ...documentAnalyticsProperties(opened, 'ui'),
      method: 'blank',
    })
  }, [initialToken, requireWorkspaceReady])

  const deleteDocument = useCallback((documentId: string) => {
    const currentDocuments = documentsRef.current
    const index = currentDocuments.findIndex((document) => document.id === documentId)
    if (index < 0) return

    const remaining = currentDocuments.filter((document) => document.id !== documentId)
    const next = remaining[Math.min(index, remaining.length - 1)]
      ?? openDocument('{\n}\n', untitledFilename(remaining))
    const updated = remaining.length > 0 ? remaining : [next]
    documentsRef.current = updated
    setDocuments(updated)

    if (documentId === activeDocumentIdRef.current) {
      activeDocumentIdRef.current = next.id
      setActiveDocumentId(next.id)
      setHostError('')
      setRecovery(undefined)
      localConnection.current = undefined
      setConnecting(false)
    }
  }, [])

  useEffect(() => {
    document.documentElement.style.colorScheme = theme
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* Theme selection remains available without browser storage. */ }
  }, [theme])

  useEffect(() => {
    void analytics.page({ entry: initialToken ? 'local' : initialShareHash ? 'shared' : 'website', interface: 'ui' })
  }, [initialShareHash, initialToken])

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_KEY, String(desktopSidebarCollapsed)) } catch { /* Sidebar toggling remains available without browser storage. */ }
  }, [desktopSidebarCollapsed])

  useEffect(() => () => {
    if (shareCopiedTimer.current) clearTimeout(shareCopiedTimer.current)
    if (downloadConfirmedTimer.current) clearTimeout(downloadConfirmedTimer.current)
    if (sourceSaveTimer.current) clearTimeout(sourceSaveTimer.current)
  }, [])

  useEffect(() => {
    if (!settingsOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [settingsOpen])

  useEffect(() => {
    if (!initialToken) return
    const abort = new AbortController()
    void readBrowserWorkspace().catch(() => undefined).then((cached) => {
      if (abort.signal.aborted) return
      cachedWorkspaceRef.current = cached
      const restored = restoreBrowserDocuments(cached)
      const updated = [...documentsRef.current, ...restored]
      documentsRef.current = updated
      browserWorkspaceReady.current = true
      setDocuments(updated)
    })
    return () => abort.abort()
  }, [initialToken])

  useEffect(() => {
    if (!initialToken) return
    const generation = ++loadGeneration.current
    const abort = new AbortController()
    fetch(`/api/document?token=${encodeURIComponent(initialToken)}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text())
        return response.json() as Promise<LocalDocument>
      })
      .then((localDocument) => {
        if (generation !== loadGeneration.current) return
        const opened = openDocument(localDocument.content, localDocument.filename, { token: initialToken, revision: localDocument.revision })
        const updated = [opened, ...documentsRef.current.filter((document) => document.id !== placeholderId.current)]
        documentsRef.current = updated
        setDocuments(updated)
        setActiveDocumentId(opened.id)
        setConnecting(false)
        void analytics.track('json_views_document_opened', {
          ...documentAnalyticsProperties(opened, 'ui'),
          method: 'local-file',
        })
      })
      .catch((error: unknown) => {
        if (generation !== loadGeneration.current || abort.signal.aborted) return
        setHostError(error instanceof Error ? error.message : 'Could not open local file')
        setConnecting(false)
      })
    return () => abort.abort()
  }, [initialToken])

  useEffect(() => {
    if (initialToken || (import.meta.env.MODE === 'test' && !initialShareHash && !initialRouteHash)) return
    const abort = new AbortController()
    const loadExamples = async (): Promise<OpenDocument[]> => {
      const response = await fetch('./representative-examples/manifest.json', { signal: abort.signal })
      if (!response.ok) throw new Error('Could not load representative examples')
      const samples = await response.json() as RepresentativeSample[]
      const opened = await Promise.all(samples.map(async (sample) => {
        const [sourceResponse, annotationResponse] = await Promise.all([
          fetch(`./representative-examples/${sample.sourceFile}`, { signal: abort.signal }),
          sample.annotationFile ? fetch(`./representative-examples/${sample.annotationFile}`, { signal: abort.signal }) : undefined,
        ])
        if (!sourceResponse.ok || (annotationResponse && !annotationResponse.ok)) throw new Error(`Could not load ${sample.title}`)
        const [source, annotations] = await Promise.all([sourceResponse.text(), annotationResponse?.json()])
        if (annotationResponse && (!annotations || typeof annotations !== 'object' || Array.isArray(annotations))) throw new Error(`Invalid annotations for ${sample.title}`)
        return openDocument(annotationResponse ? embedJsonViewMetadata(source, annotations as Record<string, unknown>) : source, filenameFromPath(sample.sourceFile), {
          cacheable: false,
          id: `example:${sample.sourceFile}`,
          label: sample.title,
          relativePath: sample.relativePath,
          presentationState: sample.presentationState,
        })
      }))
      return opened
    }
    const loadWorkspace = async () => {
      const sharedDocumentResult: Promise<{ document?: ShareDocument; error?: string }> = initialShareHash
        ? SNAPSHOT_SHARING_ENABLED
          ? readShareHash(initialShareHash)
          .then((document) => ({ document }))
          .catch(() => ({ error: 'This share link is incomplete or invalid. Ask the sender to create a new link, or share the file directly.' }))
          : Promise.resolve({ error: 'Shared document links are temporarily unavailable while we complete a security review. Ask the sender to share the file directly.' })
        : Promise.resolve({})
      const [examples, cached, sharedResult] = await Promise.all([
        loadExamples().catch(() => []),
        readBrowserWorkspace().catch(() => undefined),
        sharedDocumentResult,
      ])
      if (abort.signal.aborted) return
      cachedWorkspaceRef.current = cached
      const cachedDocuments = restoreBrowserDocuments(cached)
      const cachedById = new Map(cachedDocuments.map((document) => [document.id, document]))
      const restoredExamples = examples.map((document) => {
        // Edited examples are ordinary browser documents. Their saved source
        // takes precedence over a freshly fetched template, including its UI state.
        const edited = cachedById.get(document.id)
        if (edited) return edited
        const state = cached?.templateStates?.[document.filename]
        return state ? { ...document, mode: state.mode ?? document.mode, presentationState: state.presentationState ?? document.presentationState } : document
      })
      const sharedDocument = sharedResult.document
        ? openDocument(sharedResult.document.source, filenameFromPath(sharedResult.document.filename))
        : undefined
      const exampleIds = new Set(examples.map((document) => document.id))
      const opened = [...restoredExamples, ...cachedDocuments.filter((document) => !exampleIds.has(document.id)), ...(sharedDocument ? [sharedDocument] : [])]
      const fallback = opened.length > 0 ? opened : [openDocument(BLANK_JSON, 'untitled.json')]
      const restoredActive = cached && cached.activeDocumentIndex >= 0
        ? cachedDocuments[cached.activeDocumentIndex]
        : restoredExamples.find((document) => document.filename === cached?.activeTemplateFilename)
      documentsRef.current = fallback
      browserWorkspaceReady.current = true
      setDocuments(fallback)
      const activeDocument = sharedDocument ?? restoredActive ?? fallback[0]
      activeDocumentIdRef.current = activeDocument.id
      setActiveDocumentId(activeDocument.id)
      setHostError(sharedResult.error ?? '')
      setConnecting(false)
      if (sharedDocument) {
        void analytics.track('json_views_document_opened', {
          ...documentAnalyticsProperties(sharedDocument, 'ui'),
          method: 'share-link',
        })
      }
    }
    void loadWorkspace().catch(() => {
      browserWorkspaceReady.current = true
      setConnecting(false)
    })
    return () => abort.abort()
  }, [initialShareHash, initialToken, initialRouteHash])

  useEffect(() => {
    if (!browserWorkspaceReady.current) return
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    const activeDataNeedsSaving = () => {
      const current = buildBrowserWorkspace()?.documents.find((document) => document.id === activeDocumentIdRef.current)
      const saved = cachedWorkspaceRef.current?.documents.find((document) => document.id === activeDocumentIdRef.current)
      return !sameBrowserDocumentData(current, saved)
    }
    const persist = () => {
      const generation = ++workspaceSaveGeneration.current
      setWorkspaceSave({ saving: activeDataNeedsSaving() })
      void persistWorkspace().then(() => {
        if (workspaceSaveGeneration.current === generation) setWorkspaceSave({ saving: false })
      }, () => {
        if (workspaceSaveGeneration.current === generation) setWorkspaceSave({ saving: false })
      })
    }
    const schedulePersist = () => {
      if (saveTimer) clearTimeout(saveTimer)
      ++workspaceSaveGeneration.current
      setWorkspaceSave({ saving: activeDataNeedsSaving() })
      saveTimer = setTimeout(persist, 120)
    }
    const flushPersist = () => {
      if (saveTimer) clearTimeout(saveTimer)
      persist()
    }
    schedulePersist()
    const unsubscribes = documents.filter((document) => document.cacheable).map((document) => document.controller.subscribe(schedulePersist))
    window.addEventListener('pagehide', flushPersist)
    return () => {
      ++workspaceSaveGeneration.current
      if (saveTimer) clearTimeout(saveTimer)
      unsubscribes.forEach((unsubscribe) => unsubscribe())
      window.removeEventListener('pagehide', flushPersist)
    }
  }, [activeDocumentId, buildBrowserWorkspace, documents, persistWorkspace])

  useEffect(() => {
    if (!hasUnsavedChanges) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [hasUnsavedChanges])

  const retainBrowserDocument = useCallback((documentId: string) => {
    const current = documentsRef.current.find((document) => document.id === documentId)
    if (!current || current.token || current.cacheable) return
    // Promote on the first edit, before any save snapshot is built. Pristine
    // examples can still receive template updates on the next visit.
    const updated = documentsRef.current.map((document) => document.id === documentId ? { ...document, cacheable: true } : document)
    documentsRef.current = updated
    setDocuments(updated)
  }, [])

  const editSourceDraft = useCallback((next: string) => {
    retainBrowserDocument(documentSession.id)
    controller.edit(next)
    setHostError('')
  }, [controller, documentSession.id, retainBrowserDocument])

  const commitDocument = useCallback(async (document: OpenDocument, next: string) => {
    if (!document.token) requireWorkspaceReady()
    try {
      if (documentFormat(document.filename) === 'csv') validateCsvSource(next)
    } catch (error) {
      const code = 'invalid-csv'
      throw new JsonViewsSourceValidationError([{
        scope: 'source', code, severity: 'error',
        message: error instanceof Error ? error.message : 'Invalid source',
        help: sourceDiagnosticHelp(code),
      }])
    }
    retainBrowserDocument(document.id)
    const unchanged = next === document.controller.getSnapshot().acknowledgedContent
    await document.controller.commit(() => next, async (source, context) => {
      if (!document.token) {
        const result = await persistWorkspace()
        if (result?.conflicts.includes(document.id)) throw new Error('This document changed in another tab. Your draft is preserved; choose the saved version or save your draft as a copy.')
        const saved = result?.workspace.documents.find((entry) => entry.id === document.id)
        if (!saved) throw new Error('This document was not stored. Retry the save or download your work.')
        return { content: saved.content, revision: saved.revision === undefined ? undefined : String(saved.revision) }
      }
      const response = await fetch(`/api/document?token=${encodeURIComponent(document.token)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: source, revision: context.baseRevision }),
      })
      if (!response.ok) throw new Error(await response.text())
      const saved = await response.json() as LocalDocument
      return { content: saved.content, revision: saved.revision }
    })
    if (!document.token && unchanged) {
      const result = await persistWorkspace()
      if (result?.conflicts.includes(document.id)) throw new Error('This document changed in another tab. Resolve the conflict before saving.')
    }
  }, [persistWorkspace, requireWorkspaceReady, retainBrowserDocument])

  const commit = useCallback(async (next: string) => {
    if (activeSession.current.controller !== documentSession.controller) throw new Error('The document session changed; this edit was not saved')
    setHostError('')
    await commitDocument(documentSession, next)
    const editMethod = mode === 'source' ? 'source' : 'visual'
    const reportKey = `${documentSession.id}:${editMethod}`
    if (!reportedUiEdits.current.has(reportKey)) {
      reportedUiEdits.current.add(reportKey)
      void analytics.track('json_views_document_edited', {
        ...documentAnalyticsProperties(documentSession, 'ui'),
        edit_method: editMethod,
      })
    }
  }, [commitDocument, documentSession, mode])

  const updateSessionMetadata = useCallback(async (next: Record<string, unknown>) => {
    const documentId = documentSession.id
    retainBrowserDocument(documentId)
    const updated = documentsRef.current.map((document) => document.id === documentId ? { ...document, metadata: next } : document)
    documentsRef.current = updated
    setDocuments(updated)
    const result = await persistWorkspace()
    if (result?.conflicts.includes(documentId)) throw new Error('These view settings changed in another tab. Resolve the conflict before saving.')
  }, [documentSession.id, persistWorkspace, retainBrowserDocument])

  const updatePresentationState = useCallback((next: JsonViewsPresentationState) => {
    const documentId = documentSession.id
    // Page-hide flushes must observe this state before React's next render.
    const updated = documentsRef.current.map((document) => document.id === documentId ? { ...document, presentationState: next } : document)
    documentsRef.current = updated
    setDocuments(updated)
  }, [documentSession.id])

  const requestMetadataPersistence = useCallback((request: ObjectRootConversionRequest) => (
    new Promise<boolean>((resolve) => setConversion({ request, resolve, document: documentSession, baseSource: documentSession.controller.getSnapshot().content }))
  ), [documentSession])

  useEffect(() => {
    const findDocument = (reference: string): OpenDocument => {
      requireWorkspaceReady()
      const byId = documentsRef.current.find((document) => document.id === reference)
      if (byId) return byId
      const byFilename = documentsRef.current.filter((document) => document.filename === reference || document.relativePath === reference)
      if (byFilename.length === 1) return byFilename[0]
      if (byFilename.length > 1) throw new Error(`More than one document is named ${reference}; use the document id from jsonViews.list()`)
      throw new Error(`No JSON document matches ${reference}`)
    }
    const describe = (document: OpenDocument, includeDiagnosticCount = false): JsonViewsDocumentInfo => {
      const documentSnapshot = document.controller.getSnapshot()
      return {
        active: document.id === activeDocumentIdRef.current,
        ...(includeDiagnosticCount ? { diagnosticCount: cachedDocumentDiagnostics(document).length } : {}),
        filename: document.filename,
        ...(document.relativePath ? { relativePath: document.relativePath } : {}),
        id: document.id,
        ...(document.label ? { label: document.label } : {}),
        ...(documentSnapshot.revision ? { revision: documentSnapshot.revision } : {}),
        storage: document.token ? 'local-file' : document.cacheable ? 'browser' : 'example',
        valid: documentValid(document),
      }
    }
    const inspect = (document: OpenDocument): JsonViewsDocumentInspection => ({
      ...describe(document),
      // Callers may modify what they receive, so each diagnostic is a deep copy.
      diagnostics: cachedDocumentDiagnostics(document).map((diagnostic) => structuredClone(diagnostic)),
    })
    const refresh = () => setDocuments([...documentsRef.current])
    const reportRead = (analyticsInterface: Exclude<AnalyticsInterface, 'ui'>, method: string, document?: OpenDocument) => {
      const reportKey = `${analyticsInterface}:${method}`
      if (reportedApiReads.current.has(reportKey)) return
      reportedApiReads.current.add(reportKey)
      void analytics.track('json_views_document_read', {
        ...(document ? documentAnalyticsProperties(document, analyticsInterface) : { interface: analyticsInterface }),
        read_method: method,
      })
    }
    const replace = async (
      document: OpenDocument,
      next: string,
      analyticsInterface: Exclude<AnalyticsInterface, 'ui'>,
      editMethod: 'patch' | 'source',
    ): Promise<JsonViewsDocumentInspection> => {
      await commitDocument(document, next)
      refresh()
      void analytics.track('json_views_document_edited', {
        ...documentAnalyticsProperties(document, analyticsInterface),
        edit_method: editMethod,
      })
      return inspect(document)
    }
    const createApi = (analyticsInterface: Exclude<AnalyticsInterface, 'ui'>): JsonViewsConsoleApi => ({
      version: 1,
      help: () => {
        reportRead(analyticsInterface, 'help')
        return CONSOLE_HELP
      },
      list: (options) => {
        const result = documentsRef.current.map((document) => describe(document, options?.includeDiagnosticCount))
        reportRead(analyticsInterface, 'list')
        return result
      },
      link: (reference, viewName) => documentRouteUrl(location.href, documentsRef.current, findDocument(reference), viewName),
      diagnostics: (reference) => {
        const document = findDocument(reference)
        const result = inspect(document)
        reportRead(analyticsInterface, 'diagnostics', document)
        return result
      },
      get: (reference) => {
        const document = findDocument(reference)
        const result = JSON.parse(document.controller.getSnapshot().content) as JsonValue
        reportRead(analyticsInterface, 'parsed', document)
        return result
      },
      source: (reference) => {
        const document = findDocument(reference)
        const result = document.controller.getSnapshot().content
        reportRead(analyticsInterface, 'source', document)
        return result
      },
      create: async (filename, value) => {
        requireWorkspaceReady()
        const opened = openDocument(jsonSource(value), filenameFromPath(filename))
        const updated = [...documentsRef.current, opened]
        documentsRef.current = updated
        activeDocumentIdRef.current = opened.id
        setDocuments(updated)
        setActiveDocumentId(opened.id)
        localConnection.current = undefined
        setConnecting(false)
        setHostError('')
        const url = new URL(location.href)
        if (url.searchParams.has('token')) {
          url.searchParams.delete('token')
          history.replaceState(null, '', url)
        }
        await persistWorkspace()
        const result = inspect(opened)
        void analytics.track('json_views_document_created', {
          ...documentAnalyticsProperties(opened, analyticsInterface),
          method: 'api',
        })
        return result
      },
      patch: async (reference, patch) => {
        const document = findDocument(reference)
        try {
          if (documentFormat(document.filename) !== 'json') {
            throw new JsonPatchError('invalid-document', 'JSON Patch applies only to JSON documents')
          }
          const next = applyJsonPatchInSource(document.controller.getSnapshot().content, patch)
          return replace(document, next, analyticsInterface, 'patch')
        } catch (error) {
          if (error instanceof JsonPatchError) throw new JsonViewsPatchValidationError([jsonPatchDiagnostic(error)])
          throw error
        }
      },
      setSource: async (reference, source) => replace(findDocument(reference), source, analyticsInterface, 'source'),
      select: (reference) => {
        const document = findDocument(reference)
        activeDocumentIdRef.current = document.id
        setActiveDocumentId(document.id)
        setHostError('')
        const result = describe(document)
        reportRead(analyticsInterface, 'select', document)
        return result
      },
      remove: (reference) => {
        const document = findDocument(reference)
        deleteDocument(document.id)
        void analytics.track('json_views_document_deleted', documentAnalyticsProperties(document, analyticsInterface))
      },
    })
    const api = createApi('console')
    const webMcpApi = createApi('webmcp')
    Object.defineProperty(window, 'jsonViews', { configurable: true, enumerable: true, value: api })
    const unregisterWebMcp = registerJsonViewsWebMcp(webMcpApi)
    return () => {
      unregisterWebMcp()
      if (window.jsonViews === api) delete window.jsonViews
    }
  }, [commitDocument, deleteDocument, persistWorkspace, requireWorkspaceReady])

  const importFiles = useCallback((selection: CollectedFiles | Promise<CollectedFiles>, emptyMessage: string) => {
    const generation = ++loadGeneration.current
    setImportingFiles(true)
    setImportNotice(undefined)
    void Promise.resolve(selection).then(async ({ files, failures: traversalFailures }) => {
      const { documents: imported, failures: readFailures } = await readDocumentFiles(files)
      if (generation !== loadGeneration.current) return
      const failures = traversalFailures.length + readFailures.length
      addDocuments(imported.map(({ content, filename, relativePath }) => openDocument(content, filename, { relativePath })), 'upload')
      setImportNotice({ autoDismiss: imported.length > 0 && failures === 0, message: imported.length
        ? `Imported ${imported.length} ${imported.length === 1 ? 'file' : 'files'}.${failures ? ` Could not read ${failures} ${failures === 1 ? 'item' : 'items'}.` : ''}`
        : failures ? 'Could not read the selected files or folders. Try selecting them again with Upload.' : emptyMessage })
    }).catch((error: unknown) => {
      if (generation === loadGeneration.current) setHostError(error instanceof Error ? error.message : 'Could not import files')
    }).finally(() => {
      if (generation === loadGeneration.current) setImportingFiles(false)
    })
  }, [addDocuments])

  useEffect(() => {
    let depth = 0
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const reset = () => { depth = 0; setDraggingFiles(false) }
    const enter = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      depth += 1
      setDraggingFiles(true)
    }
    const over = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = connecting ? 'none' : 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      depth = Math.max(0, depth - 1)
      if (!depth) reset()
    }
    const drop = (event: DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      event.stopPropagation()
      reset()
      if (connecting) {
        setImportNotice({ message: 'The workspace is loading. Drop your files again when it finishes.' })
        return
      }
      importFiles(collectDroppedFiles(event.dataTransfer!), 'No JSON or CSV files found in this drop.')
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
    }
  }, [connecting, importFiles])

  const resolveBrowserConflict = async (saveCopy: boolean) => {
    const targetId = documentSession.id
    if (snapshot.saving || resolvingConflict.current) return
    resolvingConflict.current = true
    try {
      const resolution = persistenceQueue.current.catch(() => undefined).then(async () => {
        const saved = await readBrowserWorkspace()
        const remote = saved?.documents.find((document) => document.id === targetId)
        const latest = documentsRef.current.find((document) => document.id === targetId)
        if (!latest || latest.controller.getSnapshot().saving) return
        const draft = latest.controller.getSnapshot().content
        setRecovery({ content: draft, filename: latest.filename })
        const restored = remote ? restoreBrowserDocuments({ ...saved!, documents: [remote] })[0] : undefined
        if (restored) {
          restored.mode = latest.mode
          restored.presentationState = latest.presentationState
          restored.viewerGeneration = latest.viewerGeneration + 1
        }
        const copy = saveCopy ? openDocument(draft,
          availableConvertedFilename(latest.filename.replace(/(\.[^.]+)?$/, '-copy$1'), documentsRef.current),
          { metadata: latest.metadata, mode: latest.mode, presentationState: latest.presentationState }) : undefined
        const updated = documentsRef.current.flatMap((document) => document.id === targetId ? (restored ? [restored] : []) : [document])
        if (copy) updated.push(copy)
        if (updated.length === 0) updated.push(openDocument(BLANK_JSON, 'untitled.json'))
        const prior = cachedWorkspaceRef.current
        cachedWorkspaceRef.current = { ...(prior ?? saved!), documents: [
          ...(prior?.documents.filter((document) => document.id !== targetId) ?? []), ...(remote ? [remote] : []),
        ] }
        documentsRef.current = updated
        setDocuments(updated)
        activeDocumentIdRef.current = copy?.id ?? restored?.id ?? updated[0].id
        setActiveDocumentId(activeDocumentIdRef.current)
        setWorkspaceConflicts((current) => current.filter((id) => id !== targetId))
        setHostError('')
      })
      persistenceQueue.current = resolution
      await resolution
      await persistWorkspace()
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Could not load the saved document')
    } finally {
      resolvingConflict.current = false
    }
  }

  const reloadLocal = async () => {
    const connectionToken = token ?? localConnection.current
    if (!connectionToken || snapshot.saving) return
    const previous = documentSession
    const generation = ++loadGeneration.current
    setHostError('')
    try {
      const response = await fetch(`/api/document?token=${encodeURIComponent(connectionToken)}`)
      if (!response.ok) throw new Error(await response.text())
      const local = await response.json() as LocalDocument
      if (generation !== loadGeneration.current || activeSession.current.id !== previous.id) return
      const latest = previous.controller.getSnapshot()
      if (latest.dirty) setRecovery({ content: latest.content, filename: previous.filename })
      const latestDocument = activeSession.current
      const opened = openDocument(
        local.content,
        local.filename,
        {
          cacheable: previous.cacheable,
          id: previous.id,
          label: previous.label,
          metadata: previous.metadata,
          mode: sourceError(local.content, local.filename) ? 'source' : latestDocument.mode,
          presentationState: latestDocument.presentationState,
          revision: local.revision,
          token: connectionToken,
        },
      )
      opened.viewerGeneration = latestDocument.viewerGeneration + 1
      setDocuments((current) => current.map((document) => document.id === previous.id ? opened : document))
      setActiveDocumentId(opened.id)
    } catch (error) {
      if (generation === loadGeneration.current) setHostError(error instanceof Error ? error.message : 'Could not reload local file')
    }
  }

  const saveSource = useCallback(() => {
    void commit(content).catch((error: unknown) => {
      if (activeSession.current.controller === documentSession.controller) setHostError(error instanceof Error ? error.message : 'Could not save')
    })
  }, [commit, content, documentSession])

  useEffect(() => {
    if (sourceSaveTimer.current) clearTimeout(sourceSaveTimer.current)
    if (mode !== 'source' || connecting || snapshot.error || !snapshot.dirty || snapshot.saving) return
    sourceSaveTimer.current = setTimeout(saveSource, 300)
    return () => {
      if (sourceSaveTimer.current) clearTimeout(sourceSaveTimer.current)
    }
  }, [connecting, mode, saveSource, snapshot.dirty, snapshot.error, snapshot.saving])

  const copyCreatedShareLink = async (share: { documentId: string; filename: string; url: string }) => {
    if (shareCopiedTimer.current) clearTimeout(shareCopiedTimer.current)
    try {
      await copyText(share.url)
      setPendingShare(undefined)
      setShareCopiedDocumentId(share.documentId)
      const document = documentsRef.current.find((candidate) => candidate.id === share.documentId)
      void analytics.track('json_views_share_link_copied', document
        ? documentAnalyticsProperties(document, 'ui')
        : { format: documentFormat(share.filename), interface: 'ui' })
      shareCopiedTimer.current = setTimeout(() => setShareCopiedDocumentId((current) => current === share.documentId ? undefined : current), 1800)
    } catch (error) {
      setShareCopiedDocumentId(undefined)
      setShareNotice({
        documentId: share.documentId,
        message: error instanceof Error ? error.message : 'Could not copy the share link',
      })
    }
  }

  const startDownload = (documentId: string, source: string, filename: string) => {
    download(source, filename)
    const document = documentsRef.current.find((candidate) => candidate.id === documentId)
    void analytics.track('json_views_document_downloaded', document
      ? documentAnalyticsProperties(document, 'ui')
      : { format: documentFormat(filename), interface: 'ui' })
    setDownloaded((current) => ({ ...current, [documentId]: source }))
    if (downloadConfirmedTimer.current) clearTimeout(downloadConfirmedTimer.current)
    setDownloadConfirmedDocumentId(documentId)
    downloadConfirmedTimer.current = setTimeout(() => setDownloadConfirmedDocumentId((current) => current === documentId ? undefined : current), 1800)
  }

  const createAndCopyShareLink = async (sharingDocument: { documentId: string; filename: string; source: string }) => {
    setShareNotice(undefined)
    setPendingShare(undefined)
    try {
      const shared = await createShareLink({ filename: sharingDocument.filename, source: sharingDocument.source })
      const prepared = {
        documentId: sharingDocument.documentId,
        filename: sharingDocument.filename,
        length: shared.length,
        source: sharingDocument.source,
        url: shared.url,
      }
      if (shared.warning) {
        setPendingShare(prepared)
        return
      }
      await copyCreatedShareLink(prepared)
    } catch (error) {
      setShareCopiedDocumentId(undefined)
      setShareNotice({
        documentId: sharingDocument.documentId,
        message: error instanceof Error ? error.message : 'Could not create the share link',
      })
    }
  }

  const copyShareLink = async () => {
    const sharingDocument = {
      documentId: documentSession.id,
      filename: documentSession.filename,
      source: documentSession.controller.getSnapshot().content,
    }
    if (!shareExplainerSeen) {
      setShareExplainer(sharingDocument)
      return
    }
    await createAndCopyShareLink(sharingDocument)
  }

  const confirmShareExplainer = async () => {
    if (!shareExplainer) return
    const sharingDocument = shareExplainer
    setShareExplainer(undefined)
    setShareExplainerSeen(true)
    try { localStorage.setItem(SHARE_EXPLAINER_KEY, 'true') } catch { /* Remember the acknowledgement for this session only. */ }
    await createAndCopyShareLink(sharingDocument)
  }

  const createConvertedCopy = () => {
    if (!conversion) return
    const proposed = availableConvertedFilename(conversion.request.proposedFilename, documentsRef.current)
    const pending = conversion
    setConversion(undefined)
    addDocument(pending.request.convertedSource, proposed, 'conversion')
    pending.resolve(true)
  }

  const replaceArrayOriginal = async () => {
    if (!conversion || conversion.request.sourceFormat !== 'json-array') return
    const pending = conversion
    try {
      if (!documentsRef.current.some((document) => document.id === pending.document.id)
        || pending.document.controller.getSnapshot().content !== pending.baseSource) {
        throw new Error('The original document changed. Cancel and request conversion again.')
      }
      await commitDocument(pending.document, pending.request.convertedSource)
      void analytics.track('json_views_document_edited', {
        ...documentAnalyticsProperties(pending.document, 'ui'),
        edit_method: 'conversion',
      })
      setDocuments((current) => {
        const updated = current.map((document) => document.id === pending.document.id ? { ...document, metadata: undefined } : document)
        documentsRef.current = updated
        return updated
      })
      setConversion(undefined)
      pending.resolve(true)
    } catch (error) {
      setHostError(error instanceof Error ? error.message : 'Could not replace the original document')
    }
  }

  const cancelConversion = () => {
    if (!conversion) return
    const pending = conversion
    setConversion(undefined)
    pending.resolve(false)
  }

  return (
    <JsonViewsProvider types={exampleTypes} widgets={exampleWidgets}>
    <main className="site-shell json-views-app" data-sidebar-collapsed={sidebarCollapsed} data-json-views-device={mobileBrowser ? 'mobile' : 'desktop'} data-json-views-theme={theme}>
      <input ref={fileInput} aria-label="Upload JSON or CSV file" hidden type="file" multiple accept="application/json,text/csv,.json,.csv" onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? [])
        event.currentTarget.value = ''
        if (files.length) importFiles({ files, failures: [] }, 'No JSON or CSV files selected.')
      }} />
      <input ref={folderInput} aria-label="Upload JSON or CSV folder" hidden type="file" multiple
        {...{ webkitdirectory: '' }} onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (files.length) importFiles({ files, failures: [] }, 'No JSON or CSV files found in this folder.')
        }} />
      {draggingFiles && <div className="file-drop-overlay" role="status">
        <div><Upload size={30} aria-hidden="true" /><strong>{connecting ? 'Workspace is loading…' : 'Drop files or folders anywhere'}</strong><span>JSON and CSV · Nested folders preserved</span></div>
      </div>}

      <div className="app-layout">
        <ResponsiveSidebar mobile={mobileBrowser} open={!sidebarCollapsed} onClose={closeSidebar}>
          <div className="sidebar-actions">
            <SidebarToggle open onToggle={closeSidebar} />
            <AgentGuide copyText={async (prompt) => { await copyText(prompt); void analytics.track('json_views_agent_skill_copied', { interface: 'ui' }) }} renderMarkdown={renderMarkdownBody} />
          </div>
          <nav className="document-list" aria-label="Open documents">
            {!connecting && <DocumentTree documents={documents} activeDocumentId={documentSession.id}
              onOpen={(document) => {
                let activeView = 'root'
                try { activeView = routeActiveView(document) } catch { /* Invalid source stays open for repair. */ }
                const updated = documentsRef.current.map((entry) => entry.id === document.id ? {
                  ...entry,
                  mode: 'view' as const,
                  presentationState: { ...entry.presentationState, version: 1 as const, activeView, navigation: undefined },
                  viewerGeneration: entry.viewerGeneration + 1,
                } : entry)
                documentsRef.current = updated
                setDocuments(updated)
                activeDocumentIdRef.current = document.id
                setActiveDocumentId(document.id)
                setHostError('')
                if (mobileBrowser) setMobileSidebarOpen(false)
              }}
              onDelete={(document) => {
                deleteDocument(document.id)
                void analytics.track('json_views_document_deleted', documentAnalyticsProperties(document, 'ui'))
              }} />}
            {!connecting && <button className="new-document" type="button" aria-label="Create JSON document" title="Create JSON document" onClick={addBlankDocument}><Plus size={20} /></button>}
          </nav>
          <div className="sidebar-footer">
            {importNotice && <div className="folder-notice" role="status">
              <span>{importNotice.message}</span>
              {!importNotice.autoDismiss && <button className="icon-link" type="button" aria-label="Dismiss import message"
                title="Dismiss" onClick={() => setImportNotice(undefined)}><X size={14} aria-hidden="true" /></button>}
            </div>}
            <div className="sidebar-footer-actions">
              <div className="settings-menu">
                <button
                  className="icon-link settings-trigger"
                  type="button"
                  aria-label="Settings"
                  aria-expanded={settingsOpen}
                  aria-haspopup="dialog"
                  title="Settings"
                  onClick={() => setSettingsOpen((current) => !current)}
                >
                  <Settings size={16} aria-hidden="true" />
                </button>
              </div>
              <UploadButton disabled={connecting || importingFiles} busy={importingFiles}
                onFiles={() => fileInput.current?.click()} onFolder={() => folderInput.current?.click()} />
            </div>
          </div>
        </ResponsiveSidebar>

        {settingsOpen && <div className="settings-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-dialog-header">
              <div className="settings-dialog-title">
                <Settings size={18} aria-hidden="true" />
                <h2 id="privacy-settings-title">Privacy settings</h2>
              </div>
              <button className="icon-link" type="button" aria-label="Close settings" title="Close settings" onClick={() => setSettingsOpen(false)}>
                <X size={18} aria-hidden="true" />
              </button>
            </header>
            <label className="settings-option">
              <span>
                <strong>Allow anonymous analytics</strong>
                <small>You can change this at any time. This preference is saved only in this browser. Turning it off sends one final anonymous disabled event.</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label="Allow anonymous analytics"
                checked={analyticsEnabled}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked
                  if (!enabled) void analytics.track('json_views_analytics_disabled', { interface: 'ui' })
                  setAnalyticsEnabledState(enabled)
                  setAnalyticsEnabled(enabled)
                  if (enabled) void analytics.track('json_views_analytics_enabled', { interface: 'ui' })
                }}
              />
            </label>
            <div className="settings-dialog-copy">
              <p>This website sends an <strong><u>optional</u></strong> small number of anonymous events so we know how to make it better.</p>
              <div className="settings-privacy-note">
                <strong>We never collect</strong>
                <span>File contents, filenames, share links, page URLs, personal information, or session recordings.</span>
              </div>
            </div>
          </section>
        </div>}

        <div className="editor-pane">

      <section className="document-bar">
        <div className="document-title">
          {sidebarCollapsed && <SidebarToggle open={false} onToggle={() => { if (mobileBrowser) setMobileSidebarOpen(true); else setDesktopSidebarCollapsed(false) }} />}
          {!connecting && <>
            <strong>{filename}</strong>
            <InlineFeedbackAction
              ariaLabel={downloadConfirmedDocumentId === documentSession.id ? `Downloaded ${filename}` : `Download ${filename}`}
              feedback={downloadConfirmedDocumentId === documentSession.id ? 'Download starting' : undefined}
              icon={<Download size={15} />}
              label={`Download ${filename}`}
              onClick={() => startDownload(documentSession.id, content, filename)}
              title={downloadConfirmedDocumentId === documentSession.id ? 'Downloaded' : `Download ${filename}`}
            />
            {SNAPSHOT_SHARING_ENABLED && <InlineFeedbackAction
              ariaLabel={shareCopiedDocumentId === documentSession.id ? `Copied share link for ${filename}` : `Copy share link for ${filename}`}
              disabled={Boolean(parseError) || connecting}
              feedback={shareCopiedDocumentId === documentSession.id ? 'Link copied' : undefined}
              icon={<Share2 size={15} />}
              label={`Copy share link for ${filename}`}
              onClick={() => { void copyShareLink() }}
              title={shareCopiedDocumentId === documentSession.id ? 'Share link copied' : 'Copy share link'}
            />}
          </>}
        </div>
      </section>

      {routeError && <div className="share-notice error" role="alert">
        <span>{routeError}</span>
        <button className="button secondary" type="button" onClick={dismissRouteError}>Dismiss</button>
      </div>}

      {shareNotice?.documentId === documentSession.id && <div className="share-notice error" role="alert">
        <span>{shareNotice.message}</span>
        <button className="button secondary" type="button" onClick={() => setShareNotice(undefined)}>Dismiss</button>
      </div>}

      {workspaceConflicts.includes(documentSession.id) && <div className="document-error" role="alert">
        <span>This document changed or was deleted in another tab. Your draft is preserved.</span>
        <button className="button secondary" type="button" disabled={snapshot.saving} onClick={() => { void resolveBrowserConflict(false) }}>Use saved version</button>
        <button className="button secondary" type="button" disabled={snapshot.saving} onClick={() => { void resolveBrowserConflict(true) }}>Save draft as copy</button>
      </div>}
      {((snapshot.error && !workspaceConflicts.includes(documentSession.id)) || hostError || storageError) && <div className="document-error" role="alert">
        <span>{snapshot.error?.message || hostError || storageError}</span>
        {(token || localConnection.current) && <button className="button secondary" type="button" disabled={snapshot.saving} onClick={() => { void reloadLocal() }}>Reload local file</button>}
        {mode !== 'source' && !hostError && <button className="button secondary" type="button" onClick={() => setMode('source')}>Open source</button>}
        {hostError && <button className="button secondary" type="button" onClick={() => setHostError('')}>Dismiss</button>}
        {(storageError || (snapshot.error && !token)) && <button className="button secondary" type="button" onClick={() => { void (token ? persistWorkspace() : commitDocument(documentSession, content)).catch(() => undefined) }}>Retry browser save</button>}
      </div>}
      {recovery && <div className="recovery-notice">
        <span>Previous unsaved draft: {recovery.filename}</span>
        <button className="button secondary" type="button" onClick={() => download(recovery.content, recovery.filename)}>Download previous draft</button>
        <button className="button secondary" type="button" onClick={() => setRecovery(undefined)}>Dismiss</button>
      </div>}

      <section className="workspace">
        {connecting ? <p className="recovery-panel">{initialToken ? 'Opening local file…' : initialShareHash ? 'Opening shared document…' : 'Loading examples…'}</p> : (
          <ViewerBoundary key={`${documentSession.id}:${documentSession.viewerGeneration}`} onSource={() => setMode('source')}>
            {documentFormat(filename) === 'csv' ? <CSVContent
              key={documentSession.id}
              documentId={documentSession.id}
              revision={snapshot.revision}
              content={content}
              path={filename}
              metadata={documentSession.metadata}
              presentationState={documentSession.presentationState}
              onPresentationStateChange={updatePresentationState}
              onMetadataChange={updateSessionMetadata}
              onRequestMetadataPersistence={requestMetadataPersistence}
              metadataConversionConfirmation="host"
              sourceVisible={mode === 'source'}
              onSourceVisibleChange={(visible) => setMode(visible ? 'source' : 'view')}
              isDirty={snapshot.dirty}
              isSaving={snapshot.saving || (!token && documentSession.cacheable && workspaceSave.saving)}
              saveError={snapshot.error?.message || hostError || (!token && documentSession.cacheable ? storageError || (workspaceConflicts.includes(documentSession.id) ? 'This document has a save conflict.' : undefined) : undefined)}
              fillHeight
              edit={{
                isEditing: false,
                editContent: content,
                onEditChange: editSourceDraft,
                onCommitContent: commit,
              }}
            /> : <JSONContent
              key={documentSession.id}
              documentId={documentSession.id}
              revision={snapshot.revision}
              content={content}
              path={filename}
              metadata={documentSession.metadata}
              presentationState={documentSession.presentationState}
              onPresentationStateChange={updatePresentationState}
              onMetadataChange={updateSessionMetadata}
              onRequestMetadataPersistence={requestMetadataPersistence}
              metadataConversionConfirmation="host"
              sourceVisible={mode === 'source'}
              onSourceVisibleChange={(visible) => setMode(visible ? 'source' : 'view')}
              isDirty={snapshot.dirty}
              isSaving={snapshot.saving || (!token && documentSession.cacheable && workspaceSave.saving)}
              saveError={snapshot.error?.message || hostError || (!token && documentSession.cacheable ? storageError || (workspaceConflicts.includes(documentSession.id) ? 'This document has a save conflict.' : undefined) : undefined)}
              renderMarkdown={renderMarkdownBody}
              fillHeight
              edit={{
                isEditing: false,
                editContent: content,
                onEditChange: editSourceDraft,
                onCommitContent: commit,
              }}
            />}
          </ViewerBoundary>
        )}
      </section>
      <footer className="workspace-footer">
        <a className="brand" href="./" aria-label="JSON Views beta home">
          <span className="brand-mark" aria-hidden="true" />
          <span>JSON Views</span>
          <span className="beta-badge" aria-hidden="true">Beta</span>
        </a>
        <div className="workspace-actions">
          <a className="icon-link repository-link" href="https://github.com/script-it/json-views" target="_blank" rel="noreferrer" aria-label="GitHub repository"><Github size={18} /></a>
          <button className="icon-link" type="button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
        <a className="scriptit-attribution" href="https://script.it/" target="_blank" rel="noreferrer" aria-label="From Script.it">
          <span>From Script.it</span>
          <img src="./script-it-icon.svg" alt="" aria-hidden="true" />
        </a>
      </footer>
        </div>
      </div>
      {conversion && <div className="conversion-backdrop" role="presentation">
        <section className="conversion-dialog" data-jsonviews-metadata-persistence-dialog role="dialog" aria-modal="true" aria-labelledby="conversion-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="conversion-title">Create an object-root JSON document?</h2>
          <p>Saving this view requires converting this document to an object-root JSON file. This changes its file format or root shape, and other software may rely on the current structure.</p>
          <div className="conversion-preview" aria-label="Structure preview">
            <div className="conversion-preview-column">
              <strong className="conversion-preview-title" data-id="conversion-current-filename">{conversion.document.filename}</strong>
              <span className="conversion-preview-format">Current · {conversion.request.sourceFormat === 'csv' ? 'CSV' : conversion.request.sourceFormat === 'json-array' ? 'JSON array' : 'JSON'}</span>
              <pre>{conversion.request.sourceFormat === 'csv' ? 'header,row\n…' : conversion.request.sourceFormat === 'json-array' ? '[\n  …\n]' : conversion.baseSource}</pre>
            </div>
            <span aria-hidden="true">→</span>
            <div className="conversion-preview-column">
              <strong className="conversion-preview-title" data-id="conversion-proposed-filename">{availableConvertedFilename(conversion.request.proposedFilename, documents)}</strong>
              <span className="conversion-preview-format">New · Object-root JSON</span>
              <pre>{'{\n  "$jsonviews": { … },\n  "data": [ … ]\n}'}</pre>
            </div>
          </div>
          <p className="conversion-note">{conversion.request.sourceFormat === 'csv'
            ? 'The converted document includes your current data edits. The original CSV is always preserved.'
            : 'The converted document includes your current data edits. You can replace the original or keep it and create a JSON copy.'}</p>
          <div className="conversion-actions">
            <button className="button secondary" type="button" onClick={cancelConversion}>Cancel</button>
            {conversion.request.sourceFormat === 'json-array' && <button className="button secondary" type="button" onClick={() => { void replaceArrayOriginal() }}>Replace original</button>}
            <button className="button primary" type="button" onClick={createConvertedCopy}>Create JSON copy</button>
          </div>
        </section>
      </div>}
      {shareExplainer && <div className="conversion-backdrop" role="presentation">
        <section className="conversion-dialog share-explainer-dialog" role="dialog" aria-modal="true" aria-labelledby="share-explainer-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="share-explainer-title">How sharing works</h2>
          <p>JSON Views does not upload your file. It compresses a copy and embeds the data directly in the share URL.</p>
          <p><strong>Treat the link like the file itself.</strong> Anyone with the link can read its contents, so only share it with people you trust.</p>
          <p className="conversion-note">The link is a snapshot. Changes you make later will not update it.</p>
          <div className="conversion-actions">
            <button className="button secondary" type="button" onClick={() => setShareExplainer(undefined)}>Cancel</button>
            <button className="button primary" type="button" onClick={() => { void confirmShareExplainer() }}>Copy share link</button>
          </div>
        </section>
      </div>}
      {pendingShare && <div className="conversion-backdrop" role="presentation">
        <section className="conversion-dialog share-warning-dialog" role="dialog" aria-modal="true" aria-labelledby="share-warning-title" onMouseDown={(event) => event.stopPropagation()}>
          <h2 id="share-warning-title">{pendingShare.length > MAX_SHARE_LINK_LENGTH ? 'This file is too large to share as a link' : 'Copy this unusually long link?'}</h2>
          <p>Share links embed the file itself in the URL. No data is uploaded to or stored on a server.</p>
          {pendingShare.length > MAX_SHARE_LINK_LENGTH
            ? <p>This would create a {Math.ceil(pendingShare.length / 1024)} KB link that messaging apps or browsers may truncate. Download the file and share it directly instead.</p>
            : <p>Some messaging apps may not support a link this long.</p>}
          <div className="conversion-actions">
            <button className="button secondary" type="button" onClick={() => setPendingShare(undefined)}>Cancel</button>
            {pendingShare.length > MAX_SHARE_LINK_LENGTH
              ? <button className="button primary" type="button" onClick={() => {
                startDownload(pendingShare.documentId, pendingShare.source, pendingShare.filename)
                setPendingShare(undefined)
              }}>Download file</button>
              : <button className="button primary" type="button" onClick={() => { void copyCreatedShareLink(pendingShare) }}>Copy link</button>}
          </div>
        </section>
      </div>}
    </main>
    </JsonViewsProvider>
  )
}
