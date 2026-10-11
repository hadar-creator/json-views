import { TooltipProvider } from '../../primitives/tooltip.js'
// @vitest-environment jsdom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { JSONContent } from '../json-content.js'
import { renderComponent } from '../../test/render.js'

it.each([
  { name: 'MIME body and UTF-8 byte size', initial: { body: { data: 'SGVsbG8', size: 5 } }, html: '<jv-field bind="$.body.data" format="base64url" byte-length-bind="$.body.size"></jv-field>', typed: 'Hello 👋', expected: { body: { data: Buffer.from('Hello 👋').toString('base64url'), size: 10 } } },
  { name: 'paired rich text', initial: { text: { content: 'Old' }, plain_text: 'Old' }, html: '<jv-field bind="$.text.content" sync-bind="$.plain_text"></jv-field>', typed: 'New title', expected: { text: { content: 'New title' }, plain_text: 'New title' } },
  { name: 'bound currency and received amount', initial: { amount: 24900, received: 24900, currency: 'usd' }, html: '<jv-field bind="$.amount" format="currency-minor" currency-bind="$.currency" currency="JPY" sync-bind="$.received"></jv-field>', typed: '19.99', expected: { amount: 1999, received: 1999, currency: 'usd' } },
])('saves $name atomically through the source pipeline', async ({ initial, html, typed, expected }) => {
  const metadata = { version: 1, views: [{ name: 'Edit', path: '$', display: 'html', html }] }
  const source = JSON.stringify({ ...initial, untouched: 'preserved', $jsonviews: metadata }, null, 2)
  const save = vi.fn(async (_content: string) => {})
  const rendered = await renderComponent(<JSONContent content={source} documentId="paired-html" onSave={save} />)
  try {
    const frame = rendered.container.querySelector('iframe')!
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const doc = frame.contentDocument!
    await act(async () => { doc.body.innerHTML = '<div id="mount"></div>'; frame.dispatchEvent(new Event('load')) })
    await act(async () => { rendered.root.render(<TooltipProvider><JSONContent content={source} documentId="paired-html" revision="one" onSave={save} /></TooltipProvider>) })
    await act(async () => { (doc.querySelector('button.jv-field') as HTMLButtonElement).click() })
    const input = document.querySelector('[data-anchored-popup] input, [data-anchored-popup] textarea') as HTMLInputElement | HTMLTextAreaElement
    await act(async () => {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, typed)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(JSON.parse(save.mock.calls[0][0])).toEqual({ ...expected, untouched: 'preserved', $jsonviews: metadata })
  } finally { await rendered.cleanup() }
})

it('renders formatted values and reversed records while editing their original source paths', async () => {
  const metadata = { version: 1, views: [{ name: 'Formatted', path: '$', display: 'html', html: '<jv-repeat source="$.rows" as="row" key="id" order="reverse"><p><jv-field bind="row.amount" format="currency-minor" currency-bind="row.currency"></jv-field></p></jv-repeat><p><jv-value bind="$.body" format="base64url"></jv-value></p>' }] }
  const source = JSON.stringify({ rows: [{ id: 'a', amount: 24900, currency: 'usd' }, { id: 'b', amount: 9900, currency: 'usd' }], body: Buffer.from('<img src=x onerror=alert(1)>').toString('base64url'), $jsonviews: metadata })
  const save = vi.fn(async (_content: string) => {})
  const rendered = await renderComponent(<JSONContent content={source} documentId="formatted-html" onSave={save} />)
  try {
    const frame = rendered.container.querySelector('iframe')!
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const doc = frame.contentDocument!
    await act(async () => { doc.body.innerHTML = '<div id="mount"></div>'; frame.dispatchEvent(new Event('load')) })
    await act(async () => { rendered.root.render(<TooltipProvider><JSONContent content={source} documentId="formatted-html" revision="one" onSave={save} /></TooltipProvider>) })
    expect(doc.body.textContent).toContain('$99.00$249.00')
    expect(doc.body.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(doc.querySelector('img')).toBeNull()
    expect(rendered.container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => { (doc.querySelector('button.jv-field') as HTMLButtonElement).click() })
    expect((document.querySelector('[data-anchored-popup] input') as HTMLInputElement).value).toBe('99')
    const input = document.querySelector('[data-anchored-popup] input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '19.99')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })) })
    expect(save).toHaveBeenCalledTimes(1)
    expect(JSON.parse(save.mock.calls[0][0]).rows).toEqual([{ id: 'a', amount: 24900, currency: 'usd' }, { id: 'b', amount: 1999, currency: 'usd' }])
  } finally { await rendered.cleanup() }
})

it('interprets an arbitrary embedded template and preserves source through the real save pipeline', async () => {
  const metadata = { version: 1, views: [{ name: 'Custom', path: '$', display: 'html', html: '<h1><jv-field bind="$.name"></jv-field></h1><input type="checkbox" jv-bind="$.done" aria-label="Done"><jv-repeat source="$.rows" as="row" key="id"><p><jv-value bind="row.label"></jv-value></p></jv-repeat>', css: 'h1 { font-size: 30px; }' }] }
  const source = '{\n  "name" : "Original",\n  "done" : false,\n  "rows": [{"id":"a","label":"First"}],\n  "$jsonviews": '+JSON.stringify(metadata)+'\n}'
  const save = vi.fn(async (_content: string) => {})
  const rendered = await renderComponent(<JSONContent content={source} documentId="html" onSave={save} />)
  try {
    const frame = rendered.container.querySelector('iframe')!
    // jsdom does not load srcdoc: provide only the trusted mount skeleton.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const doc = frame.contentDocument!
    await act(async () => { doc.body.innerHTML = '<div id="mount"></div>'; frame.dispatchEvent(new Event('load')) })
    await act(async () => { rendered.root.render(<TooltipProvider><JSONContent content={source} documentId="html" revision="one" onSave={save} /></TooltipProvider>) })
    expect(doc.body.textContent).toContain('Original'); expect(doc.body.textContent).toContain('First')
    await act(async () => { (doc.querySelector('input') as HTMLInputElement).click() })
    expect(save).toHaveBeenCalledTimes(1)
    const saved = save.mock.calls[0][0] as string
    expect(saved).toContain('"done" : true'); expect(saved).toContain('"name" : "Original"')
    expect(JSON.parse(saved).$jsonviews).toEqual(metadata)
    expect(doc.head.textContent).toContain('font-size: 30px')
  } finally { await rendered.cleanup() }
})

it('opens a bound field in a control that fits its value', async () => {
  const metadata = { version: 1, views: [{ name: 'Custom', path: '$', display: 'html', html: '<p><jv-field bind="$.short"></jv-field></p><p><jv-field bind="$.long"></jv-field></p>' }] }
  const source = '{\n  "short": "Ready",\n  "long": ' + JSON.stringify('word '.repeat(40).trim()) + ',\n  "$jsonviews": ' + JSON.stringify(metadata) + '\n}'
  const save = vi.fn(async (_content: string) => {})
  const rendered = await renderComponent(<JSONContent content={source} documentId="html-editor" onSave={save} />)
  try {
    const frame = rendered.container.querySelector('iframe')!
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    const doc = frame.contentDocument!
    await act(async () => { doc.body.innerHTML = '<div id="mount"></div>'; frame.dispatchEvent(new Event('load')) })
    await act(async () => { rendered.root.render(<TooltipProvider><JSONContent content={source} documentId="html-editor" revision="one" onSave={save} /></TooltipProvider>) })
    const fields = () => [...doc.querySelectorAll('button.jv-field')] as HTMLButtonElement[]
    await act(async () => { fields()[1].click() })
    // A value past one line edits in the resizable textarea, not a single line.
    expect(document.querySelector('[data-anchored-popup] textarea')).not.toBeNull()
    await act(async () => { fields()[0].click() })
    expect(document.querySelector('[data-anchored-popup] textarea')).toBeNull()
    expect((document.querySelector('[data-anchored-popup] input') as HTMLInputElement).value).toBe('Ready')
  } finally { await rendered.cleanup() }
})
