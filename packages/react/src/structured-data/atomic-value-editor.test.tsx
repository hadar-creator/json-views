// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { renderComponent, type RenderResult } from '../test/render.js'
import { JsonViewsDeviceProvider, type JsonViewsDevice } from '../browser-device.js'
import type { EnterKeyBehavior } from '../lib/enter-key.js'
import { AtomicValueEditor, StructuredValueCellFrame } from './atomic-value-editor.js'
import { StructuredCellFillContext } from './structured-cell-fill-context.js'

let rendered: RenderResult | null = null

afterEach(async () => {
  await rendered?.cleanup()
  rendered = null
  vi.restoreAllMocks()
})

async function editNotes({ device, enterKey }: { device?: JsonViewsDevice; enterKey?: EnterKeyBehavior } = {}) {
  const onCommit = vi.fn(async () => {})
  rendered = await renderComponent(
    <JsonViewsDeviceProvider device={device}>
      <AtomicValueEditor enterKey={enterKey} multiline label="Notes" value="First line" onCommit={onCommit}>
        <div>Rendered notes</div>
      </AtomicValueEditor>
    </JsonViewsDeviceProvider>,
  )
  await act(async () => { rendered!.container.querySelector<HTMLElement>('[data-id="atomic-edit-value"]')!.click() })
  const textarea = rendered.container.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'First line\nSecond line')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const press = async (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
    await act(async () => { textarea.dispatchEvent(event) })
    return event
  }
  return { onCommit, press }
}

it('saves a multiline value on Enter and leaves Shift+Enter to break the line', async () => {
  const { onCommit, press } = await editNotes()
  const lineBreak = await press({ shiftKey: true })
  expect(onCommit).not.toHaveBeenCalled()
  expect(lineBreak.defaultPrevented).toBe(false)
  const submit = await press()
  expect(submit.defaultPrevented).toBe(true)
  expect(onCommit).toHaveBeenCalledWith('First line\nSecond line')
})

it('keeps Enter for line breaks in long-form text and saves on Cmd+Enter', async () => {
  const { onCommit, press } = await editNotes({ enterKey: 'newline' })
  await press()
  expect(onCommit).not.toHaveBeenCalled()
  await press({ metaKey: true })
  expect(onCommit).toHaveBeenCalledWith('First line\nSecond line')
})

it('keeps Return for line breaks on mobile, where there is no Shift+Enter', async () => {
  const { onCommit, press } = await editNotes({ device: 'mobile' })
  await press()
  expect(onCommit).not.toHaveBeenCalled()
  await press({ ctrlKey: true })
  expect(onCommit).toHaveBeenCalledWith('First line\nSecond line')
})

it('does not save on the Enter that confirms IME composition', async () => {
  const { onCommit, press } = await editNotes()
  await press({ isComposing: true })
  expect(onCommit).not.toHaveBeenCalled()
})

it('activates cell padding and content once while preserving separate child actions', async () => {
  const activate = vi.fn()
  const separateAction = vi.fn()
  rendered = await renderComponent(
    <StructuredCellFillContext.Provider value={true}>
      <StructuredValueCellFrame activationLabel="Edit cell" onActivate={activate}
        actions={<button type="button" onClick={separateAction}>Separate action</button>}>
        <span>Cell value</span>
      </StructuredValueCellFrame>
    </StructuredCellFillContext.Provider>,
  )
  const frame = rendered.container.querySelector<HTMLElement>('[data-id="structured-value-cell"]')!
  await act(async () => { frame.click() })
  expect(activate).toHaveBeenCalledTimes(1)
  await act(async () => { frame.querySelector<HTMLElement>('[data-id="atomic-edit-value"] span')!.click() })
  expect(activate).toHaveBeenCalledTimes(2)
  await act(async () => { frame.querySelector('button')!.click() })
  expect(separateAction).toHaveBeenCalledTimes(1)
  expect(activate).toHaveBeenCalledTimes(2)
})

it('keeps a multiline value in the rendered text area and inherits its typography', async () => {
  const focusSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
  rendered = await renderComponent(
    <div className="text-sm">
      <AtomicValueEditor multiline label="Notes" value={'First paragraph.\n\nSecond paragraph.'} onCommit={async () => {}}>
        <div>Rendered notes</div>
      </AtomicValueEditor>
    </div>,
  )
  const frame = rendered.container.querySelector('[data-id="atomic-value-editor-frame"]')
  if (!(frame instanceof HTMLDivElement)) throw new Error('Expected multiline display frame')
  Object.defineProperty(frame, 'getBoundingClientRect', {
    value: () => ({ height: 176 }),
  })

  await act(async () => {
    const activation = frame.querySelector('[data-id="atomic-edit-value"]')
    if (!(activation instanceof HTMLElement)) throw new Error('Expected edit activation')
    activation.click()
    await Promise.resolve()
  })

  const textarea = rendered.container.querySelector('textarea[aria-label="Edit Notes"]')
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('Expected multiline editor')
  expect(textarea.classList.contains('[font:inherit]')).toBe(true)
  expect(textarea.classList.contains('focus:ring-inset')).toBe(true)
  expect(textarea.style.minHeight).toBe('176px')
  expect(textarea.style.height).toBe('176px')
  expect(rendered.container.querySelector('[data-id="atomic-value-editor-frame"]')).toBe(frame)
  expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })
})

 it('releases the expanded multiline height after cancel', async () => {
  rendered = await renderComponent(
    <AtomicValueEditor multiline label="Notes" value="Notes" onCommit={async () => {}}>
      <div>Notes</div>
    </AtomicValueEditor>,
  )
  const frame = rendered.container.querySelector<HTMLElement>('[data-id="atomic-value-editor-frame"]')!
  let height = 100
  vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect)
  for (let cycle = 0; cycle < 2; cycle++) {
    await act(async () => { frame.querySelector<HTMLElement>('[data-id="atomic-edit-value"]')!.click() })
    height = 280
    await act(async () => { rendered!.container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(frame.style.minHeight).toBe('')
    height = 100
  }
})
