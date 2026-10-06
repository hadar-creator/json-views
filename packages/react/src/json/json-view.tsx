import { HtmlView } from './html-view.js'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Braces, LayoutGrid, Columns3, FileText, Search, Table2 } from 'lucide-react'
import { useJsonViewsRegistries } from '../widget-registry.js'
import { cn } from '../lib/cn.js'
import type { UiSize } from '../lib/ui-size.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../primitives/tabs.js'
import { Tooltip, TooltipContent, TooltipTrigger } from '../primitives/tooltip.js'
import { type ValuePath } from '@script-it/json-views-core'
import { compileJsonViewMetadata, schemaForJsonViewPath, type CompiledJsonViewMetadata, type CompiledJsonViewView } from '@script-it/json-views-core'
import { type JsonViewSchemaExternalWidgetRenderer } from './schema-value.js'
import { JsonViewAddView, JsonViewViewSettings, type JsonViewNewViewDraft } from './view-settings.js'
import { GeneralJsonView } from './viewers/general/general-json-view.js'
import { type JsonViewJsonEditing, type JsonViewerProps } from './view-types.js'
import { isRecordCollection, presentsRecordCollection, rawViewsFor, rawViewFor, uniqueViewName, uniqueViewId, jsonPathForValuePath, rowForPage } from './view-model.js'
import { Diagnostics } from './view-diagnostics.js'
import { GeneralRecordView, RecordView } from './record-view.js'
import { ProjectedTableView } from './table-view.js'
import { KanbanView } from './kanban-view.js'
import { useViewerState } from '../viewer-state.js'
import { TableCellOptionsContext } from '../structured-data/table-cell-options.js'

const VIEW_TAB_CLASS = 'h-7 shrink-0 gap-1.5 rounded-md px-2 py-0 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:shadow-none [&>svg]:shrink-0'

function slashPath(view: CompiledJsonViewView): string {
  const segments = view.path.segments.map((segment) => {
    if (segment.kind === 'property') return segment.key
    if (segment.kind === 'index') return String(segment.index)
    return '*'
  })
  return `/${segments.join('/')}`
}

function ViewTab({ children, id, path, value }: { children: ReactNode; id: string; path: string; value: string }) {
  const [tooltipOpen, setTooltipOpen] = useState(false)
  return (
    <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0"
          onBlur={() => setTooltipOpen(false)}
          onFocus={(event) => {
            if (event.target instanceof HTMLElement && event.target.matches(':focus-visible')) setTooltipOpen(true)
          }}
        >
          <TabsTrigger value={value} data-id={id} className={VIEW_TAB_CLASS}>{children}</TabsTrigger>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-80 break-all font-mono">{path}</TooltipContent>
    </Tooltip>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInferredSingleRecord(view: CompiledJsonViewView): boolean {
  return view.declarationIndex < 0 && Array.isArray(view.value)
    && view.value.length === 1 && isRecord(view.value[0])
}

function metadataWithViews(compiled: CompiledJsonViewMetadata, views: readonly unknown[]): Record<string, unknown> {
  const metadata = isRecord(compiled.metadata) ? compiled.metadata : {}
  return {
    ...metadata,
    version: 1,
    ...(metadata.schema === undefined && compiled.inference && Object.keys(compiled.inference.schema).length > 0
      ? { schema: compiled.inference.schema }
      : {}),
    views,
  }
}

function labelForPath(path: ValuePath, fallback: string): string {
  const last = path.at(-1)
  if (last === undefined) return fallback
  if (typeof last === 'number') return `Item ${last + 1}`
  const words = last.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : fallback
}

function AdaptiveView({
  forceTable = false,
  compiled,
  copyFileName,
  editing,
  filePath,
  fillHeight,
  onSaveView,
  onCurrentPathChange,
  query,
  rawView,
  renderExternalWidget,
  renderMarkdown,
  uiSize,
  view,
}: {
  forceTable?: boolean
  compiled: CompiledJsonViewMetadata
  copyFileName: string
  editing?: JsonViewJsonEditing
  filePath?: string
  fillHeight: boolean
  onSaveView?: (value: Record<string, unknown>) => Promise<void>
  onCurrentPathChange?: JsonViewerProps['onCurrentPathChange']
  query: string
  rawView?: Record<string, unknown>
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  renderMarkdown?: (content: string) => ReactNode
  uiSize?: UiSize
  view: CompiledJsonViewView
}) {
  const { widgets } = useJsonViewsRegistries()
  const descriptor = schemaForJsonViewPath(compiled.schema, view.sourcePath)?.descriptor
  const registered = descriptor && (widgets.get(descriptor.type) || widgets.getDisplay(descriptor.type) || renderExternalWidget)
  const singleInferredRecord = isInferredSingleRecord(view) && !forceTable && !registered
  if (singleInferredRecord) return <GeneralRecordView
    path={[...view.sourcePath, 0]}
    compiled={compiled}
    copyFileName={copyFileName}
    editing={editing}
    filePath={filePath}
    fillHeight={fillHeight}
    name={view.name}
    onCurrentPathChange={onCurrentPathChange}
    renderExternalWidget={renderExternalWidget}
    renderMarkdown={renderMarkdown}
    uiSize={uiSize}
  />
  const projected = presentsRecordCollection(view, forceTable) && !registered
  if (projected) return <ProjectedTableView compiled={compiled} copyFileName={copyFileName} editing={editing} filePath={filePath} fillHeight={fillHeight} onCurrentPathChange={onCurrentPathChange} onSaveView={onSaveView} query={query} rawView={rawView} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} uiSize={uiSize} view={view} />
  return (
    <GeneralJsonView
      root={compiled.root}
      initialPath={view.sourcePath}
      defaultKey={view.name}
      filePath={`${filePath ?? 'json'}#view:${view.id}`}
      editing={editing}
      onCurrentPathChange={onCurrentPathChange}
      renderExternalWidget={renderExternalWidget}
      renderMarkdown={renderMarkdown}
      schemaForPath={(path) => schemaForJsonViewPath(compiled.schema, path)?.descriptor}
      uiSize={uiSize}
      fillHeight={fillHeight}
      renderRecord={(target) => (
        <GeneralRecordView
          {...target}
          compiled={compiled}
          copyFileName={copyFileName}
          editing={editing}
          filePath={filePath}
          fillHeight={fillHeight}
          name={view.name}
          onCurrentPathChange={onCurrentPathChange}
          renderExternalWidget={renderExternalWidget}
          renderMarkdown={renderMarkdown}
          uiSize={uiSize}
        />
      )}
    />
  )
}

function PageView({
  compiled,
  copyFileName,
  editing,
  filePath,
  fillHeight,
  onCurrentPathChange,
  renderExternalWidget,
  renderMarkdown,
  uiSize,
  view,
}: Omit<Parameters<typeof AdaptiveView>[0], 'onSaveView' | 'query' | 'rawView'>) {
  const row = rowForPage(view)
  useEffect(() => {
    onCurrentPathChange?.(view.sourcePath)
  }, [onCurrentPathChange, view.sourcePath])
  if (!row) return null
  return <RecordView compiled={compiled} copyFileName={copyFileName} editing={editing} filePath={filePath} fillHeight={fillHeight} onCurrentPathChange={onCurrentPathChange} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} row={row} uiSize={uiSize} view={view} />
}

function ConfiguredView(props: Omit<Parameters<typeof AdaptiveView>[0], 'view'> & { view: CompiledJsonViewView }) {
  if (props.view.display === 'html') return <HtmlView {...props} />
  if (props.view.display === 'kanban') return <KanbanView {...props} />
  if (props.view.declarationIndex >= 0
    && props.view.value !== null
    && typeof props.view.value === 'object'
    && !Array.isArray(props.view.value)
    && !isRecordCollection(props.view.value)) {
    return <PageView {...props} />
  }
  return <AdaptiveView {...props} />
}

export function JsonViewer({
  compiled,
  defaultKey,
  editing,
  filePath,
  fillHeight = false,
  onCurrentPathChange,
  renderExternalWidget,
  renderMarkdown,
  sourceControl, sourceContent, sourceVisible, onSourceVisibleChange,
  tableCells,
  uiSize,
  viewsEnabled = true,
  tabularRoot = false,
}: JsonViewerProps) {
  const { types } = useJsonViewsRegistries()
  const viewerState = useViewerState()
  const firstViewTab = viewsEnabled && compiled.views[0] ? `view:${compiled.views[0].id}` : 'root'
  const initialActiveTab = viewerState.activeView ?? firstViewTab
  const [activeTab, setActiveTab] = useState(initialActiveTab)
  const [queries, setQueries] = useState<Record<string, string>>(() => viewerState.queries.toRecord())
  const [searchOpenTab, setSearchOpenTab] = useState<string | undefined>(() => queries[initialActiveTab] ? initialActiveTab : undefined)
  const [currentPaths, setCurrentPaths] = useState<Record<string, ValuePath>>({})
  const [sourcePaths, setSourcePaths] = useState<Record<string, readonly ValuePath[] | undefined>>({})
  const searchInput = useRef<HTMLInputElement>(null)
  const usableTabs = useMemo(() => new Set(['root', ...(viewsEnabled ? compiled.views.map((view) => `view:${view.id}`) : [])]), [compiled.views, viewsEnabled])
  const structuredTab = usableTabs.has(activeTab) ? activeTab : firstViewTab
  const selectedTab = sourceVisible && sourceContent ? 'source' : structuredTab
  const rootView = useMemo<CompiledJsonViewView>(() => ({
    id: '__root__',
    name: defaultKey,
    path: { source: '$', root: '$', segments: [] },
    sourcePath: [],
    value: compiled.root,
    display: 'adaptive',
    sort: [],
    declarationIndex: -1,
    metadataPath: [],
  }), [compiled.root, defaultKey])
  const declaredView = viewsEnabled ? compiled.views.find((view) => `view:${view.id}` === structuredTab) : undefined
  const activeView = declaredView ?? rootView
  const rememberCurrentPath = useCallback((path: ValuePath, paths?: readonly ValuePath[]) => {
    setCurrentPaths((current) => JSON.stringify(current[selectedTab]) === JSON.stringify(path)
      ? current
      : { ...current, [selectedTab]: path })
    setSourcePaths((current) => JSON.stringify(current[selectedTab]) === JSON.stringify(paths)
      ? current
      : { ...current, [selectedTab]: paths })
  }, [selectedTab])
  const currentPath = currentPaths[structuredTab] ?? activeView.sourcePath
  const currentPathKey = JSON.stringify(currentPath)
  const sourcePathsKey = JSON.stringify(sourcePaths[selectedTab])
  const viewSaveMode = editing?.viewSaveMode ?? 'automatic'
  const viewDraftKey = JSON.stringify([structuredTab, jsonPathForValuePath(currentPath)])
  const activeRawView = declaredView ? rawViewFor(compiled, declaredView) : undefined
  const rawViews = rawViewsFor(compiled)
  const rootDraftRawView = useMemo<Record<string, unknown>>(() => {
    const name = uniqueViewName(labelForPath(currentPath, Array.isArray(compiled.root) ? 'Data' : defaultKey), rawViews)
    return { id: uniqueViewId(name, rawViews), name, path: jsonPathForValuePath(currentPath) }
  }, [compiled.root, currentPath, defaultKey, rawViews])
  const settingsRawView = activeRawView ?? rootDraftRawView
  const settingsDeclarationIndex = declaredView?.declarationIndex ?? rawViews.length
  const settingsView = useMemo(() => {
    if (declaredView) return declaredView
    const candidate = compileJsonViewMetadata(compiled.root, types, {
      metadata: metadataWithViews(compiled, [...rawViews, rootDraftRawView]),
    })
    return candidate.views.find((view) => view.declarationIndex === rawViews.length)
  }, [compiled, declaredView, rawViews, rootDraftRawView, types, types.version])
  const [previewState, setPreviewState] = useState<{ key: string; value?: Record<string, unknown> }>(() => {
    const cached = viewerState.viewDrafts.get(viewDraftKey)
    return { key: viewDraftKey, ...(cached ? { value: cached } : {}) }
  })
  const previewRawView = previewState.key === viewDraftKey
    ? previewState.value
    : viewerState.viewDrafts.get(viewDraftKey)
  const previewView = useMemo(() => {
    if (!previewRawView) return undefined
    const views = [...rawViews]
    if (declaredView) views[declaredView.declarationIndex] = previewRawView
    else views.push(previewRawView)
    const candidate = compileJsonViewMetadata(compiled.root, types, { metadata: metadataWithViews(compiled, views) })
    return candidate.views.find((view) => view.declarationIndex === settingsDeclarationIndex)
  }, [compiled, declaredView, previewRawView, rawViews, settingsDeclarationIndex, types, types.version])
  const previewSettings = useCallback((next: Record<string, unknown> | undefined) => {
    setPreviewState((current) => current.key === viewDraftKey && JSON.stringify(current.value) === JSON.stringify(next)
      ? current
      : { key: viewDraftKey, ...(next ? { value: next } : {}) })
    if (next) viewerState.viewDrafts.set(viewDraftKey, next)
    else viewerState.viewDrafts.delete(viewDraftKey)
  }, [viewDraftKey, viewerState])
  const renderedView = previewView ?? activeView
  const renderedRawView = previewView ? previewRawView : activeRawView
  const query = queries[selectedTab] ?? ''
  const hasTabs = viewsEnabled && compiled.views.length > 0
  const addViewUnavailableReason = currentPath[0] === '$jsonviews'
    ? '$jsonviews stores internal view configuration, so it cannot be saved as another view.'
    : editing?.canEditViews === false
      ? editing.viewCreationUnavailableReason ?? 'This document’s view metadata cannot be saved.'
      : undefined
  const canAddViews = viewsEnabled && editing !== undefined && compiled.root !== null
    && (typeof compiled.root === 'object' || compiled.metadataSource === 'external')
  const canPersistViews = canAddViews && editing.canEditViews !== false
  const settingsUnavailableReason = !declaredView && currentPath[0] === '$jsonviews'
    ? '$jsonviews stores internal view configuration, so it cannot be configured as a data view.'
    : settingsView && (declaredView !== undefined || presentsRecordCollection(settingsView))
      ? undefined
      : 'This location uses the natural JSON layout, so it has no configurable table view.'
  const forceTable = tabularRoot && renderedView.sourcePath.length === 0
  const searchable = renderedView.display !== 'html' && presentsRecordCollection(renderedView, forceTable)
  const searchOpen = searchable && (searchOpenTab === selectedTab || query.length > 0)
  const hasToolbar = hasTabs || searchable || compiled.diagnostics.length > 0
    || canAddViews || sourceControl !== undefined
    || (editing !== undefined && settingsRawView !== undefined)

  useEffect(() => {
    viewerState.setActiveView(selectedTab)
  }, [selectedTab, viewerState])

  useEffect(() => {
    if (selectedTab !== 'source') onCurrentPathChange?.(currentPath, sourcePaths[selectedTab])
  }, [currentPathKey, sourcePathsKey, selectedTab, onCurrentPathChange])

  const persistViews = useCallback(async (views: readonly unknown[], requiredIndex?: number) => {
    if (!editing) throw new Error('This JSON is read-only')
    if (requiredIndex !== undefined) {
      const candidate = compileJsonViewMetadata(compiled.root, types, { metadata: metadataWithViews(compiled, views) })
      const valid = candidate.views.some((view) => view.declarationIndex === requiredIndex)
      const issue = candidate.diagnostics.find((item) => item.scope === 'view' && item.metadataPath[2] === requiredIndex)
      if (!valid) throw new Error(issue?.message ?? 'The view is not valid for this JSON')
    }
    await editing.replaceViews(views)
  }, [compiled, editing, types, types.version])

  const saveActiveView = useCallback(async (next: Record<string, unknown>) => {
    if (!declaredView) throw new Error('Select a saved view first')
    const nextViews = [...rawViews]
    nextViews[declaredView.declarationIndex] = next
    await persistViews(nextViews, declaredView.declarationIndex)
  }, [declaredView, persistViews, rawViews])

  const saveSettingsView = useCallback(async (next: Record<string, unknown>) => {
    if (declaredView) {
      await saveActiveView(next)
    } else {
      const nextViews = [...rawViews, next]
      await persistViews(nextViews, nextViews.length - 1)
      if (typeof next.id === 'string') setActiveTab(`view:${next.id}`)
    }
    // An older save must not discard a newer working configuration.
    if (JSON.stringify(viewerState.viewDrafts.get(viewDraftKey)) === JSON.stringify(next)) previewSettings(undefined)
  }, [declaredView, persistViews, rawViews, saveActiveView, viewerState, viewDraftKey, previewSettings])

  const settingsDraftRawView = previewRawView
    ? previewRawView
    : settingsRawView
  const columnRawView = viewSaveMode === 'explicit'
    ? settingsDraftRawView
    : renderedRawView
  const saveColumnView = canPersistViews
    ? viewSaveMode === 'explicit'
      ? async (next: Record<string, unknown>) => { previewSettings(next) }
      : declaredView && activeRawView
        ? async (next: Record<string, unknown>) => {
          previewSettings(next)
          try {
            await saveSettingsView(next)
          } finally {
            // The document owns pending and failed writes once submitted.
            if (JSON.stringify(viewerState.viewDrafts.get(viewDraftKey)) === JSON.stringify(next)) previewSettings(undefined)
          }
        }
        : undefined
    : undefined

  const addView = async (option: JsonViewNewViewDraft) => {
    const name = uniqueViewName(option.name, rawViews)
    const id = uniqueViewId(name, rawViews)
    const nextView: Record<string, unknown> = { id, name, path: option.path }
    if (option.display === 'kanban' && option.groupBy) {
      nextView.display = 'kanban'
      nextView.groupBy = option.groupBy
    }
    const nextViews = [...rawViews, nextView]
    await persistViews(nextViews, nextViews.length - 1)
    setActiveTab(`view:${id}`)
  }

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus()
  }, [searchOpen])

  const setQuery = (value: string) => {
    setQueries((current) => ({ ...current, [selectedTab]: value }))
    viewerState.queries.set(selectedTab, value)
  }

  const closeSearch = () => {
    if (!query) setSearchOpenTab(undefined)
  }

  return (
    <TableCellOptionsContext.Provider value={tableCells}>
    <Tabs value={selectedTab} onValueChange={(value) => { if (value !== 'source') setActiveTab(value); onSourceVisibleChange?.(value === 'source') }} className={cn('flex min-h-0 flex-1 flex-col bg-background text-foreground', fillHeight && 'h-full')}>
      <div data-id="json-viewer-content" className={cn('flex min-h-0 w-full max-w-none flex-1 flex-col px-3 py-4 sm:px-6 sm:py-5', fillHeight && 'h-full')}>
        {hasToolbar && (
          <div data-id="json-viewer-toolbar" className="relative flex min-h-8 shrink-0 flex-nowrap items-center gap-x-2">
            <div data-id="jsonView-toolbar-actions" className="ml-auto flex h-8 shrink-0 items-center gap-1">
              {selectedTab !== 'source' && searchable && (
                searchOpen ? (
                  <label data-id="jsonView-search-control" className="flex h-7 w-44 items-center overflow-hidden rounded-md border border-transparent bg-transparent transition-[width,background-color] focus-within:border-border focus-within:bg-card sm:w-52">
                    <Search className="mx-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <input
                      ref={searchInput}
                      aria-label="Search rows"
                      className="h-full min-w-0 flex-1 bg-transparent pr-2 text-xs outline-none placeholder:text-muted-foreground"
                      value={query}
                      onBlur={closeSearch}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setQuery('')
                          setSearchOpenTab(undefined)
                        }
                      }}
                      placeholder="Type to search…"
                    />
                  </label>
                ) : (
                  <button data-id="jsonView-search-button" type="button" aria-label="Search rows" title="Search" className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => setSearchOpenTab(selectedTab)}>
                    <Search className="h-3.5 w-3.5" />
                  </button>
                )
              )}
              {editing && settingsRawView && (
                <JsonViewViewSettings
                  key={typeof settingsDraftRawView.id === 'string' ? settingsDraftRawView.id : '__view_settings__'}
                  hasUnsavedChanges={previewRawView !== undefined}
                  view={previewView ?? settingsView ?? activeView}
                  rawView={activeView.display === 'html' ? activeRawView ?? settingsDraftRawView : settingsDraftRawView}
                  schema={compiled.schema}
                  disabled={editing.saving}
                  saveMode={viewSaveMode}
                  saveUnavailableReason={canPersistViews ? undefined : editing.viewCreationUnavailableReason}
                  unavailableReason={settingsUnavailableReason}
                  onPreview={previewSettings}
                  onSave={saveSettingsView}
                  onDuplicate={declaredView && activeRawView && canPersistViews ? async () => {
                    const name = uniqueViewName(`${declaredView.name} copy`, rawViews)
                    const id = uniqueViewId(name, rawViews)
                    const duplicate = { ...activeRawView, id, name }
                    const nextViews = [...rawViews]
                    const duplicateIndex = declaredView.declarationIndex + 1
                    nextViews.splice(duplicateIndex, 0, duplicate)
                    await persistViews(nextViews, duplicateIndex)
                    setActiveTab(`view:${id}`)
                  } : undefined}
                  onDelete={declaredView && canPersistViews ? async () => {
                    const nextViews = [...rawViews]
                    nextViews.splice(declaredView.declarationIndex, 1)
                    await persistViews(nextViews)
                    setActiveTab('root')
                  } : undefined}
                />
              )}
              {sourceControl}
              <Diagnostics compiled={compiled} />
            </div>
            {(hasTabs || canAddViews || sourceContent) && (
              <div data-id="jsonView-view-controls" className="flex min-w-0 flex-1 items-center">
                {canAddViews && <JsonViewAddView key="add-view" align="start" root={compiled.root} schema={compiled.schema} currentPath={jsonPathForValuePath(currentPath)} disabled={editing.saving} onAdd={addView} unavailableReason={addViewUnavailableReason} />}
                {(hasTabs || sourceContent) && (
                  <TabsList key="view-tabs" data-id="jsonView-json-tabs" className="h-8 min-w-0 flex-initial justify-start gap-0.5 overflow-x-auto overscroll-x-contain rounded-none bg-transparent p-0">
                    {compiled.views.map((view) => {
                      const Icon = view.display === 'html' ? LayoutGrid : view.display === 'kanban'
                        ? Columns3
                        : isInferredSingleRecord(view) || (view.value !== null && typeof view.value === 'object' && !Array.isArray(view.value) && !isRecordCollection(view.value))
                          ? FileText
                          : Table2
                      return <ViewTab key={view.id} id={`jsonView-json-tab-${view.id}`} value={`view:${view.id}`} path={slashPath(view)}><Icon className="h-3.5 w-3.5" />{view.name}</ViewTab>
                    })}
                    <ViewTab id="jsonView-json-tab-root" value="root" path={isInferredSingleRecord(rootView) && !forceTable ? 'Root record' : 'Root table'}>
                      {isInferredSingleRecord(rootView) && !forceTable ? <FileText className="h-3.5 w-3.5" /> : <Table2 className="h-3.5 w-3.5" />}
                      <span className="sr-only">{isInferredSingleRecord(rootView) && !forceTable ? 'Record' : 'Table'}</span>
                    </ViewTab>
                    {sourceContent && <ViewTab id="jsonView-json-tab-source" value="source" path="Source"><Braces className="h-3.5 w-3.5" /><span className="sr-only">Source</span></ViewTab>}
                  </TabsList>
                )}
              </div>
            )}
          </div>
        )}
        <TabsContent value={selectedTab} className={cn('mt-2 min-w-0', fillHeight && 'flex min-h-0 flex-1 flex-col')}>
          {selectedTab === 'source' ? sourceContent : <ConfiguredView key={selectedTab} forceTable={forceTable} compiled={compiled} copyFileName={defaultKey === 'root' ? 'document.json' : defaultKey} editing={editing} filePath={filePath} fillHeight={fillHeight} onCurrentPathChange={rememberCurrentPath} onSaveView={saveColumnView} query={query} rawView={columnRawView} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} uiSize={uiSize} view={renderedView} />}
        </TabsContent>
      </div>
    </Tabs>
    </TableCellOptionsContext.Provider>
  )
}

export type { JsonViewJsonEditing } from './view-types.js'
