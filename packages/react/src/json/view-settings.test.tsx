// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { JsonViewsSurface } from '../surface.js'
import { JsonViewAddView } from './view-settings.js'
import { renderComponent, type RenderResult } from '../test/render.js'

let rendered: RenderResult | undefined
afterEach(async () => { await rendered?.cleanup(); rendered = undefined; vi.restoreAllMocks() })
async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('Missing control')
  await act(async () => element.click())
}

it('keeps an end-aligned new-view form visible outside a clipped host and usable through submission', async () => {
  const onAdd = vi.fn(async () => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.id === 'jsonView-add-view') return new DOMRect(200, 120, 28, 28)
    if (this.dataset.id === 'jsonView-add-view-menu') return new DOMRect(0, 0, 320, 250)
    return new DOMRect()
  })
  rendered = await renderComponent(<div style={{ contain: 'layout paint', overflow: 'hidden' }}>
    <JsonViewsSurface theme="dark"><JsonViewAddView align="end" root={[{ name: 'Ada', status: 'Ready' }]} schema={[]} onAdd={onAdd} /></JsonViewsSurface>
  </div>)
  await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
  const menu = document.querySelector<HTMLElement>('[data-id="jsonView-add-view-menu"]')!
  expect(rendered.container.contains(menu)).toBe(false)
  expect(menu.parentElement?.dataset.jsonViewsTheme).toBe('dark')
  expect(menu.style.position).toBe('fixed')
  expect(menu.style.left).toBe('8px')
  expect(menu.style.top).toBe('152px')
  const input = menu.querySelector('input')!
  await act(async () => input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(document.querySelector('[data-id="jsonView-add-view-menu"]')).toBe(menu)
  await click(menu.querySelector('[data-id="jsonView-new-kanban"]'))
  await click(menu.querySelector('[data-id="jsonView-create-view"]'))
  expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ display: 'kanban', name: 'Data' }))
  expect(document.querySelector('[data-id="jsonView-add-view-menu"]')).toBeNull()
})

it('preserves end alignment, flips above a bottom-edge trigger, and dismisses outside the portal', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.id === 'jsonView-add-view') return new DOMRect(800, window.innerHeight - 40, 28, 28)
    if (this.dataset.id === 'jsonView-add-view-menu') return new DOMRect(0, 0, 320, 250)
    return new DOMRect()
  })
  rendered = await renderComponent(<JsonViewsSurface><JsonViewAddView align="end" root={[]} schema={[]} onAdd={async () => {}} /></JsonViewsSurface>)
  await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
  const menu = document.querySelector<HTMLElement>('[data-id="jsonView-add-view-menu"]')!
  expect(menu.style.left).toBe('508px')
  expect(menu.style.top).toBe(`${window.innerHeight - 294}px`)
  await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(document.querySelector('[data-id="jsonView-add-view-menu"]')).toBeNull()
})

it('decides availability from the current path alone, as listing every location would', async () => {
  const root = { rows: [{ name: 'Ada' }], 'odd key': { nested: [1] }, $jsonviews: { version: 1, views: [] } }
  const cases: Array<[currentPath: string | undefined, unavailable: boolean]> = [
    [undefined, false],
    ['$', false],
    ['$.rows', false],
    ['$.rows[0]', false],
    ['$.rows[0].name', false],
    ["$['odd key'].nested", false],
    ['$.$jsonviews', true],
    ['$.$jsonviews.views', true],
    ['$.missing', true],
    ['$.rows[5]', true],
    ["$['rows']", true],
    ['$.rows[*]', true],
    ['nope', true],
  ]
  for (const [currentPath, unavailable] of cases) {
    rendered = await renderComponent(<JsonViewAddView root={root} schema={[]} currentPath={currentPath} onAdd={async () => {}} />)
    const button = rendered.container.querySelector('[data-id="jsonView-add-view"]')!
    expect(button.getAttribute('aria-disabled'), String(currentPath)).toBe(unavailable ? 'true' : 'false')
    if (unavailable) expect(button.getAttribute('aria-label'), String(currentPath)).toContain('not document data')
    await rendered.cleanup()
    rendered = undefined
  }
  rendered = await renderComponent(<JsonViewAddView root="scalar" schema={[]} onAdd={async () => {}} />)
  expect(rendered.container.querySelector('[data-id="jsonView-add-view"]')!.getAttribute('aria-disabled')).toBe('true')
})

it('offers table and Kanban for a record collection reached by path and names the view after it', async () => {
  const onAdd = vi.fn(async () => {})
  rendered = await renderComponent(<JsonViewsSurface>
    <JsonViewAddView root={{ data: { taskList: [{ title: 'A', status: 'Open' }, { title: 'B', status: 'Done' }] } }} schema={[]} currentPath="$.data.taskList" onAdd={onAdd} />
  </JsonViewsSurface>)
  await click(rendered.container.querySelector('[data-id="jsonView-add-view"]'))
  const menu = document.querySelector<HTMLElement>('[data-id="jsonView-add-view-menu"]')!
  expect(menu.querySelector('input')!.value).toBe('Data › Task List')
  await click(menu.querySelector('[data-id="jsonView-new-kanban"]'))
  await click(menu.querySelector('[data-id="jsonView-create-view"]'))
  expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
    path: '$.data.taskList', recordCollection: true, display: 'kanban', name: 'Data › Task List', groupBy: expect.stringContaining('title'),
  }))
})
