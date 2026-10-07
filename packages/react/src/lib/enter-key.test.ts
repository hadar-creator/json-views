import { describe, expect, it } from 'vitest'

import { submitsOnEnter, type EnterKeyEvent } from './enter-key.js'

function key(overrides: Partial<EnterKeyEvent> = {}): EnterKeyEvent {
  return { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, ...overrides }
}

describe('submitsOnEnter', () => {
  it('saves a single-line control on Enter, with or without modifiers', () => {
    for (const event of [key(), key({ shiftKey: true }), key({ metaKey: true }), key({ ctrlKey: true })]) {
      expect(submitsOnEnter(event, { multiline: false, enterKey: 'newline' })).toBe(true)
    }
  })

  it('saves a multiline control on Enter and leaves Shift+Enter to break the line', () => {
    expect(submitsOnEnter(key(), { multiline: true, enterKey: 'submit' })).toBe(true)
    expect(submitsOnEnter(key({ shiftKey: true }), { multiline: true, enterKey: 'submit' })).toBe(false)
  })

  it('keeps Enter for line breaks in long-form controls and saves on Cmd or Ctrl+Enter', () => {
    expect(submitsOnEnter(key(), { multiline: true, enterKey: 'newline' })).toBe(false)
    expect(submitsOnEnter(key({ shiftKey: true }), { multiline: true, enterKey: 'newline' })).toBe(false)
    expect(submitsOnEnter(key({ metaKey: true }), { multiline: true, enterKey: 'newline' })).toBe(true)
    expect(submitsOnEnter(key({ ctrlKey: true }), { multiline: true, enterKey: 'newline' })).toBe(true)
  })

  it('leaves an Enter that confirms IME composition to the IME', () => {
    expect(submitsOnEnter(key({ isComposing: true }), { multiline: false, enterKey: 'submit' })).toBe(false)
    expect(submitsOnEnter(key({ nativeEvent: { isComposing: true } }), { multiline: true, enterKey: 'submit' })).toBe(false)
    expect(submitsOnEnter(key({ keyCode: 229 }), { multiline: false, enterKey: 'submit' })).toBe(false)
  })

  it('ignores other keys', () => {
    expect(submitsOnEnter(key({ key: 'a' }), { multiline: false, enterKey: 'submit' })).toBe(false)
  })
})
