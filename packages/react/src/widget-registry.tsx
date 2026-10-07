import { createContext, useContext, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import {
  createDefaultTypeRegistry,
  type JsonViewSchemaDescriptor,
  type JsonViewTypeRegistry,
} from '@script-it/json-views-core'
import { BooleanWidget } from './widgets/boolean-widget.js'
import { DateValueDisplay, DateValueEditor } from './widgets/date-picker-widget.js'
import { DropdownWidget } from './widgets/dropdown-widget.js'
import { MultiSelectWidget } from './widgets/multi-select-widget.js'
import { NumberWidget } from './widgets/number-widget.js'
import { TextareaWidget } from './widgets/textarea-widget.js'
import { TextWidget } from './widgets/text-widget.js'

export interface JsonViewEditWidgetProps {
  descriptor: JsonViewSchemaDescriptor
  disabled: boolean
  error?: string
  label: string
  value: unknown
  stringValue: string
  onChange: (value: unknown) => void
  onClear?: () => void
  onCommit: (value?: unknown) => void
  onCancel: () => void
  /** Keeps a multiline editor at least as tall as the value it replaced. */
  minHeight?: number
  /** Persists a built-in choice color in the matching annotation descriptor. */
  onOptionColorChange?: (optionValue: string, color: string) => void | Promise<void>
}

export type JsonViewEditWidget = ComponentType<JsonViewEditWidgetProps>

export interface JsonViewDisplayWidgetProps {
  compact: boolean
  descriptor: JsonViewSchemaDescriptor
  onOpen: () => void
  renderMarkdown?: (content: string) => ReactNode
  value: unknown
}

export type JsonViewDisplayWidget = ComponentType<JsonViewDisplayWidgetProps>

export interface JsonViewWidgetDefinition {
  editor: JsonViewEditWidget
  display?: JsonViewDisplayWidget
  /** Optional single-action editor; returns an editor-model candidate. */
  quickEdit?: (value: unknown) => unknown
  /** What a plain Enter does in the editor's multiline controls. `'submit'`
   *  (default) saves, and Shift+Enter breaks the line; `'newline'` keeps
   *  Enter for line breaks and saves on Cmd/Ctrl+Enter, for long-form
   *  documents. On mobile, Return always breaks the line. */
  enterKey?: 'submit' | 'newline'
}

export type JsonViewWidgetRegistration = JsonViewEditWidget | JsonViewWidgetDefinition

function common(props: JsonViewEditWidgetProps) {
  return {
    value: props.stringValue,
    onChange: props.onChange,
    onBlur: () => props.onCommit(),
    disabled: props.disabled,
    ariaLabel: `Edit ${props.label}`,
    invalid: Boolean(props.error),
    minHeight: props.minHeight,
    surface: 'inline' as const,
  }
}

const TextEditWidget: JsonViewEditWidget = (props) => {
  const Control = props.descriptor.multiline === true ? TextareaWidget : TextWidget
  return (
  <Control
    {...common(props)}
    uiHint={{
      type: 'text',
      placeholder: typeof props.descriptor.placeholder === 'string' ? props.descriptor.placeholder : undefined,
      multiline: props.descriptor.multiline === true,
    }}
  />
  )
}

const NumberEditWidget: JsonViewEditWidget = (props) => (
  <NumberWidget
    {...common(props)}
    metadata={{ type: 'float' }}
    uiHint={{
      type: 'number',
      min: typeof props.descriptor.minimum === 'number' ? props.descriptor.minimum : undefined,
      max: typeof props.descriptor.maximum === 'number' ? props.descriptor.maximum : undefined,
      step: props.descriptor.step,
    }}
  />
)

const CheckboxEditWidget: JsonViewEditWidget = (props) => (
  <BooleanWidget
    {...common(props)}
    onDirectSave={(value) => {
      props.onChange(value)
      props.onCommit(value)
    }}
  />
)

const SelectEditWidget: JsonViewEditWidget = (props) => (
  <DropdownWidget
    {...common(props)}
    onChange={(value) => {
      props.onChange(value)
      props.onCommit(value)
    }}
    onBlur={() => undefined}
    onDismiss={props.onCancel}
    options={(props.descriptor.options ?? []).map((value) => ({ value, label: value, color: props.descriptor.optionColors?.[value] }))}
    profile="pill-cell"
    creatable
    openOnMount
    emptyOptionLabel={props.descriptor.required ? undefined : 'None'}
    onOptionColorChange={props.onOptionColorChange}
  />
)

const MultiSelectEditWidget: JsonViewEditWidget = (props) => (
  <MultiSelectWidget
    {...common(props)}
    value={JSON.stringify(Array.isArray(props.value) ? props.value : [])}
    options={(props.descriptor.options ?? []).map((value) => ({ value, label: value, color: props.descriptor.optionColors?.[value] }))}
    profile="pill-cell"
    creatable
    openOnMount
    onDirectSave={(value) => {
      props.onChange(value)
      props.onCommit(value)
    }}
    onBlur={() => undefined}
    onDismiss={props.onCancel}
    onOptionColorChange={props.onOptionColorChange}
  />
)

const DateEditWidget: JsonViewEditWidget = (props) => (
  <DateValueEditor
    descriptor={props.descriptor as unknown as import('@script-it/json-views-core').DateTypeDescriptor}
    disabled={props.disabled}
    error={props.error}
    label={props.label}
    value={props.value}
    onCancel={props.onCancel}
    onClear={props.onClear}
    onCommit={props.onCommit}
  />
)

const DateDisplayWidget: JsonViewDisplayWidget = ({ compact, value }) => (
  <DateValueDisplay compact={compact} value={value} />
)

const LinkedTextEditWidget: JsonViewEditWidget = (props) => (
  <input
    autoFocus
    aria-label={`Edit ${props.label}`}
    aria-invalid={Boolean(props.error) || undefined}
    type={props.descriptor.type === 'email' ? 'email' : 'url'}
    value={props.stringValue}
    disabled={props.disabled}
    className="h-7 w-full min-w-0 rounded-sm border border-transparent bg-transparent px-1 py-0 text-xs text-foreground outline-none hover:bg-accent/40 focus:ring-1 focus:ring-inset focus:ring-ring disabled:opacity-60"
    onChange={(event) => props.onChange(event.target.value)}
    onBlur={() => props.onCommit()}
  />
)

const MarkdownEditWidget: JsonViewEditWidget = (props) => (
  <TextareaWidget
    {...common(props)}
    autoSize
    metadata={{ type: 'string' }}
    uiHint={{ type: 'text', multiline: true, placeholder: typeof props.descriptor.placeholder === 'string' ? props.descriptor.placeholder : undefined }}
  />
)

export class JsonViewWidgetRegistry {
  private readonly widgets = new Map<string, JsonViewWidgetDefinition>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  get version(): number { return this.revision }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    this.revision += 1
    this.listeners.forEach((listener) => listener())
  }

  constructor(widgets: readonly [string, JsonViewWidgetRegistration][] = []) {
    widgets.forEach(([type, widget]) => this.register(type, widget))
  }

  register(type: string, widget: JsonViewWidgetRegistration): this {
    if (!type.trim()) throw new TypeError('A widget type must have a name')
    // memo/forwardRef components are React component objects at runtime.
    const registration = typeof widget === 'object' && widget !== null && 'editor' in widget
      ? widget : { editor: widget as JsonViewEditWidget }
    // Replacing only the editor keeps the type's display and Enter behavior.
    const previous = this.widgets.get(type)
    this.widgets.set(type, Object.freeze({ display: previous?.display, enterKey: previous?.enterKey, ...registration }))
    this.changed()
    return this
  }

  unregister(type: string): this {
    if (this.widgets.delete(type)) this.changed()
    return this
  }

  get(type: string): JsonViewEditWidget | undefined {
    return this.widgets.get(type)?.editor
  }

  getDefinition(type: string): JsonViewWidgetDefinition | undefined {
    return this.widgets.get(type)
  }

  getDisplay(type: string): JsonViewDisplayWidget | undefined {
    return this.widgets.get(type)?.display
  }

  clone(): JsonViewWidgetRegistry {
    return new JsonViewWidgetRegistry([...this.widgets.entries()])
  }
}

export function createDefaultWidgetRegistry(): JsonViewWidgetRegistry {
  return new JsonViewWidgetRegistry([
    ['text', TextEditWidget],
    ['number', NumberEditWidget],
    ['checkbox', { editor: CheckboxEditWidget, quickEdit: (value) => value !== true }],
    ['select', SelectEditWidget],
    ['multi-select', MultiSelectEditWidget],
    ['date', { editor: DateEditWidget, display: DateDisplayWidget }],
    ['url', LinkedTextEditWidget],
    ['email', LinkedTextEditWidget],
    ['markdown', { editor: MarkdownEditWidget, enterKey: 'newline' }],
    ['html', { editor: MarkdownEditWidget, enterKey: 'newline' }],
    ['body', { editor: MarkdownEditWidget, enterKey: 'newline' }],
  ])
}

export interface JsonViewsRegistryValue {
  types: JsonViewTypeRegistry
  widgets: JsonViewWidgetRegistry
}

const defaultRegistries: JsonViewsRegistryValue = {
  types: createDefaultTypeRegistry(),
  widgets: createDefaultWidgetRegistry(),
}

const JsonViewsRegistryContext = createContext(defaultRegistries)

export function JsonViewsProvider({
  children,
  types,
  widgets,
}: {
  children: ReactNode
  types?: JsonViewTypeRegistry
  widgets?: JsonViewWidgetRegistry
}) {
  const [defaults] = useState(() => ({ types: createDefaultTypeRegistry(), widgets: createDefaultWidgetRegistry() }))
  return (
    <JsonViewsRegistryContext.Provider value={{ types: types ?? defaults.types, widgets: widgets ?? defaults.widgets }}>
      {children}
    </JsonViewsRegistryContext.Provider>
  )
}

export function useJsonViewsRegistries(): JsonViewsRegistryValue {
  const registries = useContext(JsonViewsRegistryContext)
  useSyncExternalStore(registries.types.subscribe, () => registries.types.version, () => registries.types.version)
  useSyncExternalStore(registries.widgets.subscribe, () => registries.widgets.version, () => registries.widgets.version)
  return registries
}
