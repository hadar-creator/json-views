import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'

import { cn } from '../lib/cn.js'

/** Focus on a text control means the cell is being edited. */
function isTextEntry(target: EventTarget): boolean {
  return target instanceof Element && target.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')
}

/**
 * One body cell of the tabular view. A clamped cell clips its value at the
 * table's cell height limit. While revealed, an in-flow placeholder keeps the
 * row at the height it had, and the value floats at full height over the
 * rows below, so selecting a cell never moves the rest of the table.
 */
export function TabularDataCell({
  cellRef,
  children,
  className,
  clamped,
  onReveal,
  pinned = false,
  revealedHeight,
  style,
}: {
  cellRef?: Ref<HTMLTableCellElement>
  children: ReactNode
  className?: string
  clamped: boolean
  /** Present only on cells that may be revealed; receives the cell height. */
  onReveal?: (height: number) => void
  pinned?: boolean
  /** The row height held while this cell is revealed. */
  revealedHeight?: number
  style: CSSProperties
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const revealed = revealedHeight !== undefined

  // Only a value taller than its cell needs a surface of its own; one that
  // fits stays visually identical to the unselected cell.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!revealed || !content) {
      setOverflowing(false)
      return
    }
    const measure = () => setOverflowing(content.getBoundingClientRect().height > revealedHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [revealed, revealedHeight])

  const reveal = () => {
    if (revealed || !onReveal) return
    onReveal(contentRef.current?.getBoundingClientRect().height ?? 0)
  }

  return (
    <td
      ref={cellRef}
      data-pinned={pinned || undefined}
      data-cell-revealed={revealed || undefined}
      className={cn(className, revealed ? 'relative overflow-visible' : 'overflow-hidden')}
      // Rank 15 lifts the floating value over later rows and the row
      // controls (10), and keeps it under the sticky headers (20+). Inline,
      // because the mobile pinned-column rule ranks its cells at 10.
      style={revealed ? { ...style, zIndex: 15 } : style}
      // Bubbles after the value's own handlers, so the click that starts an
      // edit also reveals the editor. Controls that stop propagation (row
      // selection, Expand) never reveal.
      onClick={onReveal ? reveal : undefined}
      onFocus={onReveal ? (event) => { if (isTextEntry(event.target)) reveal() } : undefined}
    >
      {revealed && <div aria-hidden data-id="tabular-cell-placeholder" style={{ height: revealedHeight }} />}
      <div
        ref={contentRef}
        data-id="tabular-cell-content"
        data-clamped={(clamped && !revealed) || undefined}
        data-overflowing={(revealed && overflowing) || undefined}
        className={cn(
          'tabular-cell-content',
          revealed
            // A grid item stretches to a definite height, so the value's
            // `h-full` chain still fills (and centres within) the cell. The
            // clip the cell gave up moves here: value frames paint their
            // hover wash past their left edge.
            ? 'absolute inset-x-0 top-0 grid min-h-full grid-cols-1 overflow-hidden'
            : 'h-full',
          revealed && overflowing && 'rounded-md bg-card shadow-lg ring-1 ring-border',
        )}
      >
        {children}
      </div>
    </td>
  )
}
