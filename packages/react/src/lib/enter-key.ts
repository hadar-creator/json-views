import { useJsonViewsDevice } from '../browser-device.js'

/** What a plain Enter does in a multiline control: save the value, or break the line. */
export type EnterKeyBehavior = 'submit' | 'newline'

/** Structural, so React's synthetic events and native events both fit. */
export interface EnterKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
}

/** An IME is confirming composed text, so the Enter belongs to the IME.
 *  Safari reports that keydown with keyCode 229 instead of `isComposing`. */
export function isComposing(event: EnterKeyEvent): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229
}

/**
 * Whether a keydown saves the editor it happened in. A single-line control
 * saves on Enter. In a multiline control Cmd/Ctrl+Enter always saves,
 * Shift+Enter never does (the browser inserts the line break), and a plain
 * Enter saves only when the editor's behavior is `'submit'`.
 */
export function submitsOnEnter(
  event: EnterKeyEvent,
  { multiline, enterKey }: { multiline: boolean; enterKey: EnterKeyBehavior },
): boolean {
  if (event.key !== 'Enter' || isComposing(event)) return false
  if (!multiline) return true
  if (event.metaKey || event.ctrlKey) return true
  if (event.shiftKey) return false
  return enterKey === 'submit'
}

/** Soft keyboards have no Shift+Enter, so on mobile Return always breaks the line. */
export function useEnterKeyBehavior(preferred: EnterKeyBehavior = 'submit'): EnterKeyBehavior {
  return useJsonViewsDevice() === 'mobile' ? 'newline' : preferred
}
