import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Check, ExternalLink } from 'lucide-react'

import { cn } from '../lib/cn.js'
import { submitsOnEnter, useEnterKeyBehavior } from '../lib/enter-key.js'
import { OptionPill, optionColorsForValues } from '../primitives/option-pill.js'
import { EditValueAction, StructuredValueCellFrame } from '../structured-data/atomic-value-editor.js'
import { StructuredCellFillContext } from '../structured-data/structured-cell-fill-context.js'
import { ExpandValueButton, ValueCellContent } from '../tabular-data-view.js'
import { JsonSourceNumber, useJsonSourceLiterals, useJsonSourceSubtreeRisk } from './source-literals.js'
import type { JsonViewSchemaDescriptor, ValuePath } from '@script-it/json-views-core'
import { validateJsonViewSchemaValue } from '@script-it/json-views-core'
import { useJsonViewsRegistries } from '../widget-registry.js'
import { useEditBaseChanged } from '../structured-data/edit-base.js'
import { HtmlPreview } from './html-preview.js'

export interface JsonViewSchemaExternalWidgetProps {
  type: string
  value: unknown
  disabled: boolean
  descriptor: JsonViewSchemaDescriptor
  label: string
  onChange: (value: unknown) => void
}

export type JsonViewSchemaExternalWidgetRenderer = (
  props: JsonViewSchemaExternalWidgetProps,
) => ReactNode

export function withColumnOptionColors(descriptor: JsonViewSchemaDescriptor, values: readonly unknown[], offset: number): JsonViewSchemaDescriptor {
  if (descriptor.type !== 'select' && descriptor.type !== 'multi-select') return descriptor
  const choices = [...(descriptor.options ?? []), ...values.flatMap((value) => Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)])]
  return { ...descriptor, optionColors: optionColorsForValues(choices, descriptor.optionColors, offset) }
}

function safeWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function JsonViewSchemaValueDisplay({
  compact = false,
  decorative = false,
  passive = false,
  sourcePath,
  descriptor,
  onOpen,
  renderMarkdown,
  value,
}: {
  compact?: boolean
  /** Suppresses duplicate checkbox semantics inside an interactive control. */
  decorative?: boolean
  /** Removes nested interactions when a parent owns the cell interaction. */
  passive?: boolean
  sourcePath?: ValuePath
  descriptor: JsonViewSchemaDescriptor
  onOpen: () => void
  renderMarkdown?: (content: string) => ReactNode
  value: unknown
}) {
  const sourceLiteral = useJsonSourceLiterals()(sourcePath)
  const lossyContainer = useJsonSourceSubtreeRisk(sourcePath) && value !== null && typeof value === 'object'
  const format = descriptor.type
  const choiceColors = optionColorsForValues([...(descriptor.options ?? []), ...(Array.isArray(value) ? value.map(String) : [String(value)])], descriptor.optionColors)
  const { widgets } = useJsonViewsRegistries()
  const CustomDisplay = widgets.getDisplay(format)
  if (sourceLiteral !== undefined) return <JsonSourceNumber literal={sourceLiteral} />
  if (lossyContainer) return <ValueCellContent containerInteractive={!passive} sourcePath={sourcePath} value={value} onOpen={onOpen} />
  if (CustomDisplay && !passive) return <CustomDisplay compact={compact} descriptor={descriptor} onOpen={onOpen} renderMarkdown={renderMarkdown} value={value} />
  if (value === undefined || value === null || value === '') return <span className="italic text-muted-foreground">—</span>
  if (compact && (format === 'body' || format === 'markdown' || format === 'html')) return <ValueCellContent containerInteractive={!passive} sourcePath={sourcePath} value={value} onOpen={onOpen} />
  if (typeof value === 'string' && format === 'html') return <HtmlPreview source={value} title={descriptor.title ?? 'Property'} />
  if (format === 'select') return <OptionPill label={String(value)} color={choiceColors[String(value)]} className="max-w-full" labelClassName="truncate" />
  if (format === 'multi-select' && Array.isArray(value)) {
    return <span className="flex min-w-0 flex-wrap gap-1">{value.map((item, index) => <OptionPill key={`${String(item)}-${index}`} label={String(item)} color={choiceColors[String(item)]} className="max-w-full" labelClassName="truncate" />)}</span>
  }
  if (format === 'checkbox') {
    return (
      <span role={decorative ? undefined : "checkbox"} aria-hidden={decorative || undefined} aria-checked={decorative ? undefined : value === true} aria-readonly={decorative ? undefined : true} aria-label={decorative ? undefined : value === true ? 'Checked' : 'Unchecked'} className={cn('inline-grid h-4 w-4 place-items-center rounded-sm border', value === true ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
        {value === true && <Check className="h-3 w-3" />}
      </span>
    )
  }
  if (typeof value === 'string' && descriptor.type === 'url') {
    const href = safeWebUrl(value)
    if (href && passive) return <span className="block truncate text-link">{value}</span>
    if (href) return <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-link hover:underline"><ExternalLink className="h-3 w-3 shrink-0" /><span className="truncate">{value}</span></a>
  }
  if (typeof value === 'string' && descriptor.type === 'email') {
    if (passive) return <span className="block truncate text-link">{value}</span>
    return <a href={`mailto:${value}`} className="block truncate text-link hover:underline">{value}</a>
  }
  if (typeof value === 'string' && format === 'date') {
    const timestamp = Date.parse(`${value}T00:00:00`)
    return Number.isNaN(timestamp) ? <span>{value}</span> : <span title={value}>{new Date(timestamp).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
  }
  if (typeof value === 'string' && ((format === 'body' || format === 'markdown') || (format === 'text' && descriptor.multiline === true))) {
    return (format === 'body' || format === 'markdown') && renderMarkdown
      ? <div className="min-w-0">{renderMarkdown(value)}</div>
      : <div data-id="jsonView-body-text" className="min-w-0 whitespace-pre-wrap break-words leading-normal text-foreground">{value}</div>
  }
  return <ValueCellContent containerInteractive={!passive} sourcePath={sourcePath} value={value} onOpen={onOpen} />
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  try { return JSON.stringify(left) === JSON.stringify(right) }
  catch { return false }
}

export function SchemaEditor({
  descriptor,
  disabled,
  label,
  minHeight,
  onCancel,
  onClear,
  onCommit,
  onOptionColorChange,
  renderExternalWidget,
  variant,
  value,
}: {
  descriptor: JsonViewSchemaDescriptor
  disabled: boolean
  label: string
  minHeight?: number
  onCancel: () => void
  onClear?: () => Promise<void>
  onCommit: (value: unknown) => Promise<void>
  onOptionColorChange?: (optionValue: string, color: string) => Promise<void>
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  variant: 'default' | 'record-title'
  value: unknown
}) {
  const { types, widgets } = useJsonViewsRegistries()
  const [initial] = useState(() => {
    try { return { draft: types.parse(value, descriptor), error: undefined as string | undefined } }
    catch (cause) { return { draft: value, error: cause instanceof Error ? cause.message : 'Could not open this editor' } }
  })
  const [draft, setDraft] = useState<unknown>(initial.draft)
  const [error, setError] = useState<string | undefined>(initial.error)
  const draftRef = useRef(draft)
  const containerRef = useRef<HTMLDivElement>(null)
  const committingRef = useRef(false)
  const originalValueRef = useRef(value)
  const attemptedCommitRef = useRef(false)
  const baseChanged = useEditBaseChanged()
  const fillCell = useContext(StructuredCellFillContext)
  const format = descriptor.type
  const enterKey = useEnterKeyBehavior(widgets.getDefinition(format)?.enterKey)
  const stringDraft = typeof draft === 'string' || typeof draft === 'number' || typeof draft === 'boolean'
    ? String(draft)
    : Array.isArray(draft) ? JSON.stringify(draft) : ''

  const commitValue = useCallback(async (candidate: unknown) => {
    if (committingRef.current) return
    if (baseChanged || (!attemptedCommitRef.current && !sameValue(value, originalValueRef.current))) {
      setError('This document changed outside this editor. Cancel and reopen it before saving.')
      return
    }
    let next: unknown
    try { next = sameValue(candidate, initial.draft) ? value : types.serialize(candidate, descriptor) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not convert this value'); return }
    if (sameValue(next, value) && !error) {
      onCancel()
      return
    }
    const nextError = validateJsonViewSchemaValue(next, descriptor, types)
    if (nextError) {
      setError(nextError)
      return
    }
    committingRef.current = true
    attemptedCommitRef.current = true
    setError(undefined)
    try {
      await onCommit(next)
      onCancel()
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'Could not save this value')
    } finally {
      committingRef.current = false
    }
  }, [baseChanged, descriptor, error, initial.draft, onCancel, onCommit, types, value])

  const updateDraft = useCallback((next: unknown) => {
    draftRef.current = next
    setDraft(next)
  }, [])

  const commit = useCallback(() => commitValue(draftRef.current), [commitValue])
  const clear = useCallback(async () => {
    if (descriptor.required) { setError('A value is required'); return }
    if (baseChanged || (!attemptedCommitRef.current && !sameValue(value, originalValueRef.current))) {
      setError('This document changed outside this editor. Cancel and reopen it before saving.')
      return
    }
    if (!onClear) {
      await commitValue(null)
      return
    }
    if (committingRef.current) return
    committingRef.current = true
    setError(undefined)
    try {
      await onClear()
      onCancel()
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'Could not clear this value')
    } finally {
      committingRef.current = false
    }
  }, [baseChanged, commitValue, descriptor.required, onCancel, onClear, value])

  useEffect(() => {
    // Autofocus belongs to opening the editor, not to changing callbacks
    // when another cell saves and the parent rerenders. Popup widgets own
    // their focus; focusing their trigger would dismiss a non-modal popup.
    containerRef.current
      ?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, button:not([aria-haspopup])')
      ?.focus({ preventScroll: (format === 'body' || format === 'markdown' || format === 'html') || variant === 'record-title' })
  }, [format, variant])

  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', cancelOnEscape, true)
    return () => document.removeEventListener('keydown', cancelOnEscape, true)
  }, [onCancel])

  const Widget = widgets.get(format)
  const control = Widget
    ? <Widget descriptor={descriptor} disabled={disabled} error={error} label={label} minHeight={minHeight} value={draft} stringValue={stringDraft} onCancel={onCancel} onChange={updateDraft} onClear={onClear ? () => { void clear() } : undefined} onCommit={(candidate) => { void commitValue(candidate === undefined ? draftRef.current : candidate) }} onOptionColorChange={onOptionColorChange ? (optionValue, color) => { void onOptionColorChange(optionValue, color).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not save option color')) } : undefined} />
    : renderExternalWidget?.({ type: format, value: draft, disabled, descriptor, label, onChange: updateDraft })

  const editor = (
    <div
      ref={containerRef}
      data-id="jsonView-schema-editor"
      className={cn(
        'relative min-w-0',
        variant === 'record-title'
          ? 'text-xl font-semibold tracking-tight [&_input]:min-h-10 [&_input]:px-1.5 [&_input]:py-1 [&_input]:font-sans [&_input]:text-xl [&_input]:font-semibold [&_input]:tracking-tight [&_textarea]:min-h-10 [&_textarea]:px-1.5 [&_textarea]:py-1 [&_textarea]:font-sans [&_textarea]:text-xl [&_textarea]:font-semibold [&_textarea]:tracking-tight'
          : (format === 'body' || format === 'markdown' || format === 'html')
          ? 'leading-normal [&_textarea]:[font:inherit]'
          : '[&_input]:[font:inherit] [&_textarea]:[font:inherit]',
      )}
      aria-label={`Edit ${label}`}
      onKeyDown={(event) => {
        // React delivers keys from a widget's portaled popup (a date picker,
        // a choice menu) here too; that popup owns them. A widget that
        // handled Enter itself, such as a code editor, keeps it.
        const target = event.target
        if (event.defaultPrevented || !(target instanceof Element) || !event.currentTarget.contains(target)) return
        if (target instanceof HTMLButtonElement) return
        const multiline = target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)
        if (!submitsOnEnter(event, { multiline, enterKey })) return
        event.preventDefault()
        void commit()
      }}
    >
      {control}
      {error && <p role="alert" className="absolute left-0 top-full z-[110] mt-1 rounded-md border border-destructive-border bg-destructive-surface px-2 py-1 text-[0.6875rem] text-destructive-foreground shadow-lg">{error}</p>}
    </div>
  )
  return fillCell ? <div className="px-1.5 py-1.5">{editor}</div> : editor
}

export function JsonViewSchemaValueCell({
  compact = false,
  descriptor,
  initiallyEditing = false,
  label,
  onClear,
  onCommit,
  onOptionColorChange,
  onOpen,
  renderExternalWidget,
  renderMarkdown,
  saving = false,
  suppressRequiredValidation = false,
  variant = 'default',
  value,
  sourcePath,
}: {
  compact?: boolean
  descriptor: JsonViewSchemaDescriptor
  initiallyEditing?: boolean
  inputKey?: string
  label: string
  onClear?: () => Promise<void>
  onCommit?: (value: unknown) => Promise<void>
  onOptionColorChange?: (optionValue: string, color: string) => Promise<void>
  onOpen: () => void
  renderExternalWidget?: JsonViewSchemaExternalWidgetRenderer
  renderMarkdown?: (content: string) => ReactNode
  saving?: boolean
  /** Avoids showing required-field errors while a newly-created record is still untouched. */
  suppressRequiredValidation?: boolean
  /** Matches a record heading's typography and occupied space while editing. */
  variant?: 'default' | 'record-title'
  value: unknown
  sourcePath?: ValuePath
}) {
  const [editing, setEditing] = useState(initiallyEditing)
  const displayRef = useRef<HTMLDivElement>(null)
  const [editorMinHeight, setEditorMinHeight] = useState<number>()
  const { types, widgets } = useJsonViewsRegistries()
  const [quickError, setQuickError] = useState<string>()
  const [quickSaving, setQuickSaving] = useState(false)
  const fillCell = useContext(StructuredCellFillContext)
  const validationIssue = validateJsonViewSchemaValue(value, descriptor, types)
  const invalid = suppressRequiredValidation && validationIssue === 'A value is required' ? undefined : validationIssue
  const warning = types.warnings(value, descriptor)[0]
  const registration = widgets.getDefinition(descriptor.type)
  const editable = Boolean(onCommit && (registration?.editor || renderExternalWidget))
  const quickEdit = registration?.quickEdit
  const stableText = ((descriptor.type === 'body' || descriptor.type === 'markdown' || descriptor.type === 'html') || (descriptor.type === 'text' && descriptor.multiline === true)) && !compact
  const choiceLayout = descriptor.type === 'select' || descriptor.type === 'multi-select'
  // A wrapped choice preview must not shrink while its popup is open:
  // dismissing it on pointerdown would move the next row before the click.
  const stableLayout = stableText || variant === 'record-title' || choiceLayout
  const preserveLayoutHeight = () => {
    if (!stableLayout) return
    const height = displayRef.current?.getBoundingClientRect().height ?? 0
    if (height > 0) setEditorMinHeight(height)
  }
  const stopEditing = () => {
    // Height is only reserved while editing; the preview must size naturally.
    setEditorMinHeight(undefined)
    setEditing(false)
  }
  if (quickEdit && onCommit) {
    const checked = value === true
    return (
      <div className={cn('h-full min-w-0', invalid && 'ring-1 ring-inset ring-destructive')} title={invalid}>
        <button
          type="button"
          data-id="jsonView-checkbox-toggle"
          role={typeof value === 'boolean' ? 'checkbox' : undefined}
          aria-label={typeof value === 'boolean' ? `${checked ? 'Uncheck' : 'Check'} ${label}` : `Edit ${label}`}
          aria-checked={typeof value === 'boolean' ? checked : undefined}
          disabled={saving || quickSaving}
          className={cn(
            'flex w-full items-center transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 dark:hover:bg-primary/25',
            fillCell ? 'h-full min-h-11 px-3 py-2' : 'min-h-7 rounded-md px-1.5',
          )}
          onClick={() => { void (async () => {
            if (quickSaving) return
            setQuickSaving(true)
            setQuickError(undefined)
            try {
              const next = types.serialize(quickEdit(types.parse(value, descriptor)), descriptor)
              const problem = validateJsonViewSchemaValue(next, descriptor, types)
              if (problem) throw new Error(problem)
              await onCommit(next)
            } catch (cause) { setQuickError(cause instanceof Error ? cause.message : 'Could not save this value') }
            finally { setQuickSaving(false) }
          })() }}
        >
          <JsonViewSchemaValueDisplay sourcePath={sourcePath} decorative descriptor={descriptor} value={value} onOpen={onOpen} />
        </button>
        {quickError && <p role="alert" className="text-xs text-destructive">{quickError}</p>}
      </div>
    )
  }
  if (editing && editable && onCommit) {
    const editor = <SchemaEditor key={`${descriptor.type}:${types.version}`} descriptor={descriptor} disabled={saving} label={label} minHeight={editorMinHeight} value={value} onCancel={stopEditing} onClear={onClear} onCommit={onCommit} onOptionColorChange={onOptionColorChange} renderExternalWidget={renderExternalWidget} variant={variant} />
    return stableLayout
      ? <div ref={displayRef} data-id="jsonView-schema-value" className="h-full min-w-0" style={editorMinHeight ? { minHeight: editorMinHeight } : undefined}>{editor}</div>
      : editor
  }
  const container = value !== null && typeof value === 'object' && descriptor.type !== 'multi-select'
  const textPreview = compact && (descriptor.type === 'body' || descriptor.type === 'markdown' || descriptor.type === 'html')
  const linkedValue = typeof value === 'string'
    && (descriptor.type === 'url' || descriptor.type === 'email')
  const interactiveText = ((descriptor.type === 'body' || descriptor.type === 'markdown') && renderMarkdown !== undefined || descriptor.type === 'html') && !compact && typeof value === 'string'
  const explicitEditAction = linkedValue || descriptor.type === 'html'
  const startEditing = () => {
    preserveLayoutHeight()
    setEditing(true)
  }
  const actions = (
    <>
      {explicitEditAction && editable && <EditValueAction disabled={saving} label={label} onClick={startEditing} />}
      {(container || textPreview) && <ExpandValueButton onClick={onOpen} />}
    </>
  )
  return (
    <div ref={displayRef} data-id="jsonView-schema-value" className={cn('h-full min-w-0', invalid && 'ring-1 ring-inset ring-destructive', !invalid && warning && 'ring-1 ring-inset ring-amber-500')} style={stableLayout && editorMinHeight ? { minHeight: editorMinHeight } : undefined} title={invalid ?? warning}>
      <StructuredValueCellFrame
        actions={explicitEditAction || container || textPreview ? actions : undefined}
        overlayActions={descriptor.type === 'html' && !compact}
        activationDisabled={!editable || saving || explicitEditAction}
        activationLabel={editable && !explicitEditAction ? `Edit ${label}` : undefined}
        activationRole={interactiveText ? 'group' : 'button'}
        className={variant === 'record-title' ? 'min-h-10 w-fit max-w-full px-1.5 py-1' : stableText ? 'px-0' : undefined}
        onActivate={editable && !explicitEditAction ? startEditing : undefined}
      >
        {stableText ? (
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            <JsonViewSchemaValueDisplay sourcePath={sourcePath} compact={compact} descriptor={descriptor} value={value} onOpen={onOpen} renderMarkdown={renderMarkdown} />
            {(invalid || warning) && <AlertTriangle aria-label={invalid ?? warning} className={cn('h-3.5 w-3.5 shrink-0', invalid ? 'text-destructive' : 'text-amber-600 dark:text-amber-300')} />}
          </div>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <JsonViewSchemaValueDisplay sourcePath={sourcePath} compact={compact} descriptor={descriptor} value={value} onOpen={onOpen} renderMarkdown={renderMarkdown} />
            {(invalid || warning) && <AlertTriangle aria-label={invalid ?? warning} className={cn('h-3.5 w-3.5 shrink-0', invalid ? 'text-destructive' : 'text-amber-600 dark:text-amber-300')} />}
          </span>
        )}
      </StructuredValueCellFrame>
    </div>
  )
}
