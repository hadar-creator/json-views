import { type ReactNode } from 'react'
import type { UiSize } from '../lib/ui-size.js'
import { type ValuePath } from '@script-it/json-views-core'
import { type CompiledJsonViewMetadata } from '@script-it/json-views-core'
import { type JsonViewSchemaExternalWidgetRenderer } from './schema-value.js'
import type { JsonValueReplacement } from '@script-it/json-views-core'
import type { JsonViewsTableCellOptions } from '../structured-data/table-cell-options.js'


export interface JsonViewJsonEditing {
  canEditViews?: boolean
  /** Why view creation is visible but unavailable. */
  viewCreationUnavailableReason?: string
  /** Embedded/session metadata saves immediately; structural conversions wait for an explicit save. */
  viewSaveMode?: 'automatic' | 'explicit'
  /** Whether a replacement can preserve the source representation at this path. */
  canReplace?: (path: ValuePath) => boolean
  addColumn?: (arrayPath: ValuePath, property: string, schemaPath: string, descriptor: Record<string, unknown>, viewDeclarationIndex: number) => Promise<void>
  deleteColumn?: (arrayPath: ValuePath, property: string, schemaPath: string) => Promise<void>
  append: (arrayPath: ValuePath, value: unknown) => Promise<void>
  /** Marks a newly appended record as an unfinished draft until its first edit. */
  registerDraftRow?: (path: ValuePath) => void
  isDraftRow?: (path: ValuePath) => boolean
  clear: (path: ValuePath) => Promise<void>
  replace: (path: ValuePath, value: unknown) => Promise<void>
  replaceMany: (replacements: readonly JsonValueReplacement[]) => Promise<void>
  setOptionColor?: (schemaPath: string, optionValue: string, color: string) => Promise<void>
  replaceViews: (views: readonly unknown[]) => Promise<void>
  removeMany: (paths: ValuePath[]) => Promise<void>
  saving: boolean
}

export interface JsonViewerProps {
  compiled: CompiledJsonViewMetadata
  defaultKey: string
  editing?: JsonViewJsonEditing
  filePath?: string
  fillHeight?: boolean
  renderMarkdown?: (content: string) => ReactNode
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  /** Reports the current location and, when narrowed by a filter/search, matching paths in display order. */
  onCurrentPathChange?: (path: ValuePath, sourcePaths?: readonly ValuePath[]) => void
  sourceContent?: ReactNode
  sourceVisible?: boolean
  onSourceVisibleChange?: (visible: boolean) => void
  sourceControl?: ReactNode
  /** Clamps tall table cells and reveals one on selection (default), or lets rows grow to fit. */
  tableCells?: JsonViewsTableCellOptions
  uiSize?: UiSize
  viewsEnabled?: boolean
  /** CSV is already tabular, irrespective of JSON prediction confidence. */
  tabularRoot?: boolean
}
