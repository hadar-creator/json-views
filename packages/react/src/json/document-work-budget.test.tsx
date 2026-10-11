// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../primitives/tooltip.js'
import { renderComponent, type RenderResult } from '../test/render.js'
import { JSONContent } from './json-content.js'

let rendered: RenderResult | undefined
afterEach(async () => { await rendered?.cleanup(); rendered = undefined; vi.restoreAllMocks() })

async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('Missing control')
  await act(async () => {
    // Tab triggers activate on mousedown.
    if (element.getAttribute('role') === 'tab') element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    element.click()
    await Promise.resolve()
  })
}

function tableDocument(marker: string, space?: number): string {
  return JSON.stringify({ rows: Array.from({ length: 40 }, (_, index) => ({ id: index, name: `${marker} ${index}`, done: index % 2 === 0 })) }, null, space)
}

const wholeDocumentParses = (parse: ReturnType<typeof vi.spyOn>, source: string) => parse.mock.calls.filter(([input]) => input === source).length

// Large documents make every whole-document pass visible as latency, so the
// viewer may only parse a changed text a fixed number of times.
describe('whole-document work per content change', () => {
  it('parses a changed document three times while the source panel is hidden', async () => {
    const first = tableDocument('first', 2)
    const second = tableDocument('second', 2)
    rendered = await renderComponent(<JSONContent content={first} onSave={async () => undefined} />)
    expect(rendered.container.querySelector('[data-id="jsonView-source-editor"]')).toBeNull()

    const parse = vi.spyOn(JSON, 'parse')
    await act(async () => {
      rendered!.root.render(<TooltipProvider><JSONContent content={second} onSave={async () => undefined} /></TooltipProvider>)
      await Promise.resolve()
    })

    // Choosing the adapter, inspecting the document, and reading the source
    // diagnostics each parse once. Formatting and source target ranges wait
    // for the source panel.
    expect(wholeDocumentParses(parse, second)).toBe(3)
    expect(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]')).not.toBeNull()
  })

  it('formats the document only once the source panel is shown', async () => {
    const compact = tableDocument('row')
    rendered = await renderComponent(<JSONContent content={compact} onSave={async () => undefined} />)
    expect(rendered.container.querySelector('[aria-label="Format JSON"]')).toBeNull()

    const parse = vi.spyOn(JSON, 'parse')
    await click(rendered.container.querySelector('[data-id="jsonView-json-tab-source"]'))

    expect(rendered.container.querySelector('[aria-label="Format JSON"]')).not.toBeNull()
    expect(wholeDocumentParses(parse, compact)).toBe(1)
  })
})
