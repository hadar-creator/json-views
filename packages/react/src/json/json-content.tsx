/** Format-neutral structured document orchestration with JSON-compatible wrappers. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  compileJsonViewMetadata, projectJsonViewCollection, convertToJsonViewsDocument, rebaseJsonViewsMetadata, csvFormat, formatJsonSource, getValueAtPath,
  inspectJsonSource, jsonFormatForSource, jsonObjectFormat, setJsonValueAtPath, schemaForJsonViewPath,
  jsonSourceRangesAtPaths, removeJsonValuesInSource, upsertJsonObjectPropertyInSource, upsertJsonObjectPropertiesInSource, type JsonSourceDiagnostic, type JsonDocumentSave,
  type StructuredDocumentAdapter, type ValuePath, type ValueReplacement,
} from '@script-it/json-views-core'
import { JsonViewsSurface } from '../surface.js'
import type { UiSize } from '../lib/ui-size.js'
import type { FileContentEditState } from '../file-content-edit-state.js'
import { useOptimisticTextDocument } from '../structured-data/use-optimistic-text-document.js'
import { useMetadataPersistence, type MetadataPersistence } from '../structured-data/use-metadata-persistence.js'
import type { JsonViewsTableCellOptions } from '../structured-data/table-cell-options.js'
import { JsonViewer } from './json-view.js'
import type { JsonViewSchemaExternalWidgetRenderer } from './schema-value.js'
import { useJsonViewsRegistries } from '../widget-registry.js'
import { assertSourceReplacementSafe, assertUnambiguousSourcePath, replacementIssue } from './source-edit-capabilities.js'
import { JsonSourceLiteralsProvider } from './source-literals.js'
import { JsonRendererBoundary, JsonSourceRecovery } from './source-recovery.js'
import { TooltipProvider } from '../primitives/tooltip.js'
import type { JsonViewsPresentationState } from '../viewer-state.js'
import { ViewSaveStatus } from './view-save-status.js'
import { SourceEditor, SourceFormatButton } from './json-source-editor.js'
import { EditBaseContext } from '../structured-data/edit-base.js'
import { prefersSource } from './source-default.js'
import { coversAllDocumentData } from './source-selection.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function withOptionColor(metadata: Record<string, unknown>, schemaPath: string, optionValue: string, color: string): Record<string, unknown> {
  const schema = isRecord(metadata.schema) ? metadata.schema : {}
  const descriptor = schema[schemaPath]
  if (!isRecord(descriptor) || (descriptor.type !== 'select' && descriptor.type !== 'multi-select')) {
    throw new TypeError('Only select and multi-select annotations can have option colors')
  }
  const optionColors = isRecord(descriptor.optionColors) ? descriptor.optionColors : {}
  return {
    ...metadata, version: 1,
    schema: { ...schema, [schemaPath]: { ...descriptor, optionColors: { ...optionColors, [optionValue]: color } } },
  }
}

function filenameForConversion(path: string | undefined): string {
  const filename = path?.split('/').filter(Boolean).pop() || 'document'
  return `${filename.replace(/\.(?:csv|json)$/i, '') || 'document'}.json`
}

function clonedRootWith(root: unknown, replacements: readonly ValueReplacement[]): unknown {
  const clone: unknown = structuredClone(root)
  if (clone === null || typeof clone !== 'object') throw new TypeError('The document root cannot be edited structurally')
  replacements.forEach(({ path, value }) => setJsonValueAtPath(clone, path, value))
  return clone
}

export type JsonViewClearBehavior = 'null' | 'remove'
export type { MetadataPersistence } from '../structured-data/use-metadata-persistence.js'

export interface ObjectRootConversionRequest {
  reason: 'save-view' | 'save-schema' | 'save-option-colors' | 'unsupported-csv-value'
  sourceFormat: 'json-array' | 'csv' | 'json-scalar'
  proposedFilename: string
  convertedSource: string
}

export type MetadataPersistenceRequest = (request: ObjectRootConversionRequest) => void | boolean | Promise<void | boolean>

export interface StructuredDataContentProps {
  content: string
  adapter: StructuredDocumentAdapter<unknown>
  documentId?: string
  revision?: string
  theme?: 'light' | 'dark' | 'inherit'
  portalContainer?: HTMLElement | null
  /** Initial visual state, restored on mount or documentId change. Cache separately from JSON metadata. */
  presentationState?: JsonViewsPresentationState
  onPresentationStateChange?: (state: JsonViewsPresentationState) => void
  metadata?: unknown
  metadataPersistence?: MetadataPersistence
  onMetadataChange?: (metadata: Record<string, unknown>) => Promise<void>
  onRequestMetadataPersistence?: MetadataPersistenceRequest
  /** Use host confirmation when the persistence callback presents its own conversion dialog. */
  metadataConversionConfirmation?: 'viewer' | 'host'
  path?: string
  uiSize?: UiSize
  fillHeight?: boolean
  edit?: FileContentEditState
  /** Persist visual edits. Omit for a read-only source. Takes precedence over edit.onCommitContent. */
  onSave?: JsonDocumentSave
  isSaving?: boolean
  /** Host dirty state displayed in the embedded source toolbar. */
  isDirty?: boolean
  /** Host save error displayed in the embedded source toolbar. */
  saveError?: string
  /** Controlled raw-source mode. Omit to let the embedded frame own its source toggle. */
  sourceVisible?: boolean
  onSourceVisibleChange?: (visible: boolean) => void
  clearBehavior?: JsonViewClearBehavior
  /** Clamps tall table cells and reveals one on selection (default), or lets rows grow to fit. */
  tableCells?: JsonViewsTableCellOptions
  onDraftRowsChange?: (paths: readonly ValuePath[]) => void
  renderMarkdown?: (content: string) => ReactNode
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  /** @deprecated Use onRequestMetadataPersistence. */
  allowRootArrayWrapping?: boolean
}

export interface JSONContentProps extends Omit<StructuredDataContentProps, 'adapter'> {}
export interface CSVContentProps extends Omit<StructuredDataContentProps, 'adapter'> {}

export function StructuredDataContent(props: StructuredDataContentProps) {
  return <JsonViewsSurface key={props.documentId ?? props.path ?? 'document'} theme={props.theme} portalContainer={props.portalContainer}
    presentationState={props.presentationState} onPresentationStateChange={props.onPresentationStateChange}>
    <StructuredDataContentSession key={`${props.documentId ?? props.path ?? 'document'}:${props.adapter.format}`} {...props} />
  </JsonViewsSurface>
}

export function JSONContent(props: JSONContentProps) {
  let adapter = jsonObjectFormat as StructuredDocumentAdapter<unknown>
  // The editable draft is the current document while the source editor is open.
  // Hosts may keep `content` at the last persisted revision until a save finishes,
  // so choosing the adapter from it would incorrectly reject a valid root-shape
  // change (for example, an object replaced with an array).
  try { adapter = jsonFormatForSource(props.edit?.isEditing ? props.edit.editContent : props.content) as StructuredDocumentAdapter<unknown> } catch { /* Recovery handles invalid JSON. */ }
  return <StructuredDataContent {...props} adapter={adapter} />
}

export function CSVContent(props: CSVContentProps) {
  return <StructuredDataContent {...props} adapter={csvFormat as StructuredDocumentAdapter<unknown>} />
}

function StructuredDataContentSession({
  content, adapter, documentId, revision, metadata, metadataPersistence, presentationState,
  onMetadataChange, onRequestMetadataPersistence, metadataConversionConfirmation = 'viewer', allowRootArrayWrapping = true,
  path, uiSize, fillHeight = false, edit, onSave, isSaving, isDirty, saveError, sourceVisible, onSourceVisibleChange, clearBehavior = 'null',
  tableCells, onDraftRowsChange, renderExternalWidget, renderMarkdown,
}: StructuredDataContentProps) {
  const { types } = useJsonViewsRegistries()
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [draftRows, setDraftRows] = useState<ValuePath[]>([])
  const [localSourceVisible, setLocalSourceVisible] = useState(() => presentationState?.activeView ? presentationState.activeView === 'source' : adapter.format !== 'csv' && prefersSource(content, metadata))
  const [currentViewPaths, setCurrentViewPaths] = useState<readonly ValuePath[]>([[]])
  const rememberSourcePaths = useCallback((path: ValuePath, paths?: readonly ValuePath[]) => {
    setCurrentViewPaths(paths ?? [path])
  }, [])
  const document = useOptimisticTextDocument({
    content, documentKey: documentId ?? path, revision,
    saveContent: onSave ?? edit?.onCommitContent, saving: isSaving ?? edit?.isSaving,
  })
  const showingSource = sourceVisible ?? (edit?.isEditing === true || localSourceVisible)
  const setShowingSource = useCallback((visible: boolean) => {
    if (sourceVisible === undefined) setLocalSourceVisible(visible)
    onSourceVisibleChange?.(visible)
  }, [onSourceVisibleChange, sourceVisible])
  const editSource = useCallback((nextContent: string) => {
    document.edit(nextContent)
    edit?.onEditChange(nextContent)
  }, [document.edit, edit?.onEditChange])
  useEffect(() => {
    if (sourceVisible === undefined && edit?.isEditing && edit.editContent !== document.content) {
      document.edit(edit.editContent)
    }
  }, [document.content, document.edit, edit?.editContent, edit?.isEditing, sourceVisible])
  const parsed = useMemo(() => {
    try { return { ...adapter.inspect(document.content), error: null as string | null } }
    catch (cause) {
      return { root: undefined, state: undefined, diagnostics: [], error: cause instanceof Error ? cause.message : `Invalid ${adapter.format}` }
    }
  }, [adapter, document.content])
  useEffect(() => {
    if (parsed.error && !showingSource) setShowingSource(true)
  }, [parsed.error, showingSource, setShowingSource])
  const embedded = adapter.format !== 'csv' && isRecord(parsed.root) && Object.prototype.hasOwnProperty.call(parsed.root, '$jsonviews')
  const { persistence, effectiveMetadata, saveSessionMetadata } = useMetadataPersistence({
    metadata: embedded ? undefined : metadata,
    mode: embedded ? 'embedded' : metadataPersistence ?? 'session', format: adapter.format, onMetadataChange,
  })
  const compilation = useMemo(() => {
    try {
      const options = { ...(effectiveMetadata !== undefined ? { metadata: effectiveMetadata } : {}), ...(draftRows.length > 0 ? { suppressRequiredPaths: draftRows } : {}) }
      return { compiled: compileJsonViewMetadata(parsed.root, types, options), error: undefined }
    } catch (cause) {
      return { compiled: undefined, error: cause instanceof Error ? cause.message : 'Could not compile annotations' }
    }
  }, [parsed.root, types, types.version, effectiveMetadata, draftRows])
  const compiled = compilation.compiled
  const metadataWritable = compiled?.status !== 'unsupported-version' && compiled?.status !== 'invalid'
    && (embedded || metadata === undefined || onMetadataChange !== undefined)
  const formatDiagnostics = parsed.diagnostics
  const sourceDiagnostics = useMemo<readonly JsonSourceDiagnostic[]>(() => {
    if (adapter.format === 'csv') return []
    try { return inspectJsonSource(document.content).diagnostics } catch { return [] }
  }, [adapter.format, document.content])
  const structuredEditingAllowed = !formatDiagnostics.some((item) => item.severity === 'error')
  const commitSource = useCallback((source: string) => document.commit(() => source), [document.commit])
  const sourcePersistenceOwnedByHost = sourceVisible !== undefined || edit?.isEditing === true
  useEffect(() => {
    if (sourcePersistenceOwnedByHost || !document.canCommit || !document.dirty || document.saving || document.error || parsed.error) return
    const timer = setTimeout(() => { void commitSource(document.content).catch(() => {}) }, 300)
    return () => clearTimeout(timer)
  }, [commitSource, document.canCommit, document.content, document.dirty, document.error, document.saving, parsed.error, sourcePersistenceOwnedByHost])

  const currentMetadata = useCallback((): Record<string, unknown> => {
    if (isRecord(effectiveMetadata)) return effectiveMetadata
    if (isRecord(compiled?.metadata)) return compiled.metadata
    return { version: 1, schema: {}, views: [] }
  }, [compiled?.metadata, effectiveMetadata])

  const requestConversion = useCallback(async (
    reason: ObjectRootConversionRequest['reason'], nextMetadata: Record<string, unknown>, root: unknown = parsed.root,
  ) => {
    if (adapter.format !== 'json-array' && adapter.format !== 'csv') throw new TypeError('This document does not require conversion')
    if (!onRequestMetadataPersistence) throw new Error('Saving annotations requires converting this document to object-root JSON')
    const accepted = await onRequestMetadataPersistence({
      reason, sourceFormat: adapter.format, proposedFilename: filenameForConversion(path),
      convertedSource: convertToJsonViewsDocument({
        root, metadata: nextMetadata, sourceFormat: adapter.format,
        ...(root === parsed.root && adapter.format === 'json-array' ? { source: document.content } : {}),
      }),
    })
    if (accepted === false) throw new Error('Conversion cancelled')
  }, [adapter.format, document.content, onRequestMetadataPersistence, parsed.root, path])

  const isDraftRow = useCallback((valuePath: ValuePath) => (
    draftRows.some((candidate) => candidate.length <= valuePath.length && candidate.every((part, index) => part === valuePath[index]))
  ), [draftRows])
  const dismissDraftForPath = useCallback((valuePath: ValuePath) => {
    setDraftRows((current) => current.filter((candidate) => !(candidate.length <= valuePath.length && candidate.every((part, index) => part === valuePath[index]))))
  }, [])

  const replaceValues = useCallback(async (replacements: readonly ValueReplacement[]) => {
    if (adapter.format === 'csv' && replacements.some((replacement) => !adapter.canRepresent(replacement.value).representable)) {
      await requestConversion('unsupported-csv-value', currentMetadata(), clonedRootWith(parsed.root, replacements))
      return
    }
    await document.commit((source) => {
      if (adapter.format !== 'csv') assertSourceReplacementSafe(source, replacements.map((replacement) => replacement.path))
      for (const replacement of replacements) {
        const descriptor = compiled && schemaForJsonViewPath(compiled.schema, replacement.path)?.descriptor
        const issue = descriptor && types.validate(replacement.value, descriptor)
        if (issue) throw new Error(issue)
      }
      return adapter.replaceMany(source, adapter.inspect(source).state, replacements)
    })
    replacements.forEach((replacement) => dismissDraftForPath(replacement.path))
  }, [adapter, compiled, currentMetadata, dismissDraftForPath, document, parsed.root, requestConversion, types])
  const replaceValue = useCallback((valuePath: ValuePath, value: unknown) => replaceValues([{ path: valuePath, value }]), [replaceValues])
  const removeValues = useCallback(async (valuePaths: ValuePath[]) => {
    await document.commit((source) => {
      if (adapter.format !== 'csv') assertUnambiguousSourcePath(source, valuePaths)
      return adapter.removeMany(source, adapter.inspect(source).state, valuePaths)
    })
    valuePaths.forEach(dismissDraftForPath)
  }, [adapter, dismissDraftForPath, document])
  const clearValue = useCallback((valuePath: ValuePath) => (
    clearBehavior === 'remove' ? removeValues([valuePath]) : replaceValue(valuePath, adapter.format === 'csv' ? '' : null)
  ), [adapter.format, clearBehavior, removeValues, replaceValue])
  const commitGeneratedSource = useCallback((transform: (source: string) => string) => document.commit((source) => {
    const next = transform(source)
    return adapter.format === 'csv' ? next : formatJsonSource(next)
  }), [adapter.format, document.commit])
  const appendArrayItem = useCallback(async (arrayPath: ValuePath, value: unknown) => {
    let appendValue = value
    if (adapter.format === 'csv' && isRecord(value)) {
      // Inferred date/select columns use null for a new blank JSON row; CSV's
      // native blank is an empty cell, so keep ordinary row creation native.
      const csvRow = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === null ? '' : item]))
      appendValue = csvRow
      if (Object.values(csvRow).some((item) => !adapter.canRepresent(item).representable)) {
        await requestConversion('unsupported-csv-value', currentMetadata(), Array.isArray(parsed.root) ? [...parsed.root, value] : parsed.root)
        return
      }
    }
    await commitGeneratedSource((source) => {
      if (adapter.format !== 'csv') assertUnambiguousSourcePath(source, [arrayPath])
      return adapter.append(source, adapter.inspect(source).state, arrayPath, appendValue)
    })
  }, [adapter, currentMetadata, commitGeneratedSource, parsed.root, requestConversion])
  const registerDraftRow = useCallback((rowPath: ValuePath) => {
    setDraftRows((current) => current.some((candidate) => candidate.length === rowPath.length && candidate.every((part, index) => part === rowPath[index])) ? current : [...current, rowPath])
  }, [])
  useEffect(() => {
    onDraftRowsChange?.(draftRows)
    return () => { onDraftRowsChange?.([]) }
  }, [draftRows, onDraftRowsChange])

  const addColumn = useCallback(async (
    arrayPath: ValuePath,
    property: string,
    schemaPath: string,
    descriptor: Record<string, unknown>,
    viewDeclarationIndex: number,
  ) => {
    if (!metadataWritable) throw new Error('These annotations cannot be edited')
    if (adapter.format !== 'json-object' || persistence !== 'embedded') throw new Error('Columns can only be added to object-root JSON documents')
    await commitGeneratedSource((source) => {
      assertUnambiguousSourcePath(source, [arrayPath])
      assertSourceReplacementSafe(source, [['$jsonviews']])
      const root: unknown = JSON.parse(source)
      const rows = getValueAtPath(root, arrayPath)
      if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) throw new TypeError('Columns can only be added to an array of objects')
      if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, property))) throw new Error(`A property named ${property} already exists`)

      const initialValue = descriptor.type === 'checkbox' ? false
        : descriptor.type === 'number' ? 0
          : descriptor.type === 'multi-select' ? []
            : ['text', 'markdown', 'html'].includes(String(descriptor.type)) ? ''
              : null
      const nextSource = upsertJsonObjectPropertiesInSource(source, rows.map((_, index) => ({
        objectPath: [...arrayPath, index], key: property, value: initialValue,
      })))
      const nextRoot: unknown = JSON.parse(nextSource)
      if (!isRecord(nextRoot)) throw new TypeError('JSON metadata requires an object root')
      const base = isRecord(nextRoot.$jsonviews) ? nextRoot.$jsonviews : currentMetadata()
      const schema = isRecord(base.schema) ? base.schema : {}
      const views = Array.isArray(base.views) ? [...base.views] : []
      const rawView = views[viewDeclarationIndex]
      if (!isRecord(rawView)) throw new Error('This table view cannot be updated')
      const existingView = compileJsonViewMetadata(root).views.find((view) => view.declarationIndex === viewDeclarationIndex)
      const columns = Array.isArray(rawView.columns) && rawView.columns.length > 0 ? [...rawView.columns]
        : existingView ? projectJsonViewCollection(root, { ...existingView, filter: undefined, sort: [] }).columns.map((column) => ({ label: column.label, path: column.path.source })) : []
      views[viewDeclarationIndex] = { ...rawView, columns: [...columns, { label: typeof descriptor.title === 'string' ? descriptor.title : property, path: schemaPath }] }
      return upsertJsonObjectPropertyInSource(nextSource, [], '$jsonviews', {
        ...base,
        version: 1,
        schema: { ...schema, [schemaPath]: descriptor },
        views,
      })
    })
  }, [adapter.format, currentMetadata, commitGeneratedSource, metadataWritable, persistence])

  const deleteColumn = useCallback(async (arrayPath: ValuePath, property: string, schemaPath: string) => {
    if (!metadataWritable) throw new Error('These annotations cannot be edited')
    if (adapter.format !== 'json-object' || persistence !== 'embedded') throw new Error('Columns can only be deleted from object-root JSON documents')
    await commitGeneratedSource((source) => {
      const root: unknown = JSON.parse(source)
      const rows = getValueAtPath(root, arrayPath)
      if (!Array.isArray(rows) || rows.some((row) => !isRecord(row))) throw new TypeError('Columns can only be deleted from an array of objects')
      const paths = rows.flatMap((row, index): ValuePath[] => Object.prototype.hasOwnProperty.call(row, property) ? [[...arrayPath, index, property]] : [])
      assertUnambiguousSourcePath(source, paths)
      assertSourceReplacementSafe(source, [['$jsonviews']])
      let nextSource = removeJsonValuesInSource(source, paths)
      const nextRoot: unknown = JSON.parse(nextSource)
      if (!isRecord(nextRoot)) throw new TypeError('JSON metadata requires an object root')
      const base = isRecord(nextRoot.$jsonviews) ? nextRoot.$jsonviews : currentMetadata()
      const schema = isRecord(base.schema) ? { ...base.schema } : {}
      delete schema[schemaPath]
      const views = Array.isArray(base.views) ? base.views.map((value) => {
        if (!isRecord(value)) return value
        const next = { ...value }
        if (Array.isArray(next.columns)) next.columns = next.columns.filter((column) => !isRecord(column) || column.path !== schemaPath)
        if (Array.isArray(next.sort)) next.sort = next.sort.filter((sort) => !isRecord(sort) || sort.path !== schemaPath)
        if (isRecord(next.filter) && Array.isArray(next.filter.rules)) {
          const rules = next.filter.rules.filter((rule) => !isRecord(rule) || rule.path !== schemaPath)
          if (rules.length > 0) next.filter = { ...next.filter, rules }
          else delete next.filter
        }
        for (const key of ['title', 'groupBy', 'orderPath']) {
          if (next[key] !== schemaPath) continue
          delete next[key]
          if (key === 'groupBy') delete next.groupOrder
        }
        return next
      }) : []
      nextSource = upsertJsonObjectPropertyInSource(nextSource, [], '$jsonviews', { ...base, version: 1, schema, views })
      return nextSource
    })
  }, [adapter.format, currentMetadata, commitGeneratedSource, metadataWritable, persistence])

  const setOptionColor = useCallback(async (schemaPath: string, optionValue: string, color: string) => {
    if (!metadataWritable || !compiled) throw new Error('These annotations cannot be edited')
    const next = withOptionColor(currentMetadata(), schemaPath, optionValue, color)
    const candidate = compileJsonViewMetadata(parsed.root, types, { metadata: next })
    if (!candidate.schema.some((entry) => entry.declaration === schemaPath)) {
      throw new Error(candidate.diagnostics.find((item) => item.scope === 'schema')?.message ?? 'Invalid option color')
    }
    if (persistence === 'session') { await saveSessionMetadata(next); return }
    if (adapter.format !== 'json-object' || persistence !== 'embedded') { await requestConversion('save-option-colors', next); return }
    await commitGeneratedSource((source) => {
      const root: unknown = JSON.parse(source)
      if (!isRecord(root)) throw new TypeError('JSON metadata requires an object root')
      assertSourceReplacementSafe(source, [['$jsonviews']])
      return upsertJsonObjectPropertyInSource(source, [], '$jsonviews', next)
    })
  }, [adapter.format, compiled, currentMetadata, commitGeneratedSource, metadataWritable, parsed.root, persistence, requestConversion, saveSessionMetadata, types])

  const replaceViews = useCallback(async (views: readonly unknown[]) => {
    if (!metadataWritable || !compiled) throw new Error('These annotations cannot be edited')
    const base = currentMetadata()
    const next = {
      ...base, version: 1,
      ...(base.schema === undefined && compiled.inference && Object.keys(compiled.inference.schema).length > 0 ? { schema: compiled.inference.schema } : {}),
      views,
    }
    const candidate = compileJsonViewMetadata(parsed.root, types, { metadata: next })
    if (candidate.views.length !== views.length) throw new Error(candidate.diagnostics.find((item) => item.scope === 'view')?.message ?? 'Invalid view')
    if (persistence === 'session') { await saveSessionMetadata(next); return }
    if (adapter.format !== 'json-object' || persistence !== 'embedded') { await requestConversion('save-view', next); return }
    await commitGeneratedSource((source) => {
      const root: unknown = JSON.parse(source)
      if (!isRecord(root)) throw new TypeError('JSON metadata requires an object root')
      assertSourceReplacementSafe(source, [['$jsonviews']])
      return upsertJsonObjectPropertyInSource(source, [], '$jsonviews', next)
    })
  }, [adapter.format, compiled, currentMetadata, commitGeneratedSource, metadataWritable, parsed.root, persistence, requestConversion, saveSessionMetadata, types])

  const saveViewsToSource = async () => {
    const next = currentMetadata()
    if (adapter.format === 'json-object' && isRecord(parsed.root)) {
      await document.commit((source) => {
        assertSourceReplacementSafe(source, [['$jsonviews']])
        return upsertJsonObjectPropertyInSource(source, [], '$jsonviews', next)
      })
    } else if (onRequestMetadataPersistence) {
      const convertedSource = adapter.format === 'csv' || Array.isArray(parsed.root)
        ? convertToJsonViewsDocument({ root: parsed.root, metadata: next, sourceFormat: adapter.format === 'csv' ? 'csv' : 'json-array', ...(adapter.format === 'csv' ? {} : { source: document.content }) })
        : `{\n  "$jsonviews": ${JSON.stringify(rebaseJsonViewsMetadata(next), null, 2)},\n  "data": ${document.content.trim()}\n}\n`
      await onRequestMetadataPersistence({ reason: 'save-view', sourceFormat: adapter.format === 'csv' ? 'csv' : Array.isArray(parsed.root) ? 'json-array' : 'json-scalar', proposedFilename: filenameForConversion(path), convertedSource })
    }
  }
  const saveStatus = <ViewSaveStatus embedded={embedded} objectRoot={adapter.format === 'json-object' && isRecord(parsed.root)}
    conversionConfirmation={metadataConversionConfirmation}
    saving={document.saving} dirty={isDirty || document.dirty} invalidSourceError={parsed.error ?? undefined} invalidFormat={parsed.error ? adapter.format === 'csv' ? 'CSV' : 'JSON' : undefined} error={document.error || saveError || (!metadataWritable ? 'View settings need repair before saving.' : undefined)}
    onSave={document.canCommit && metadataWritable && (isRecord(parsed.root) && adapter.format === 'json-object' || onRequestMetadataPersistence) ? saveViewsToSource : undefined} />
  const sourceFormat = adapter.format === 'csv' ? 'CSV' : 'JSON'
  const formattedSource = useMemo(() => {
    if (adapter.format === 'csv') return undefined
    try { return formatJsonSource(document.content) } catch { return undefined }
  }, [adapter.format, document.content])
  const formatSource = !document.canCommit || formattedSource === undefined || formattedSource === document.content.trim()
    ? undefined : () => editSource(formattedSource)
  const sourceControl = <>{showingSource && formatSource && <SourceFormatButton format={sourceFormat} disabled={document.saving} onFormat={formatSource} />}{saveStatus}</>
  const sourceTargetRanges = useMemo(() => {
    if (adapter.format === 'csv' || currentViewPaths.length === 0 || coversAllDocumentData(parsed.root, currentViewPaths)) return []
    try { return jsonSourceRangesAtPaths(document.content, currentViewPaths) }
    catch { return [] }
  }, [adapter.format, currentViewPaths, document.content, parsed.root])
  const sourceEditor = (
      <TooltipProvider>
        <SourceEditor
          embedded={!parsed.error}
          saveStatus={saveStatus}
          content={document.content}
          dirty={isDirty ?? document.dirty}
          fillHeight={fillHeight}
          format={sourceFormat}
          invalidSourceError={parsed.error}
          onChange={editSource}
          onClose={() => setShowingSource(false)}
          onFormat={formatSource}
          readOnly={!document.canCommit}
          saveError={document.error ?? saveError}
          saving={document.saving}
          targetRanges={sourceTargetRanges}
        />
      </TooltipProvider>
    )
  if (parsed.error) return sourceEditor
  const recoveryCommit = document.canCommit ? commitSource : undefined
  if (parsed.error || parsed.root === undefined || parsed.state === undefined || !compiled) {
    return <JsonSourceRecovery source={document.content} error={parsed.error ?? compilation.error ?? `Could not inspect this ${adapter.format}`} onCommit={recoveryCommit} />
  }
  const requiresMetadataConversion = persistence !== 'session' && (adapter.format === 'json-array' || adapter.format === 'csv')
  const conversionUnavailable = requiresMetadataConversion && onRequestMetadataPersistence === undefined
  const viewCreationUnavailableReason = !metadataWritable
    ? 'This document’s view metadata is invalid or read-only.'
    : conversionUnavailable
      ? `Saving a view for this ${adapter.format === 'csv' ? 'CSV file' : 'root-array JSON file'} requires a host that can create an object-root JSON copy.`
      : persistence !== 'session' && adapter.format === 'json-array' && !allowRootArrayWrapping
        ? 'Saving views for root-array JSON is disabled by this host.'
        : undefined
  const editing = document.canCommit && structuredEditingAllowed ? {
    ...(metadataWritable && persistence === 'embedded' && adapter.format === 'json-object' ? { addColumn, deleteColumn } : {}),
    canEditViews: viewCreationUnavailableReason === undefined,
    ...(viewCreationUnavailableReason ? { viewCreationUnavailableReason } : {}),
    viewSaveMode: requiresMetadataConversion ? 'explicit' as const : 'automatic' as const,
    canReplace: (valuePath: ValuePath) => adapter.format === 'csv' || replacementIssue(sourceDiagnostics, valuePath) === undefined,
    append: appendArrayItem, registerDraftRow, isDraftRow, clear: clearValue,
    replace: replaceValue, replaceMany: replaceValues, ...(metadataWritable ? { setOptionColor } : {}), replaceViews,
    removeMany: removeValues, saving: document.saving,
  } : undefined

  return (
    <TooltipProvider>
      {document.error && <div className="grid gap-2 px-4 py-2 text-sm">
        <p role="alert" className="text-destructive">{document.error}</p>
        {document.dirty && <div className="flex flex-wrap gap-2">
          <button type="button" disabled={document.saving} className="rounded-md border border-border px-2 py-1 disabled:opacity-50" onClick={() => { void document.commit((source) => source).catch(() => {}) }}>Retry save</button>
          <button type="button" disabled={document.saving} className="rounded-md border border-border px-2 py-1 disabled:opacity-50" onClick={() => { document.reset(); setEditorGeneration((generation) => generation + 1) }}>Discard unsaved changes</button>
          <details className="basis-full"><summary>Unsaved source</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{document.content}</pre></details>
        </div>}
      </div>}
      {formatDiagnostics.length > 0 && <details className="px-4 py-2 text-sm">
        <summary>{formatDiagnostics.some((item) => item.severity === 'error') ? 'This document needs repair before structured editing.' : 'Some values require source editing to preserve their exact representation.'}</summary>
        <JsonSourceRecovery source={document.content} error={formatDiagnostics.map((item) => item.message).join(' ')} onCommit={recoveryCommit} />
      </details>}
      <JsonRendererBoundary key={editorGeneration} source={document.content} onCommit={recoveryCommit}>
      <JsonSourceLiteralsProvider diagnostics={sourceDiagnostics}>
      <EditBaseContext.Provider value={document.acknowledgedContent}>
      <JsonViewer compiled={compiled} defaultKey={path?.split('/').pop() || 'root'} filePath={documentId ?? path}
        sourceContent={sourceEditor} sourceVisible={showingSource} onSourceVisibleChange={setShowingSource}
        tabularRoot={adapter.format === 'csv'}
        editing={editing} onCurrentPathChange={rememberSourcePaths} renderExternalWidget={renderExternalWidget} renderMarkdown={renderMarkdown} sourceControl={sourceControl} tableCells={tableCells} uiSize={uiSize} fillHeight={fillHeight} />
      </EditBaseContext.Provider>
      </JsonSourceLiteralsProvider>
      </JsonRendererBoundary>
    </TooltipProvider>
  )
}
