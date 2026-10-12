// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { renderComponent, type RenderResult } from './test/render.js'
import { TabularObjectArrayView } from './tabular-data-view.js'
import { TableCellOptionsContext, type JsonViewsTableCellOptions } from './structured-data/table-cell-options.js'

let rendered: RenderResult | null = null

afterEach(async () => {
  await rendered?.cleanup()
  rendered = null
  vi.restoreAllMocks()
})

const ROWS = [
  { name: 'Ada', notes: 'First line\nSecond line\nThird line', status: 'active' },
  { name: 'Grace', notes: 'Short', status: 'paused' },
]

// jsdom has no layout; the virtualizer renders rows only inside a viewport.
function giveVirtualTableAViewport(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
}

async function renderTable({ options, onOpen = () => undefined, editableStatus = false }: {
  options?: JsonViewsTableCellOptions
  onOpen?: (rowIndex: number) => void
  editableStatus?: boolean
} = {}): Promise<RenderResult> {
  giveVirtualTableAViewport()
  return renderComponent(
    <TableCellOptionsContext.Provider value={options}>
      <TabularObjectArrayView
        arr={ROWS}
        columns={['name', 'notes', 'status']}
        viewStateKey="people"
        onOpenCell={() => undefined}
        onDeleteRows={async () => undefined}
        recordNavigation={{
          titleColumn: 'name',
          getLabel: (rowIndex) => ROWS[rowIndex].name,
          onOpen,
          renderTitle: ({ value }) => <span>{String(value)}</span>,
        }}
        renderCell={editableStatus ? ({ value, column }) => column === 'status'
          ? <input aria-label="Edit status" defaultValue={String(value)} />
          : <span>{String(value)}</span> : undefined}
      />
    </TableCellOptionsContext.Provider>,
  )
}

function cell(container: HTMLElement, row: number, column: number): HTMLTableCellElement {
  const element = container.querySelector(`tbody tr[data-index="${row}"] > td:nth-child(${column + 1})`)
  if (!(element instanceof HTMLTableCellElement)) throw new Error(`Expected cell ${row}:${column}`)
  return element
}

async function press(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    ;(element as HTMLElement).click()
    await Promise.resolve()
  })
}

function revealedCells(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll('td[data-cell-revealed]'))
}

it('clamps every body cell by default', async () => {
  rendered = await renderTable()
  const contents = Array.from(rendered.container.querySelectorAll('tbody [data-id="tabular-cell-content"]'))
  expect(contents).toHaveLength(ROWS.length * 3)
  expect(contents.every((content) => content.hasAttribute('data-clamped'))).toBe(true)
  expect(revealedCells(rendered.container)).toHaveLength(0)
})

it('reveals the selected cell over later rows and dismisses it from outside', async () => {
  rendered = await renderTable()
  const notes = cell(rendered.container, 0, 1)
  await press(notes.querySelector('[data-id="structured-value-cell"]')!)

  expect(revealedCells(rendered.container)).toEqual([notes])
  expect(notes.querySelector('[data-id="tabular-cell-placeholder"]')).not.toBeNull()
  expect(notes.querySelector('[data-id="tabular-cell-content"]')?.hasAttribute('data-clamped')).toBe(false)
  expect(notes.style.zIndex).toBe('15')

  const status = cell(rendered.container, 1, 2)
  await press(status.querySelector('[data-id="structured-value-cell"]')!)
  expect(revealedCells(rendered.container)).toEqual([status])
  expect(notes.querySelector('[data-id="tabular-cell-placeholder"]')).toBeNull()

  await press(document.body)
  expect(revealedCells(rendered.container)).toHaveLength(0)

  await press(status.querySelector('[data-id="structured-value-cell"]')!)
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await Promise.resolve()
  })
  expect(revealedCells(rendered.container)).toHaveLength(0)
})

it('keeps the title cell opening its record and the row checkbox selecting rows', async () => {
  const onOpen = vi.fn()
  rendered = await renderTable({ onOpen })
  await press(rendered.container.querySelector('[aria-label="Open Ada"]')!)
  expect(onOpen).toHaveBeenCalledWith(0)
  expect(revealedCells(rendered.container)).toHaveLength(0)

  await press(rendered.container.querySelector('[aria-label="Select row 2"]')!)
  expect(rendered.container.querySelector('tbody tr[data-index="1"]')?.getAttribute('aria-selected')).toBe('true')
  expect(revealedCells(rendered.container)).toHaveLength(0)
})

it('reveals a cell when keyboard editing focuses its text control', async () => {
  rendered = await renderTable({ editableStatus: true })
  const input = rendered.container.querySelector<HTMLInputElement>('tbody tr[data-index="0"] [aria-label="Edit status"]')!
  await act(async () => {
    input.focus()
    await Promise.resolve()
  })
  expect(revealedCells(rendered.container)).toEqual([cell(rendered.container, 0, 2)])
})

it('raises a card only when the revealed value is taller than its cell', async () => {
  rendered = await renderTable()
  const notes = cell(rendered.container, 0, 1)
  const content = notes.querySelector<HTMLElement>('[data-id="tabular-cell-content"]')!
  vi.spyOn(content, 'getBoundingClientRect')
    .mockReturnValueOnce(new DOMRect(0, 0, 200, 45))
    .mockReturnValue(new DOMRect(0, 0, 200, 45))
  await press(content.querySelector('[data-id="structured-value-cell"]')!)
  expect(content.hasAttribute('data-overflowing')).toBe(false)
  await press(document.body)

  vi.spyOn(content, 'getBoundingClientRect')
    .mockReturnValueOnce(new DOMRect(0, 0, 200, 45))
    .mockReturnValue(new DOMRect(0, 0, 200, 180))
  await press(content.querySelector('[data-id="structured-value-cell"]')!)
  expect(content.hasAttribute('data-overflowing')).toBe(true)
  expect(notes.querySelector<HTMLElement>('[data-id="tabular-cell-placeholder"]')?.style.height).toBe('45px')
})

it('lets hosts grow rows, keep clamped cells clipped, or set the height limit', async () => {
  rendered = await renderTable({ options: { overflow: 'grow' } })
  expect(rendered.container.querySelector('[data-clamped]')).toBeNull()
  await press(cell(rendered.container, 0, 1).querySelector('[data-id="structured-value-cell"]')!)
  expect(revealedCells(rendered.container)).toHaveLength(0)
  await rendered.cleanup()

  rendered = await renderTable({ options: { reveal: 'none' } })
  expect(rendered.container.querySelector('tbody [data-clamped]')).not.toBeNull()
  await press(cell(rendered.container, 0, 1).querySelector('[data-id="structured-value-cell"]')!)
  expect(revealedCells(rendered.container)).toHaveLength(0)
  await rendered.cleanup()

  rendered = await renderTable({ options: { maxHeight: 120 } })
  const host = rendered.container.querySelector<HTMLElement>('[data-id="tabular-data-dialog-host"]')!
  expect(host.style.getPropertyValue('--json-views-table-cell-max-height')).toBe('120px')
  await rendered.cleanup()

  rendered = await renderTable({ options: { maxHeight: '6lh' } })
  expect(rendered.container.querySelector<HTMLElement>('[data-id="tabular-data-dialog-host"]')!
    .style.getPropertyValue('--json-views-table-cell-max-height')).toBe('6lh')
})
