import { createContext } from 'react'

/** How table cells treat content taller than the cell height limit. */
export interface JsonViewsTableCellOptions {
  /** `'clamp'` clips each cell at the maximum height; `'grow'` lets rows fit
   *  their tallest value. @default 'clamp' */
  overflow?: 'clamp' | 'grow'
  /** Pixels, or any CSS length. Sets `--json-views-table-cell-max-height`
   *  on the table, overriding host CSS for this viewer. @default '9rem' */
  maxHeight?: number | string
  /** How a clamped cell shows the rest of its content: `'select'` floats it
   *  over the rows below while the cell is selected; `'none'` keeps it
   *  clipped. @default 'select' */
  reveal?: 'select' | 'none'
}

/** Provided by `JsonViewer`, so every table it renders shares one policy. */
export const TableCellOptionsContext = createContext<JsonViewsTableCellOptions | undefined>(undefined)

export function resolveTableCellOptions(options: JsonViewsTableCellOptions | undefined) {
  const overflow = options?.overflow ?? 'clamp'
  return {
    clamp: overflow === 'clamp',
    maxHeight: typeof options?.maxHeight === 'number' ? `${options.maxHeight}px` : options?.maxHeight,
    reveal: overflow === 'clamp' && (options?.reveal ?? 'select') === 'select',
  }
}
