// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderComponent, type RenderResult } from '../test/render.js'
import { TooltipProvider } from '../primitives/tooltip.js'
import { createDefaultTypeRegistry, validateJsonViewSchemaValue } from '@script-it/json-views-core'
import { JsonViewSchemaValueCell, JsonViewSchemaValueDisplay } from './schema-value.js'
import { JsonViewsProvider, createDefaultWidgetRegistry, type JsonViewEditWidgetProps } from '../widget-registry.js'
import { ValueCell } from '../structured-data/value-cell.js'

let rendered: RenderResult | null = null

afterEach(async () => {
  await rendered?.cleanup()
  rendered = null
  vi.restoreAllMocks()
})

async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected element')
  await act(async () => {
    element.click()
    await Promise.resolve()
  })
}

async function fillInput(element: Element | null, value: string): Promise<void> {
  if (!(element instanceof HTMLInputElement)) throw new Error('Expected input')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new InputEvent('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function pointerClick(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error('Expected pointer target')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    element.focus()
    element.click()
    // Radix defers focus-scope cleanup until after the content unmounts.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
}

async function chooseMenuOption(control: Element | null, value: string): Promise<void> {
  if (!(control instanceof HTMLElement)) throw new Error('Expected menu control')
  await act(async () => {
    control.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    await Promise.resolve()
  })
  await click(document.querySelector(`[data-id="pill-select-option"][data-value="${value}"]`))
}

describe('JSON Views schema values', () => {
  it('offers source editing for an HTML preview', async () => {
    rendered = await renderComponent(<JsonViewSchemaValueCell descriptor={{ type: 'html', title: 'Page' }} label="Page" value="<html><body>Hello</body></html>" onOpen={() => undefined} onCommit={vi.fn(async () => undefined)} />)
    expect(rendered.container.querySelector('[data-id="jsonView-html-preview"]')).not.toBeNull()
    const edit = rendered.container.querySelector('[aria-label="Edit Page"]')
    expect(edit?.parentElement?.className).toContain('top-2 right-2')
    expect(edit?.parentElement?.className).toContain('group-hover/structured-cell:opacity-100')
    expect(rendered.container.querySelector('[data-id="structured-value-cell"] > div')?.className).not.toContain('pr-6')
  })
  it.each([
    [['hello', 12, true, null], 'hello, 12, true, null'],
    [[], '(empty)'],
  ])('shows simple arrays inline', async (value, expected) => {
    rendered = await renderComponent(<ValueCell value={value} onOpen={vi.fn()} />)
    expect(rendered.container.textContent).toBe(expected)
    expect(rendered.container.querySelector('[aria-label="Open nested value"]')).toBeNull()
  })

  it('previews several fields of a nested object before opening it', async () => {
    rendered = await renderComponent(<ValueCell value={{ enabled: true, retries: 2, label: 'Ready' }} onOpen={vi.fn()} />)
    expect(rendered.container.querySelector('[aria-label="Open nested value"]')?.textContent)
      .toContain('enabled: true, retries: 2, label: Ready')
    expect(rendered.container.textContent).not.toContain(', …')
  })

  it('shows short string arrays as chips and opens the full list from overflow', async () => {
    const open = vi.fn()
    const skills = ['React', 'PostgreSQL', 'Redux', 'TypeScript', 'CSS', 'HTML', 'Node', 'Python', 'SQL']
    rendered = await renderComponent(<ValueCell value={skills} onOpen={open} />)
    expect([...rendered.container.querySelectorAll('[data-id="option-pill"]')].map((pill) => pill.textContent)).toEqual(skills.slice(0, 8))
    expect(rendered.container.textContent).toContain('+1 more')
    await click(rendered.container.querySelector('button:not([title="Expand value"])'))
    expect(open).toHaveBeenCalledOnce()
  })

  it('keeps complex arrays navigable', async () => {
    rendered = await renderComponent(<ValueCell value={['hello', { name: 'nested' }]} onOpen={vi.fn()} />)
    expect(rendered.container.querySelector('[aria-label="Open nested value"]')).not.toBeNull()
  })
  it('shows URL arrays as comma-separated links without a nested activation button', async () => {
    const open = vi.fn()
    const urls = ['https://example.com/feed', 'https://example.com/blog']
    rendered = await renderComponent(<ValueCell value={urls} onOpen={open} />)
    expect(rendered.container.textContent).toBe(urls.join(', '))
    expect([...rendered.container.querySelectorAll('a')].map((link) => link.href)).toEqual(urls)
    expect(rendered.container.querySelector('[aria-label="Open nested value"]')).toBeNull()
    await click(rendered.container.querySelector('a'))
    expect(open).not.toHaveBeenCalled()
  })
  it.each([
    ['text', 'input[aria-label="Edit Field"]'],
    ['number', 'input[aria-label="Edit Field"]'],
    ['body', 'textarea[aria-label="Edit Field"]'],
    ['url', 'input[aria-label="Edit Field"]'],
    ['select', '[data-id="pill-select"]'],
    ['multi-select', '[data-id="multi-select-trigger"]'],
    ['date', '[data-id="date-editor-trigger"]'],
  ])('keeps the complete %s editor focus border inside its clipped field', async (type, selector) => {
    const value = type === 'number' ? 1 : type === 'multi-select' ? ['new'] : type === 'date' ? '2026-09-10' : 'new'
    const options = type === 'select' || type === 'multi-select' ? ['new'] : undefined
    rendered = await renderComponent(
      <div className="overflow-hidden">
        <JsonViewSchemaValueCell descriptor={{ type, options }} label="Field" value={value}
          onOpen={() => {}} onCommit={async () => {}} />
      </div>,
    )
    await click(rendered.container.querySelector(type === 'url' ? '[data-id="structured-edit-value"]' : '[data-id="atomic-edit-value"]'))
    const control = rendered.container.querySelector(selector)
    expect(control?.classList.contains('ring-inset') || control?.classList.contains('focus:ring-inset')).toBe(true)
  })

  it.each(['select', 'multi-select'])('ends a %s edit on outside click without saving or reclaiming focus', async (type) => {
    const save = vi.fn(async () => {})
    const view = () => (
      <div>
        <JsonViewSchemaValueCell descriptor={{ type, options: ['new', 'closed'] }} label="Choice"
          value={type === 'select' ? 'new' : ['new']} onOpen={() => {}} onCommit={save} />
        <button type="button" role="checkbox" aria-checked="false">Other row checkbox</button>
      </div>
    )
    rendered = await renderComponent(view())
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    expect(document.querySelector('[data-id="input-widget-overlay"]')).not.toBeNull()
    const other = rendered.container.querySelector<HTMLButtonElement>('[role="checkbox"]')!
    await pointerClick(other)

    expect(document.querySelector('[data-id="input-widget-overlay"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-schema-editor"]')).toBeNull()
    expect(document.activeElement).toBe(other)
    await act(async () => { rendered!.root.render(<TooltipProvider>{view()}</TooltipProvider>) })
    expect(document.activeElement).toBe(other)
    expect(save).not.toHaveBeenCalled()
  })

  it('does not refocus an editor when its parent rerenders', async () => {
    const widgets = createDefaultWidgetRegistry().register('text', () => (
      <div><input aria-label="First" /><input aria-label="Second" /></div>
    ))
    const view = () => (
      <JsonViewsProvider widgets={widgets}>
        <JsonViewSchemaValueCell descriptor={{ type: 'text' }} label="Name" value="Example"
          onOpen={() => {}} onCommit={async () => {}} />
      </JsonViewsProvider>
    )
    rendered = await renderComponent(view())
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const second = rendered.container.querySelector<HTMLInputElement>('[aria-label="Second"]')!
    await act(async () => { second.focus() })
    await act(async () => { rendered!.root.render(<TooltipProvider>{view()}</TooltipProvider>) })
    expect(document.activeElement).toBe(second)
  })

  it.each(['select', 'multi-select'])('keeps a failed %s save available for correction', async (type) => {
    const save = vi.fn(async () => { throw new Error('Save failed') })
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type, options: ['new', 'closed'] }} label="Choice"
        value={type === 'select' ? 'new' : ['new']} onOpen={() => {}} onCommit={save} />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await click(document.querySelector('button[data-value="closed"]'))
    expect(save).toHaveBeenCalledTimes(1)
    expect(rendered.container.querySelector('[data-id="jsonView-schema-editor"]')).not.toBeNull()
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe('Save failed')
  })

  it.each(['select', 'multi-select'])('cancels a %s editor with Escape without saving', async (type) => {
    const save = vi.fn(async () => {})
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type, options: ['new'] }} label="Choice"
        value={type === 'select' ? 'new' : ['new']} onOpen={() => {}} onCommit={save} />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('[data-id="input-widget-overlay"]')).toBeNull()
    expect(rendered.container.querySelector('[data-id="jsonView-schema-editor"]')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('preserves the height of wrapped choices while the popup is open', async () => {
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type: 'multi-select', options: ['one', 'two'] }}
        label="Tags" value={['one', 'two']} onOpen={() => {}} onCommit={async () => {}} />,
    )
    const frame = rendered.container.querySelector<HTMLElement>('[data-id="jsonView-schema-value"]')!
    Object.defineProperty(frame, 'getBoundingClientRect', { value: () => ({ height: 72 }) })
    await click(frame.querySelector('[data-id="atomic-edit-value"]'))
    expect(rendered.container.querySelector('[data-id="jsonView-schema-value"]')).toBe(frame)
    expect(frame.style.minHeight).toBe('72px')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter options')
    await click(document.querySelector('button[data-value="two"]'))
    expect(frame.querySelector('[data-id="jsonView-schema-editor"]')).toBeNull()
    expect(frame.style.minHeight).toBe('')
  })

  it('renders URL and email values as blue links', async () => {
    rendered = await renderComponent(
      <div>
        <JsonViewSchemaValueDisplay descriptor={{ type: 'url' }} value="https://example.com" onOpen={() => undefined} />
        <JsonViewSchemaValueDisplay descriptor={{ type: 'email' }} value="ada@example.com" onOpen={() => undefined} />
      </div>,
    )

    const links = Array.from(rendered.container.querySelectorAll('a'))
    expect(links).toHaveLength(2)
    expect(links.every((link) => link.classList.contains('text-link'))).toBe(true)
  })

  it('validates built-in types, bounds, and configured choices', () => {
    expect(validateJsonViewSchemaValue('4.5', { type: 'number' })).toMatch(/number/)
    expect(validateJsonViewSchemaValue(101, { type: 'number', maximum: 100 })).toMatch(/at most 100/)
    expect(validateJsonViewSchemaValue('invalid', { type: 'email' })).toMatch(/email/)
    expect(validateJsonViewSchemaValue('other', { type: 'select', options: ['new'] })).toBeUndefined()
    expect(validateJsonViewSchemaValue(['new'], { type: 'multi-select', options: ['new'] })).toBeUndefined()
    expect(validateJsonViewSchemaValue(['new', 'other'], { type: 'multi-select', options: ['new'] })).toBeUndefined()
    expect(validateJsonViewSchemaValue(null, { type: 'url' })).toBeUndefined()
    expect(validateJsonViewSchemaValue('', { type: 'email' })).toBeUndefined()
    expect(validateJsonViewSchemaValue(null, { type: 'url', required: true })).toMatch(/required/)
  })

  it('uses the shared pill select and commits directly', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'select', options: ['new', 'closed'] }}
        label="Status"
        value="new"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    expect(rendered.container.querySelector('[data-id="pill-select"]')).not.toBeNull()
    const closed = Array.from(document.querySelectorAll('[data-id="pill-select-option"]'))
      .find((option) => option.textContent?.includes('closed'))
    await click(closed ?? null)
    expect(saved).toBe('closed')
    expect(rendered.container.querySelector('[data-id="jsonView-schema-save"]')).toBeNull()
  })

  it('creates and commits a new single-select option', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'select', options: ['new'] }}
        label="Status"
        value="new"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await fillInput(document.querySelector('input[aria-label="Filter or add options"]'), 'Customer')
    await click(document.querySelector('[data-id="select-create"]'))

    expect(saved).toBe('Customer')
  })

  it('creates and commits a new multi-select option', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'multi-select', options: ['Engineering'] }}
        label="Tags"
        value={['Engineering']}
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await fillInput(document.querySelector('input[aria-label="Filter options"]'), 'Design')
    await click(document.querySelector('[data-id="multi-select-create"]'))

    expect(saved).toEqual(['Engineering', 'Design'])
  })

  it('offers and applies palette colors for select options', async () => {
    const colors: Array<[string, string]> = []
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'select', options: ['new'], optionColors: { new: 'blue' } }}
        label="Status"
        value="new"
        onOpen={() => undefined}
        onCommit={async () => {}}
        onOptionColorChange={async (option, color) => { colors.push([option, color]) }}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await click(document.querySelector('button[aria-label="Change color for new"]'))
    expect(document.querySelector('[data-id="option-color-palette"]')).not.toBeNull()
    await click(document.querySelector('button[aria-label="Set new color to green"]'))
    expect(colors).toEqual([['new', 'green']])
  })

  it('toggles a checkbox directly without opening a true/false editor', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'checkbox' }}
        label="Active"
        value={true}
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    expect(rendered.container.textContent).not.toMatch(/true|false/i)
    await click(rendered.container.querySelector('[data-id="jsonView-checkbox-toggle"]'))
    expect(saved).toBe(false)
    expect(rendered.container.querySelector('[data-id="jsonView-schema-editor"]')).toBeNull()
  })

  it('keeps URL navigation and editing as separate actions', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'url' }}
        label="Website"
        value="https://script.it"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    const link = rendered.container.querySelector('a[href="https://script.it/"]')
    expect(link).not.toBeNull()
    expect(link?.closest('[role="button"], button')).toBeNull()
    expect(rendered.container.querySelectorAll('[aria-label="Edit Website"]')).toHaveLength(1)
    expect(rendered.container.querySelector('[aria-label="Edit Website"]')?.tagName).toBe('BUTTON')
    expect(rendered.container.querySelector('input[type="url"]')).toBeNull()
    await click(rendered.container.querySelector('[data-id="structured-edit-value"]'))
    const input = rendered.container.querySelector('input[type="url"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('Expected URL editor')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'https://example.com')
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(saved).toBe('https://example.com')
  })

  it('opens a draft date popover on one click and saves only through Save', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'date' }}
        label="Discovered"
        value="2026-08-10"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    expect(rendered.container.textContent).not.toContain('·')
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    expect(document.querySelector('[data-id="date-editor-popover"]')).not.toBeNull()
    expect(document.querySelector('[role="gridcell"][aria-selected="true"] button')?.getAttribute('data-date')).toBe('2026-08-10')
    await click(document.querySelector('button[data-date="2026-08-11"]'))
    expect(saved).toBeUndefined()
    await click(document.querySelector('[data-id="date-editor-save"]'))
    expect(saved).toBe('2026-08-11')
  })

  it('preserves a datetime instant when its timezone changes', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'date' }}
        label="Starts"
        value="2026-09-04T12:30:45.125Z"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    expect(rendered.container.textContent).toMatch(/12:30.*UTC/)
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const timezone = document.querySelector('button[aria-label="Timezone"]')
    await chooseMenuOption(timezone, '+03:00')
    const time = document.querySelector('input[aria-label="Time"]')
    expect(time).toBeInstanceOf(HTMLInputElement)
    expect((time as HTMLInputElement).value).toBe('15:30')
    await click(document.querySelector('[data-id="date-editor-save"]'))
    expect(saved).toBe('2026-09-04T15:30:45.125+03:00')
  })

  it('opens and saves floating date-times without adding a timezone', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'date' }}
        label="Starts"
        value="2026-09-04T12:30:45.125"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    expect(rendered.container.textContent).toMatch(/12:30/)
    expect(rendered.container.textContent).not.toContain('Timezone missing')
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const timezone = document.querySelector('button[aria-label="Timezone"]')
    expect(timezone).toBeInstanceOf(HTMLButtonElement)
    expect(timezone?.textContent).toContain('No timezone · floating time')
    await click(document.querySelector('button[data-date="2026-09-05"]'))
    await click(document.querySelector('[data-id="date-editor-save"]'))
    expect(saved).toBe('2026-09-05T12:30:45.125')
  })

  it('clears optional dates to null and prevents clearing required dates', async () => {
    let saved: unknown = 'unchanged'
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'date' }}
        label="Due"
        value="2026-09-04"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await click(document.querySelector('[data-id="date-editor-clear"]'))
    expect(saved).toBeNull()

    await rendered.cleanup()
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'date', required: true }}
        label="Due"
        value="2026-09-04"
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const clear = Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Clear')
    expect(clear).toBeInstanceOf(HTMLButtonElement)
    expect((clear as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses defaultIncludeTime only for an empty date', async () => {
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'date', defaultIncludeTime: true }}
        label="Due"
        value={null}
        onOpen={() => undefined}
        onCommit={async () => undefined}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const includeTime = document.querySelector('input[aria-label="Include time"]')
    expect(includeTime).toBeInstanceOf(HTMLInputElement)
    expect((includeTime as HTMLInputElement).checked).toBe(true)
    expect(document.querySelector('input[aria-label="Time"]')).not.toBeNull()
    expect((document.querySelector('[data-id="date-editor-save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('uses a spinner-free number field and rejects non-numeric text', async () => {
    let saved: unknown
    rendered = await renderComponent(
      <JsonViewSchemaValueCell
        descriptor={{ type: 'number' }}
        label="Score"
        value={42}
        onOpen={() => undefined}
        onCommit={async (value) => { saved = value }}
      />,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const input = rendered.container.querySelector('input[inputmode="decimal"]')
    if (!(input instanceof HTMLInputElement)) throw new Error('Expected number editor')
    expect(input.type).toBe('text')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'not a number')
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await Promise.resolve()
    })
    expect(saved).toBeUndefined()
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toBe('Value must be a finite number')
  })

  it('lets an extension register a new type and editor widget', async () => {
    let saved: unknown
    const types = createDefaultTypeRegistry().register({
      name: 'rating',
      validate: (value) => typeof value === 'number' && value >= 1 && value <= 5
        ? undefined
        : 'Choose a rating from 1 to 5',
    })
    const widgets = createDefaultWidgetRegistry().register('rating', ({ label, onCommit }) => (
      <button type="button" data-id="rating-widget" onClick={() => onCommit(5)}>Rate {label}</button>
    ))
    rendered = await renderComponent(
      <JsonViewsProvider types={types} widgets={widgets}>
        <JsonViewSchemaValueCell
          descriptor={{ type: 'rating' }}
          label="Score"
          value={3}
          onOpen={() => undefined}
          onCommit={async (value) => { saved = value }}
        />
      </JsonViewsProvider>,
    )

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    await click(rendered.container.querySelector('[data-id="rating-widget"]'))
    expect(saved).toBe(5)
  })

  it('lets an extension replace only the date editor', () => {
    const widgets = createDefaultWidgetRegistry()
    const display = widgets.getDisplay('date')
    const CustomDateEditor = () => <button type="button">Custom date</button>

    widgets.register('date', { editor: CustomDateEditor })

    expect(widgets.get('date')).toBe(CustomDateEditor)
    expect(widgets.getDisplay('date')).toBe(display)
  })
  it('edits rendered body prose on click while keeping Markdown links interactive', async () => {
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type: 'body' }} label="Body" value="Linked body" onOpen={() => undefined} onCommit={async () => {}} renderMarkdown={() => <p><a href="https://example.com">Reference</a></p>} />,
    )
    const link = rendered.container.querySelector('a[href="https://example.com"]')
    expect(link).not.toBeNull()
    expect(link?.closest('[role="button"], button')).toBeNull()
    expect(link?.closest('[data-id="structured-value-cell"]')?.querySelector('span p')).toBeNull()
    expect(rendered.container.querySelectorAll('[aria-label="Edit Body"]')).toHaveLength(1)
    const editSurface = rendered.container.querySelector('[aria-label="Edit Body"]')
    expect(editSurface?.getAttribute('role')).toBe('group')
    link?.addEventListener('click', (event) => event.preventDefault())
    await click(link)
    expect(rendered.container.querySelector('textarea[aria-label="Edit Body"]')).toBeNull()
    await click(rendered.container.querySelector('p'))
    expect(rendered.container.querySelector('textarea[aria-label="Edit Body"]')).not.toBeNull()
  })

  it('keeps a body editor at the rendered prose size', async () => {
    const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type: 'body' }} label="Body" value="First paragraph.\n\nSecond paragraph." onOpen={() => undefined} onCommit={async () => {}} />,
    )
    const display = rendered.container.querySelector('[data-id="jsonView-schema-value"]')
    if (!(display instanceof HTMLDivElement)) throw new Error('Expected body display')
    let frameHeight = 224
    Object.defineProperty(display, 'getBoundingClientRect', {
      value: () => ({ height: frameHeight }),
    })

    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))

    const textarea = rendered.container.querySelector('textarea[aria-label="Edit Body"]')
    if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Expected body editor')
    expect(textarea.classList.contains('[font:inherit]')).toBe(true)
    expect(textarea.style.minHeight).toBe('224px')
    expect(textarea.style.height).toBe('224px')
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })

    const editorFrame = rendered.container.querySelector('[data-id="jsonView-schema-value"]')
    if (!(editorFrame instanceof HTMLDivElement)) throw new Error('Expected body editor frame')
    expect(editorFrame).toBe(display)
    frameHeight = 280
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })

    expect(rendered.container.querySelector('textarea[aria-label="Edit Body"]')).toBeNull()
    expect((rendered.container.querySelector('[data-id="jsonView-schema-value"]') as HTMLElement).style.minHeight).toBe('')
  })

  it('keeps a schema-driven record title at the heading size and height', async () => {
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus')
    rendered = await renderComponent(
      <JsonViewSchemaValueCell variant="record-title" descriptor={{ type: 'text' }} label="Title" value="A record title" onOpen={() => undefined} onCommit={async () => {}} />,
    )
    const display = rendered.container.querySelector('[data-id="jsonView-schema-value"]')
    if (!(display instanceof HTMLDivElement)) throw new Error('Expected title display')
    Object.defineProperty(display, 'getBoundingClientRect', {
      value: () => ({ height: 48 }),
    })
    expect(display.querySelector('[data-id="structured-value-cell"]')?.classList.contains('min-h-10')).toBe(true)

    await click(display.querySelector('[data-id="atomic-edit-value"]'))

    const editor = rendered.container.querySelector('[data-id="jsonView-schema-editor"]')
    expect(editor?.classList.contains('text-xl')).toBe(true)
    expect(editor?.classList.contains('font-semibold')).toBe(true)
    expect(rendered.container.querySelector('[data-id="jsonView-schema-value"]')).toBe(display)
    expect((display as HTMLElement).style.minHeight).toBe('48px')
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
  })

})

describe('Enter in schema editors', () => {
  async function typeInto(control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
    const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(control, value)
      control.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  async function pressEnter(control: Element, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    await act(async () => {
      control.dispatchEvent(event)
      await Promise.resolve()
    })
    return event
  }

  it('saves multiline text on Enter and leaves Shift+Enter to break the line', async () => {
    const onCommit = vi.fn(async () => {})
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type: 'text', multiline: true }} label="Notes" value="First" onOpen={() => undefined} onCommit={onCommit} />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const textarea = rendered.container.querySelector('textarea')!
    await typeInto(textarea, 'First\nSecond')

    expect((await pressEnter(textarea, { shiftKey: true })).defaultPrevented).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
    await pressEnter(textarea)
    expect(onCommit).toHaveBeenCalledWith('First\nSecond')
  })

  it('keeps Enter for line breaks in Markdown and saves on Cmd+Enter', async () => {
    const onCommit = vi.fn(async () => {})
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type: 'markdown' }} label="Body" value="Intro" onOpen={() => undefined} onCommit={onCommit} />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const textarea = rendered.container.querySelector('textarea')!
    await typeInto(textarea, 'Intro\n\nMore')

    expect((await pressEnter(textarea)).defaultPrevented).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
    await pressEnter(textarea, { metaKey: true })
    expect(onCommit).toHaveBeenCalledWith('Intro\n\nMore')
  })

  it('leaves Enter to a widget that handles it itself', async () => {
    const onCommit = vi.fn(async () => {})
    const CodeEditor = ({ label, onChange, stringValue }: JsonViewEditWidgetProps) => (
      <input aria-label={`Edit ${label}`} value={stringValue} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
    )
    rendered = await renderComponent(
      <JsonViewsProvider widgets={createDefaultWidgetRegistry().register('text', CodeEditor)}>
        <JsonViewSchemaValueCell descriptor={{ type: 'text' }} label="Snippet" value="a" onOpen={() => undefined} onCommit={onCommit} />
      </JsonViewsProvider>,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const input = rendered.container.querySelector<HTMLInputElement>('input[aria-label="Edit Snippet"]')!
    await typeInto(input, 'b')
    await pressEnter(input)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('saves a date-time when Enter is pressed in the time field', async () => {
    const onCommit = vi.fn(async (_value: unknown) => {})
    rendered = await renderComponent(
      <JsonViewSchemaValueCell descriptor={{ type: 'date' }} label="Starts" value="2026-09-04T12:30:45.125" onOpen={() => undefined} onCommit={onCommit} />,
    )
    await click(rendered.container.querySelector('[data-id="atomic-edit-value"]'))
    const time = document.querySelector<HTMLInputElement>('input[aria-label="Time"]')!
    await typeInto(time, '09:15')
    await pressEnter(time)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit.mock.calls[0][0]).toMatch(/^2026-09-04T09:15/)
  })
})
