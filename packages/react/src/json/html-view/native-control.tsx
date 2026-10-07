import { createElement, useContext, useEffect, useRef, useState } from 'react'
import type { ValuePath } from '@script-it/json-views-core'
import { EditBaseContext } from '../../structured-data/edit-base.js'
import { submitsOnEnter, useEnterKeyBehavior, type EnterKeyEvent } from '../../lib/enter-key.js'
import type { JsonViewJsonEditing } from '../view-types.js'

export function NativeHtmlControl({ tag, props, path, value, editing, report }: { tag: string; props: Record<string, unknown>; path: ValuePath; value: unknown; editing?: JsonViewJsonEditing; report: (message: string) => void }) {
  const base = useContext(EditBaseContext)
  const [draft, setDraft] = useState(value == null ? '' : String(value))
  const [active, setActive] = useState(false)
  const [savingThisControl, setSavingThisControl] = useState(false)
  const original = useRef<{ base?: string; path: ValuePath }>({ base, path })
  const pending = useRef(false), changed = useRef(false), draftRef = useRef(draft)
  const type = props.type ?? 'text'
  const enterKey = useEnterKeyBehavior()
  useEffect(() => { if (!active) { const next = value == null ? '' : String(value); setDraft(next); draftRef.current = next } }, [value, active])
  const start = () => { if (!active) { original.current = { base, path: [...path] }; setActive(true) } }
  const cancel = () => { changed.current = false; setActive(false); draftRef.current = value == null ? '' : String(value); setDraft(draftRef.current) }
  const commit = async (candidate?: unknown) => {
    if (!editing || pending.current || (!changed.current && candidate === undefined)) return
    if (editing.saving) { report('Wait for the current save to finish'); return }
    if (original.current.base !== base || JSON.stringify(original.current.path) !== JSON.stringify(path)) { report('This document changed outside this editor. Cancel and reopen it before saving.'); return }
    let next: unknown = candidate ?? draftRef.current
    if (type === 'number' || type === 'range') {
      if (String(next).trim() === '' || !Number.isFinite(Number(next))) { report('Enter a finite number'); return }
      next = Number(next)
      if (props.min !== undefined && Number(next) < Number(props.min) || props.max !== undefined && Number(next) > Number(props.max)) { report('Value is outside the control limits'); return }
    }
    if (type === 'checkbox' && typeof value !== 'boolean' || (type === 'number' || type === 'range') && typeof value !== 'number' || (type === 'text' || tag === 'textarea') && typeof value !== 'string') { report('Control type does not match the JSON value'); return }
    pending.current = true
    setSavingThisControl(true)
    try { await editing.replace(original.current.path, next); changed.current = false; setActive(false); report('') } catch (error) { report(error instanceof Error ? error.message : 'Could not save'); changed.current = true } finally { pending.current = false; setSavingThisControl(false) }
  }
  return createElement(tag, {
    ...props, disabled: !editing || savingThisControl || editing.canReplace?.(path) === false,
    ...(type === 'checkbox' ? { checked: value === true } : { value: draft }),
    onFocus: start, onPointerDown: start,
    onChange: (event: { target: HTMLInputElement }) => {
      if (type === 'checkbox') { original.current = { base, path: [...path] }; void commit(event.target.checked); return }
      changed.current = true; draftRef.current = event.target.value; setDraft(event.target.value)
    },
    onBlur: () => { void commit() },
    onPointerUp: () => { if (type === 'range') void commit() },
    onKeyUp: () => { if (type === 'range') void commit() },
    onKeyDown: (event: EnterKeyEvent & { preventDefault: () => void }) => {
      if (event.key === 'Escape') { event.preventDefault(); cancel(); report('') }
      if (submitsOnEnter(event, { multiline: tag === 'textarea', enterKey })) { event.preventDefault(); void commit() }
    },
  })
}
