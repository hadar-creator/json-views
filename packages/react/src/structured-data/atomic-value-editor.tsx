import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Pencil } from 'lucide-react'

import { cn } from '../lib/cn.js'
import type { AtomicValue } from './atomic-value.js'
import { StructuredCellFillContext } from './structured-cell-fill-context.js'
import { useEditBaseChanged } from './edit-base.js'

const CONTROL_CLASS = 'min-h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 [font:inherit] text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-input focus:border-ring focus:ring-2 focus:ring-inset focus:ring-ring/20'

interface AtomicValueEditorProps {
  actions?: ReactNode
  children: ReactNode
  className?: string
  editorClassName?: string
  label: string
  multiline?: boolean
  onCommit: (value: AtomicValue) => Promise<void>
  preserveLayout?: boolean
  saving?: boolean
  value: AtomicValue
}

export function EditValueAction({
  disabled = false,
  label,
  onClick,
}: {
  disabled?: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-id="structured-edit-value"
      aria-label={`Edit ${label}`}
      disabled={disabled}
      className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <Pencil className="h-3.5 w-3.5" />
    </button>
  )
}

export function AtomicValueEditor({
  actions,
  children,
  className,
  editorClassName,
  label,
  multiline = false,
  onCommit,
  preserveLayout = false,
  saving = false,
  value,
}: AtomicValueEditorProps) {
  const [editing, setEditing] = useState(false)
  const fillCell = useContext(StructuredCellFillContext)
  const frameRef = useRef<HTMLDivElement>(null)
  const [editorMinHeight, setEditorMinHeight] = useState<number>()
  const stableLayout = multiline || preserveLayout
  const preserveHeight = () => {
    if (!stableLayout) return
    const height = frameRef.current?.getBoundingClientRect().height ?? 0
    if (height > 0) setEditorMinHeight(height)
  }
  const stopEditing = () => {
    setEditorMinHeight(undefined)
    setEditing(false)
  }

  if (editing) {
    const editor = (
      <AtomicValueDirectEditor
        controlClassName={editorClassName}
        label={label}
        disabled={saving}
        minHeight={editorMinHeight}
        multiline={multiline}
        onCancel={stopEditing}
        onCommit={async (nextValue) => {
          await onCommit(nextValue)
          stopEditing()
        }}
        value={value}
      />
    )
    // A zero-padding host cell would press the input against the cell
    // borders. Deliberately tighter than the idle frame's px-3/py-2: the
    // 32px control plus py-1.5 matches the 44px row exactly (py-2 would grow
    // the row on every edit toggle), and the control's own ~8px text inset
    // on top of px-1.5 lands the edited text near the idle text position.
    const paddedEditor = fillCell ? <div className="px-1.5 py-1.5">{editor}</div> : editor
    return stableLayout
      ? <div ref={frameRef} data-id="atomic-value-editor-frame" className="h-full min-w-0" style={editorMinHeight ? { minHeight: editorMinHeight } : undefined}>{paddedEditor}</div>
      : paddedEditor
  }

  const display = (
    <StructuredValueCellFrame
      actions={actions}
      activationDisabled={saving}
      activationLabel={`Edit ${label}`}
      className={className}
      onActivate={() => {
        preserveHeight()
        setEditing(true)
      }}
    >
      {children}
    </StructuredValueCellFrame>
  )
  return stableLayout
    ? <div ref={frameRef} data-id="atomic-value-editor-frame" className="h-full min-w-0" style={editorMinHeight ? { minHeight: editorMinHeight } : undefined}>{display}</div>
    : display
}

export function StructuredValueCellFrame({
  activationDisabled = false,
  activationLabel,
  activationRole = 'button',
  actions,
  children,
  leading,
  className,
  onActivate,
  overlayActions = false,
}: {
  activationDisabled?: boolean
  activationLabel?: string
  /** Use a group when rendered content contains its own interactive descendants. */
  activationRole?: 'button' | 'group'
  actions?: ReactNode
  children: ReactNode
  leading?: ReactNode
  className?: string
  onActivate?: () => void
  overlayActions?: boolean
}) {
  const fillCell = useContext(StructuredCellFillContext)
  // An editable cell advertises itself with a primary-tinted hover — the
  // neutral accent tone sits on white/card surfaces where it is barely
  // perceptible. A low alpha reads on white but is swallowed by the
  // near-black dark surfaces, so dark raises it.
  return (
    <div
      data-id="structured-value-cell"
      className={cn(
        'group/structured-cell json-viewer-hovercell relative flex min-h-7 w-full min-w-0 items-start transition-colors',
        // Inside a zero-padding table cell the frame IS the cell face:
        // square corners, and the padding the cell would otherwise carry.
        // Table values use the entire width up to the column divider. The
        // right edge is deliberately flush so clipped content makes the
        // boundary of its column unmistakable.
        fillCell ? 'h-full items-center rounded-none py-2 pl-3 pr-0' : 'rounded-md px-1.5',
        onActivate && !activationDisabled
          ? fillCell
            ? 'before:pointer-events-none before:absolute before:inset-y-0 before:-left-5 before:right-0 hover:before:bg-primary/10 dark:hover:before:bg-primary/25'
            : 'hover:bg-primary/10 dark:hover:bg-primary/25'
          : fillCell
            ? 'before:pointer-events-none before:absolute before:inset-y-0 before:-left-5 before:right-0 hover:before:bg-accent/70'
            : 'hover:bg-accent/70',
        fillCell && onActivate && !activationDisabled && 'cursor-text',
        className,
      )}
      onClick={(event) => {
        // The table cell's padding belongs to the same action as its value.
        // Child actions keep their own handlers and must not activate twice.
        if (fillCell && event.target === event.currentTarget && !activationDisabled) onActivate?.()
      }}
    >
      {leading && <span className="mr-1.5 flex min-h-7 shrink-0 items-center">{leading}</span>}
      <div
        data-id={onActivate ? 'atomic-edit-value' : undefined}
        aria-disabled={onActivate ? activationDisabled : undefined}
        aria-label={onActivate ? activationLabel : undefined}
        role={onActivate ? activationRole : undefined}
        tabIndex={onActivate && !activationDisabled ? 0 : undefined}
        title={onActivate ? activationLabel : undefined}
        className={cn(
          'flex min-h-7 min-w-0 flex-1 items-center',
          fillCell && 'self-stretch',
          // The actions overlay the trailing edge, so the value ends before
          // their lane: truncation stops short of the chip rather than being
          // covered by it. Reserved unconditionally — sizing it on hover
          // would re-truncate the text under the pointer.
          actions && !fillCell && !overlayActions && 'pr-6',
          onActivate && !activationDisabled && 'cursor-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        onClick={(event) => {
          if (!onActivate || activationDisabled) return
          const interactiveTarget = event.target instanceof Element
            ? event.target.closest('a[href], button, input, textarea, select, summary, [controls], [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="tab"], [role="menuitem"], [role="option"]')
            : null
          if (interactiveTarget && interactiveTarget !== event.currentTarget) return
          onActivate()
        }}
        onKeyDown={(event) => {
          if (!onActivate || activationDisabled) return
          if (event.target !== event.currentTarget) return
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onActivate()
        }}
      >
        {children}
      </div>
      {actions && (
        // No `z-index`: a rank here escapes the cell and bids against
        // whatever else the surface stacks — a table's sticky header sits in
        // a different subtree, so an equal rank hands the win to this one on
        // DOM order alone. On touch there is no `hover:hover` to fall back
        // on, so these are visible on every row at once, including rows
        // scrolled under a sticky header.
        <div
          data-id="structured-value-cell-actions"
          className={cn(
            'absolute right-1 flex opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/structured-cell:opacity-100 [@media(hover:hover)]:group-focus-within/structured-cell:opacity-100',
            // No surface of its own: the layer is exactly the chip, so it
            // never has to guess the colour of the cell face it sits on —
            // which the row wash and the frame's own hover both repaint.
            // A table row is a uniform height, so the chip centres in it;
            // a free-standing cell can be a tall block of prose, where the
            // chip belongs beside its first line.
            overlayActions ? 'top-2 right-2 rounded-md bg-background/90 shadow-sm' : fillCell ? 'top-1/2 -translate-y-1/2' : 'top-0.5',
          )}
        >
          {actions}
        </div>
      )}
    </div>
  )
}

function AtomicValueDirectEditor({
  controlClassName,
  disabled = false,
  label,
  minHeight,
  multiline,
  onCancel,
  onCommit,
  value,
}: {
  controlClassName?: string
  disabled?: boolean
  label: string
  minHeight?: number
  multiline: boolean
  onCancel: () => void
  onCommit: (value: AtomicValue) => Promise<void>
  value: AtomicValue
}) {
  const [draft, setDraft] = useState(typeof value === 'boolean' ? value : String(value))
  const [error, setError] = useState<string>()
  const containerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const committingRef = useRef(false)
  const originalValueRef = useRef(value)
  const attemptedCommitRef = useRef(false)
  const baseChanged = useEditBaseChanged()

  useEffect(() => {
    containerRef.current?.querySelector<HTMLElement>('input, textarea')?.focus({ preventScroll: multiline })
  }, [multiline])

  useLayoutEffect(() => {
    if (!multiline || !textareaRef.current) return
    const textarea = textareaRef.current
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.max(minHeight ?? 0, textarea.scrollHeight)}px`
  }, [draft, minHeight, multiline])

  const commit = async (nextBoolean?: boolean) => {
    if (committingRef.current) return
    if (baseChanged || (!attemptedCommitRef.current && !Object.is(value, originalValueRef.current))) {
      setError('This document changed outside this editor. Cancel and reopen it before saving.')
      return
    }

    let nextValue: AtomicValue
    if (typeof value === 'boolean') {
      nextValue = nextBoolean ?? Boolean(draft)
    } else if (typeof value === 'number') {
      const parsed = Number(draft)
      if (typeof draft !== 'string' || draft.trim() === '' || !Number.isFinite(parsed)) {
        setError('Enter a valid number')
        return
      }
      nextValue = parsed
    } else {
      nextValue = String(draft)
    }

    if (Object.is(nextValue, value) && !error) {
      onCancel()
      return
    }

    committingRef.current = true
    attemptedCommitRef.current = true
    setError(undefined)
    try {
      await onCommit(nextValue)
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'Could not save this value')
    } finally {
      committingRef.current = false
    }
  }

  return (
    <div
      ref={containerRef}
      data-id="atomic-direct-editor"
      className="relative min-w-0"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        void commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
          return
        }
        const isTextarea = event.target instanceof HTMLTextAreaElement
        if (event.key === 'Enter' && (!isTextarea || event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void commit()
        }
      }}
    >
      {typeof value === 'boolean' ? (
        <label className={cn('flex min-h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-foreground', controlClassName)}>
          <input
            aria-label={`Edit ${label}`}
            type="checkbox"
            disabled={disabled}
            checked={draft === true}
            className="h-4 w-4 accent-primary"
            onChange={(event) => {
              const next = event.target.checked
              setDraft(next)
              void commit(next)
            }}
          />
          <span>{draft === true ? 'True' : 'False'}</span>
        </label>
      ) : multiline ? (
        <textarea
          ref={textareaRef}
          aria-label={`Edit ${label}`}
          disabled={disabled}
          className={cn(CONTROL_CLASS, 'min-h-24 resize-y py-2', controlClassName)}
          style={minHeight ? { minHeight } : undefined}
          value={draft as string}
          onChange={(event) => setDraft(event.target.value)}
        />
      ) : (
        <input
          aria-label={`Edit ${label}`}
          type="text"
          disabled={disabled}
          inputMode={typeof value === 'number' ? 'decimal' : undefined}
          className={cn(CONTROL_CLASS, controlClassName)}
          value={draft as string}
          onChange={(event) => setDraft(event.target.value)}
        />
      )}
      {error && <p role="alert" className="mt-1 text-[0.6875rem] text-destructive">{error}</p>}
    </div>
  )
}
