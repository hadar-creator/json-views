import { compileJsonViewMetadata, inspectCsvSource } from '@script-it/json-views-core'
import { documentFormat, isRecord, type OpenDocument } from './document-model.js'
import { exampleTypes } from './representative-registry.js'

export interface DocumentRoute {
  file: string
  view?: string
}

export function readDocumentRoute(hash: string): DocumentRoute | undefined {
  if (!hash.startsWith('#/')) return undefined
  const match = /^#\/files\/([^/]+)(?:\/views\/([^/]+))?$/.exec(hash)
  if (!match) throw new Error('Invalid file link. Expected #/files/<filename>/views/<view-name>.')
  try {
    return { file: decodeURIComponent(match[1]), ...(match[2] ? { view: decodeURIComponent(match[2]) } : {}) }
  } catch {
    throw new Error('This file link contains invalid URL encoding.')
  }
}

export function documentRouteHash(route: DocumentRoute): string {
  return `#/files/${encodeURIComponent(route.file)}${route.view === undefined ? '' : `/views/${encodeURIComponent(route.view)}`}`
}

export function documentRouteFilename(document: OpenDocument): string {
  return document.relativePath ?? document.filename
}

export function findRouteDocument(documents: readonly OpenDocument[], file: string): OpenDocument {
  const matches = documents.filter((document) => documentRouteFilename(document) === file)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new Error(`More than one file matches “${file}”. Use a unique filename or folder path.`)
  throw new Error(`File “${file}” is not available in this browser workspace. Import it here or open a snapshot share link.`)
}

type RouteView = { id: string; name: string }
const viewCache = new WeakMap<OpenDocument['controller'], { content: string; metadata: OpenDocument['metadata']; views: RouteView[] }>()

export function documentRouteViews(document: OpenDocument): RouteView[] {
  const content = document.controller.getSnapshot().content
  const cached = viewCache.get(document.controller)
  if (cached && cached.content === content && cached.metadata === document.metadata) return cached.views
  const root = documentFormat(document.filename) === 'csv' ? inspectCsvSource(content).root : JSON.parse(content)
  const embedded = documentFormat(document.filename) !== 'csv' && isRecord(root) && Object.hasOwn(root, '$jsonviews')
  // Only view ids and names are needed, so the per-value validation pass is skipped.
  const views = compileJsonViewMetadata(root, exampleTypes, { ...(embedded || document.metadata === undefined ? {} : { metadata: document.metadata }), validateValues: false }).views
    .map(({ id, name }) => ({ id, name }))
  viewCache.set(document.controller, { content, metadata: document.metadata, views })
  return views
}

export function routeActiveView(document: OpenDocument, view?: string): string {
  if (view === undefined) {
    const first = documentRouteViews(document)[0]
    return first ? `view:${first.id}` : 'root'
  }
  const matches = documentRouteViews(document).filter((candidate) => candidate.name === view)
  if (matches.length > 1) throw new Error(`More than one view is named “${view}” in “${documentRouteFilename(document)}”. Give the views unique names.`)
  if (!matches.length) throw new Error(`View “${view}” was not found in “${documentRouteFilename(document)}”.`)
  return `view:${matches[0].id}`
}

/** Read-only: validates the destination and never selects it or embeds its data. */
export function documentRouteUrl(base: string, documents: readonly OpenDocument[], document: OpenDocument, view?: string): string {
  const file = documentRouteFilename(document)
  findRouteDocument(documents, file)
  routeActiveView(document, view)
  const url = new URL(base)
  if (document.token) url.searchParams.set('token', document.token)
  else url.searchParams.delete('token')
  url.hash = documentRouteHash({ file, view })
  return url.toString()
}
