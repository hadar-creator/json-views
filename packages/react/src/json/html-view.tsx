import { createElement, Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { htmlRepeatKeys, JSON_VIEW_PATH_MISSING, resolveHtmlViewBinding, schemaForJsonViewPath, type CompiledJsonViewMetadata, type CompiledJsonViewView, type ValuePath } from '@script-it/json-views-core'
import { useJsonViewsPortalContainer } from '../surface.js'
import { useAnchoredPosition } from '../lib/use-anchored-position.js'
import { EditBaseContext } from '../structured-data/edit-base.js'
import { isLongText } from './long-text.js'
import { SchemaEditor } from './schema-value.js'
import { useJsonSourceLiterals } from './source-literals.js'
import { parseHtmlTemplate, type HtmlTemplateNode } from './html-view/template.js'
import { NativeHtmlControl } from './html-view/native-control.js'
import { formatHtmlValue, htmlValueForEditing, htmlValueFromEditing } from './html-view/format-value.js'
import type { JsonViewJsonEditing } from './view-types.js'

const skeleton = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>body{margin:0;font:14px system-ui;background:var(--jv-background);color:var(--jv-foreground)}*{box-sizing:border-box}jv-field,jv-value{display:inline}button.jv-field{font:inherit;color:inherit;background:transparent;border:0;padding:0;text-align:inherit;cursor:pointer}button.jv-field:hover{outline:1px dashed currentColor}button.jv-field:focus-visible{outline:2px solid currentColor}</style></head><body><div id="mount"></div></body></html>`
export function HtmlView({ compiled, view, editing, fillHeight, onCurrentPathChange }: { compiled: CompiledJsonViewMetadata; view: CompiledJsonViewView; editing?: JsonViewJsonEditing; fillHeight?: boolean; onCurrentPathChange?: (path: ValuePath) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), editorRef = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<Document>(), [error, setError] = useState(''), [height, setHeight] = useState(500)
  const [selected, setSelected] = useState<{ path: ValuePath; anchor: HTMLElement; base?: string; attrs: Record<string, string>; resolve: (binding: string) => unknown; syncPath?: ValuePath; byteLengthPath?: ValuePath }>()
  const base = useContext(EditBaseContext), literals = useJsonSourceLiterals(), portal = useJsonViewsPortalContainer()
  const anchorRef = useRef<HTMLElement | null>(null); anchorRef.current = selected?.anchor ?? null
  // A bound field is laid out by the template, not by a column, so the popup
  // takes its width from the text it covers instead of a fixed card width.
  const position = useAnchoredPosition(Boolean(selected), anchorRef, editorRef, 'bottom', 'start', true)
  const parsed = useMemo(() => {
    if (!doc) return { nodes: [], warnings: [] }
    try { return parseHtmlTemplate(doc, view.html ?? '') } catch (cause) { return { nodes: [], warnings: [cause instanceof Error ? cause.message : 'Invalid HTML'] } }
  }, [doc, view.html])
  useEffect(() => { onCurrentPathChange?.(view.sourcePath) }, [view.sourcePath, onCurrentPathChange])
  useEffect(() => { setSelected(undefined); setError('') }, [view.html, view.id])
  useEffect(() => {
    if (!doc) return
    const style = doc.createElement('style'); style.textContent = view.css ?? ''; doc.head.appendChild(style)
    return () => style.remove()
  }, [doc, view.css])
  useEffect(() => {
    if (!doc || !frame.current) return
    const update = () => {
      const computed = getComputedStyle(frame.current!)
      for (const name of ['background', 'foreground', 'muted', 'border', 'accent']) doc.documentElement.style.setProperty('--jv-' + name, computed.getPropertyValue('--jv-' + name))
      doc.documentElement.style.colorScheme = frame.current!.closest('[data-json-views-theme]')?.getAttribute('data-json-views-theme') ?? 'light'
      if (!fillHeight) setHeight(Math.min(2000, Math.max(200, doc.body.scrollHeight)))
    }
    update(); const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update); observer?.observe(doc.body)
    const themeObserver = new MutationObserver(update); const host = frame.current.closest('[data-json-views-theme]'); if (host) themeObserver.observe(host, { attributes: true })
    return () => { observer?.disconnect(); themeObserver.disconnect() }
  }, [doc, fillHeight])
  useEffect(() => {
    if (!selected || !doc) return
    const close = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      const target = event.target as Element
      if (event.type !== 'keydown' && (editorRef.current?.contains(target) || selected.anchor.contains(target) || target.closest?.('[data-radix-popper-content-wrapper], [data-anchored-popup]'))) return
      setSelected(undefined); if (selected.anchor.isConnected) selected.anchor.focus()
    }
    doc.addEventListener('mousedown', close); doc.addEventListener('keydown', close); document.addEventListener('mousedown', close)
    return () => { doc.removeEventListener('mousedown', close); doc.removeEventListener('keydown', close); document.removeEventListener('mousedown', close) }
  }, [selected, doc])
  let expanded = 0
  const warnings: string[] = [...parsed.warnings]
  const resolve = (expression: string, aliases: Record<string, ValuePath>) => {
    const result = resolveHtmlViewBinding(compiled.root, expression, aliases, view.sourcePath)
    if (result.value === JSON_VIEW_PATH_MISSING) throw new Error(`Unresolved binding: ${expression}`)
    return result
  }
  const render = (nodes: HtmlTemplateNode[], aliases: Record<string, ValuePath> = {}): ReactNode[] => nodes.map(node => {
    if (++expanded > 10000) throw new Error('HTML view exceeds 10,000 expanded nodes')
    if (!node.tag) return node.text
    try {
      if (node.tag === 'jv-repeat') {
        const alias = node.attrs.as ?? 'item'
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || Object.hasOwn(aliases, alias)) throw new Error(`Invalid or duplicate repeat alias: ${alias}`)
        const resolved = resolve(node.attrs.source ?? '', aliases)
        if (!Array.isArray(resolved.value)) throw new Error('jv-repeat source must be an array')
        const keys = htmlRepeatKeys(resolved.value, node.attrs.key)
        if (node.attrs.order && !['forward', 'reverse'].includes(node.attrs.order)) throw new Error('Repeat order must be forward or reverse')
        const indices = resolved.value.map((_, index) => index)
        if (node.attrs.order === 'reverse') indices.reverse()
        return indices.map(index => <Fragment key={`${node.id}:${keys[index]}`}>{render(node.children, { ...aliases, [alias]: [...resolved.sourcePath, index] })}</Fragment>)
      }
      const props: Record<string, unknown> = { key: node.id }
      const mapping: Record<string, string> = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', readonly: 'readOnly', maxlength: 'maxLength', viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', 'stroke-width': 'strokeWidth', 'text-anchor': 'textAnchor', 'font-size': 'fontSize', 'font-family': 'fontFamily' }
      for (const [key, value] of Object.entries(node.attrs)) {
        if (key.startsWith('jv-attr-')) {
          const scalar = resolve(value, aliases).value
          if (scalar !== null && typeof scalar === 'object' || typeof scalar === 'string' && /url\s*\(/i.test(scalar)) throw new Error('Attribute bindings require safe scalar values')
          props[mapping[key.slice(8)] ?? key.slice(8)] = scalar
        }
        else if (!key.startsWith('jv-') && !['bind', 'source', 'as', 'key', 'value', 'checked'].includes(key)) props[mapping[key] ?? key] = ['disabled', 'readonly'].includes(key) ? true : value
      }
      if (node.tag === 'jv-field' || node.tag === 'jv-value') {
        const resolved = resolve(node.attrs.bind ?? '', aliases), value = resolved.value
        if (value !== null && typeof value === 'object') throw new Error('Use jv-repeat for arrays and objects')
        const resolveValue = (binding: string) => resolve(binding, aliases).value
        const text = formatHtmlValue(value, node.attrs, resolveValue) ?? literals(resolved.sourcePath) ?? (value == null ? '—' : String(value))
        const sync = node.attrs['sync-bind'] ? resolve(node.attrs['sync-bind'], aliases) : undefined
        const byteLength = node.attrs['byte-length-bind'] ? resolve(node.attrs['byte-length-bind'], aliases) : undefined
        if (sync && sync.value !== null && typeof sync.value === 'object') throw new Error('sync-bind must address a scalar')
        if (byteLength && (node.attrs.format !== 'base64url' || typeof byteLength.value !== 'number')) throw new Error('byte-length-bind requires base64url and a numeric size field')
        const canEdit = node.tag === 'jv-field' && editing && [resolved, sync, byteLength].every(target => !target || editing.canReplace?.(target.sourcePath) !== false)
        return <span key={node.id}>{canEdit ? <button className="jv-field" aria-label={node.attrs['aria-label'] ?? `Edit ${node.attrs.bind}`} onClick={event => setSelected({ path: resolved.sourcePath, anchor: event.currentTarget, base, attrs: node.attrs, resolve: resolveValue, syncPath: sync?.sourcePath, byteLengthPath: byteLength?.sourcePath })}>{text}</button> : text}</span>
      }
      if (node.attrs['jv-bind']) {
        if (node.tag !== 'input' && node.tag !== 'textarea') throw new Error('jv-bind requires input or textarea')
        const resolved = resolve(node.attrs['jv-bind'], aliases)
        return <NativeHtmlControl key={node.id} tag={node.tag} props={props} path={resolved.sourcePath} value={resolved.value} editing={editing} report={setError} />
      }
      if (node.attrs['jv-value']) {
        if (!['progress', 'meter'].includes(node.tag)) throw new Error('jv-value attribute requires progress or meter')
        props.value = resolve(node.attrs['jv-value'], aliases).value
      }
      return createElement(node.tag, props, ...render(node.children, aliases))
    } catch (cause) { if (cause instanceof Error && cause.message.includes('10,000 expanded nodes')) throw cause; const message = `${view.name}, node ${node.id}: ${cause instanceof Error ? cause.message : 'Invalid binding'}`; warnings.push(message); return <span key={node.id}>[Binding unavailable]</span> }
  })
  let content: ReactNode
  try { content = render(parsed.nodes) } catch (cause) { content = null; warnings.push(cause instanceof Error ? cause.message : 'HTML expansion failed') }
  const selectedValue = selected ? resolveHtmlViewBinding(compiled.root, '$' + selected.path.map(p => typeof p === 'number' ? `[${p}]` : `['${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}']`).join(''), {}, view.sourcePath).value : undefined
  const descriptor = selected ? schemaForJsonViewPath(compiled.schema, selected.path)?.descriptor ?? { type: typeof selectedValue === 'number' ? 'number' : typeof selectedValue === 'boolean' ? 'checkbox' : 'text' } : undefined
  // Text too long for one line gets the resizable multi-line control, matching
  // how tables and records present the same value.
  let editorValue = selectedValue
  let formattedDescriptor = selected?.attrs.format === 'base64url' ? { type: 'text', multiline: true } : descriptor
  try {
    if (selected) editorValue = htmlValueForEditing(selectedValue, selected.attrs, selected.resolve)
    if (selected?.attrs.format === 'currency-minor' && descriptor) {
      formattedDescriptor = { ...descriptor }
      for (const key of ['minimum', 'maximum', 'step']) {
        if (typeof descriptor[key] === 'number') formattedDescriptor[key] = htmlValueForEditing(descriptor[key], selected.attrs, selected.resolve)
      }
    }
  } catch {
    // A source change can invalidate an open field. Its stale-save guard still
    // rejects the draft; rendering that state must not crash the whole view.
  }
  const editorDescriptor = formattedDescriptor?.type === 'text' && isLongText(editorValue, formattedDescriptor) ? { ...formattedDescriptor, multiline: true } : formattedDescriptor
  return <div className="flex min-h-0 flex-1 flex-col" data-id="jsonView-html-view">
    {(error || warnings.length > 0) && <div role="alert" className="border-b p-2 text-xs">{error || warnings.slice(0, 10).join(' · ')}{error && <button onClick={() => setError('')} className="ml-2 underline">Dismiss</button>}</div>}
    <iframe ref={frame} title={view.name} sandbox="allow-same-origin" srcDoc={skeleton} className="w-full flex-1 border-0" style={{ minHeight: fillHeight ? 200 : height, height: fillHeight ? '100%' : height }} onLoad={event => { setDoc(event.currentTarget.contentDocument ?? undefined); setSelected(undefined) }} />
    {doc?.getElementById('mount') && createPortal(content, doc.getElementById('mount')!)}
    {selected && editorDescriptor && editing && portal && createPortal(<div ref={editorRef} data-anchored-popup className="z-[120] w-80 rounded-md border bg-card p-3 text-card-foreground shadow-lg" style={position}>
      <EditBaseContext.Provider value={base}><SchemaEditor key={`${view.id}:${JSON.stringify(selected.path)}`} descriptor={editorDescriptor} disabled={editing.saving} label={selected.attrs['aria-label'] ?? String(selected.path.at(-1) ?? 'value')} variant="default" value={editorValue} onCancel={() => { const anchor = selected.anchor; setSelected(undefined); if (anchor.isConnected) anchor.focus() }} onCommit={async value => {
        if (selected.base !== base) throw new Error('This document changed outside this editor. Cancel and reopen it before saving.')
        const encoded = htmlValueFromEditing(value, selected.attrs, selected.resolve)
        const replacements = [{ path: selected.path, value: encoded }]
        if (selected.syncPath) replacements.push({ path: selected.syncPath, value: encoded })
        if (selected.byteLengthPath) replacements.push({ path: selected.byteLengthPath, value: new TextEncoder().encode(String(value)).length })
        if (replacements.length > 1) await editing.replaceMany(replacements)
        else await editing.replace(selected.path, encoded)
      }} /></EditBaseContext.Provider>
    </div>, portal)}
  </div>
}
