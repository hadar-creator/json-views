import { useLayoutEffect, useRef } from 'react'
import { Textarea } from '../primitives/textarea.js'
import { cn } from '../lib/cn.js'
import { READONLY_SURFACE_CLASSES } from './read-only-field.js'
import type { WidgetProps } from './types.js'

export function TextareaWidget({
  value,
  onChange,
  onBlur,
  ariaLabel,
  ariaDescribedBy,
  invalid = false,
  minHeight,
  autoSize = false,
  readOnly = false,
  disabled = false,
  surface = 'default',
  metadata,
  uiHint,
}: WidgetProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isObjectOrArray = metadata?.type === 'array'
  const rows = isObjectOrArray ? 8 : 4

  const placeholder = readOnly
    ? '—'
    : isObjectOrArray
      ? 'Enter YAML'
      : uiHint &&
          'placeholder' in uiHint &&
          typeof uiHint.placeholder === 'string' &&
          uiHint.placeholder.length > 0
        ? uiHint.placeholder
        : 'Enter text'

  useLayoutEffect(() => {
    if (!autoSize || !textareaRef.current) return
    const textarea = textareaRef.current
    textarea.style.height = 'auto'
    // A border-box height also holds the borders `scrollHeight` leaves out;
    // without them the last pixels overflow and a scrollbar appears.
    const borders = textarea.offsetHeight - textarea.clientHeight
    textarea.style.height = `${Math.max(minHeight ?? 0, textarea.scrollHeight + borders)}px`
    if (!readOnly) textarea.focus({ preventScroll: true })
  }, [autoSize, minHeight, readOnly, value])

  return (
    <Textarea
      ref={textareaRef}
      autoFocus={!readOnly && !autoSize}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid || undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      rows={rows}
      readOnly={readOnly}
      disabled={disabled}
      placeholder={placeholder}
      style={minHeight ? { minHeight } : undefined}
      // Soft wrapping already folds prose at spaces; `break-words` additionally
      // folds a token too long to fit on its own — a URL, a long `${{ }}`
      // expression — instead of letting it scroll out of the card sideways.
      className={cn(
        'break-words',
        surface === 'inline' && !readOnly && 'rounded-sm border-transparent bg-transparent px-1 py-1 text-xs shadow-none outline-none hover:bg-accent/40 focus:border-transparent focus:ring-1 focus:ring-inset focus:ring-ring',
        autoSize ? '[font:inherit]' : 'font-mono',
        readOnly && READONLY_SURFACE_CLASSES,
        invalid && 'border-destructive focus:border-destructive focus:ring-destructive/20',
      )}
    />
  )
}
