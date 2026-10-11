import * as React from 'react'
import { Check, ChevronDown, Palette } from 'lucide-react'

import { cn } from '../lib/cn.js'
import { isComposing } from '../lib/enter-key.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './dropdown-menu.js'
import { OptionPill, optionColorsForValues } from './option-pill.js'

export interface ChoiceOption {
  value: string
  label: string
  color?: string
}

export type ChoiceControlMode = 'single' | 'multiple'
export type ChoiceControlProfile = 'plain' | 'pill' | 'pill-cell' | 'menu'

export interface ChoiceControlProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  mode: ChoiceControlMode
  value: string[]
  onValueChange: (next: string[]) => void
  options: ReadonlyArray<ChoiceOption>
  profile?: ChoiceControlProfile
  creatable?: boolean
  emptyOptionLabel?: string
  disabled?: boolean
  readOnly?: boolean
  invalid?: boolean
  openOnMount?: boolean
  /** Lets a menu live inside another dismissible surface without blocking
   * pointer events to that surface. Defaults to true for inline cell editors. */
  nonModal?: boolean
  /** Ends an edit when the menu is dismissed, independently of saving a choice. */
  onDismiss?: () => void
  onSelectionBlur?: () => void
  onOptionColorChange?: (optionValue: string, color: string) => void
}

const OPTION_COLORS = [
  ['gray', 'bg-muted'],
  ['blue', 'bg-muted'],
  ['green', 'bg-muted'],
  ['yellow', 'bg-muted'],
  ['orange', 'bg-muted'],
  ['red', 'bg-muted'],
  ['purple', 'bg-muted'],
  ['pink', 'bg-muted'],
] as const

function selectedOption(options: ReadonlyArray<ChoiceOption>, value: string): ChoiceOption {
  return options.find((option) => option.value === value) ?? { value, label: value }
}

export const ChoiceControl = React.forwardRef<HTMLDivElement, ChoiceControlProps>(
  ({
    mode,
    value,
    onValueChange,
    options,
    profile = 'plain',
    creatable = false,
    emptyOptionLabel,
    disabled = false,
    readOnly = false,
    invalid = false,
    openOnMount = false,
    nonModal = profile === 'pill-cell',
    onDismiss,
    onSelectionBlur,
    onOptionColorChange,
    className,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    ...props
  }, ref) => {
    const [open, setOpen] = React.useState(openOnMount)
    const [query, setQuery] = React.useState('')
    const [colorOption, setColorOption] = React.useState<string | null>(null)
    const inputRef = React.useRef<HTMLInputElement>(null)

    const knownOptions = React.useMemo(() => {
      const byValue = new Map(options.map((option) => [option.value, option]))
      value.forEach((selected) => {
        if (!byValue.has(selected)) byValue.set(selected, { value: selected, label: selected })
      })
      const entries = [...byValue.values()]
      const colors = optionColorsForValues(entries.map((option) => option.value), Object.fromEntries(entries.filter((option) => option.color).map((option) => [option.value, option.color!])))
      return entries.map((option) => ({ ...option, color: colors[option.value] }))
    }, [options, value])

    const normalizedQuery = query.trim().toLocaleLowerCase()
    const visibleOptions = knownOptions.filter((option) => (
      !normalizedQuery || option.label.toLocaleLowerCase().includes(normalizedQuery)
    ))
    const canCreate = Boolean(
      creatable
      && query.trim()
      && !knownOptions.some((option) => (
        option.value.toLocaleLowerCase() === normalizedQuery
        || option.label.toLocaleLowerCase() === normalizedQuery
      )),
    )

    const choose = (nextValue: string) => {
      if (disabled || readOnly) return
      if (mode === 'single') {
        onValueChange(nextValue ? [nextValue] : [])
        setOpen(false)
        onSelectionBlur?.()
        return
      }
      onValueChange(value.includes(nextValue)
        ? value.filter((selected) => selected !== nextValue)
        : [...value, nextValue])
    }

    const createOption = () => {
      const nextValue = query.trim()
      if (!nextValue || !canCreate) return
      setQuery('')
      choose(nextValue)
    }

    const handleQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter' && canCreate && !isComposing(event)) {
        event.preventDefault()
        createOption()
      }
      if (event.key !== 'Escape') event.stopPropagation()
    }

    const optionButtons = visibleOptions.map((option) => {
      const active = value.includes(option.value)
      const selectionButton = (
        <button
          type="button"
          data-id={mode === 'single' ? 'pill-select-option' : 'multi-select-option'}
          data-value={option.value}
          aria-pressed={active}
          disabled={disabled || readOnly}
          onClick={() => choose(option.value)}
          className={cn(
            profile === 'plain'
              ? 'rounded-md border px-3 py-1.5 text-sm transition-colors'
              : 'flex min-h-8 w-full min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
            profile === 'plain' && (
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-card text-foreground hover:bg-accent'
            ),
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {profile === 'plain'
            ? <span>{option.label}</span>
            : profile === 'menu'
              ? <span className="min-w-0 flex-1 truncate px-1.5 text-xs">{option.label}</span>
              : <OptionPill label={option.label} color={option.color} className="min-w-0 max-w-full" labelClassName="truncate" />}
          {profile !== 'plain' && active && (
            <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      )

      if (profile === 'plain' || !onOptionColorChange || readOnly) return React.cloneElement(selectionButton, { key: option.value })
      return (
        <div key={option.value} className="rounded-md">
          <div className="flex min-w-0 items-center gap-1">
            {selectionButton}
            <button
              type="button"
              aria-label={`Change color for ${option.label}`}
              aria-expanded={colorOption === option.value}
              disabled={disabled}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setColorOption((current) => current === option.value ? null : option.value)
              }}
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
          </div>
          {colorOption === option.value && (
            <div data-id="option-color-palette" className="flex items-center gap-1 px-1.5 pb-1.5 pt-0.5">
              {OPTION_COLORS.map(([color, swatchClass]) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`Set ${option.label} color to ${color}`}
                  data-option-color={color}
                  disabled={disabled}
                  className={cn('h-4 w-4 rounded-full border-2 border-card shadow-sm outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring', swatchClass, option.color === color && 'ring-2 ring-ring')}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onOptionColorChange(option.value, color)
                    setColorOption(null)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )
    })

    if (profile === 'plain') {
      return (
        <div
          ref={ref}
          role="group"
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid || undefined}
          className={cn('space-y-2', className)}
          {...props}
        >
          <div className="flex flex-wrap gap-2">{optionButtons}</div>
          {mode === 'multiple' && (
            <p className="text-xs text-muted-foreground">{value.length} selected</p>
          )}
        </div>
      )
    }

    const singleSelection = mode === 'single' && value[0]
      ? selectedOption(knownOptions, value[0])
      : undefined

    return (
      <div ref={ref} role="group" className={cn('relative min-w-0', className)} {...props}>
        <DropdownMenu
          modal={!nonModal}
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen)
            if (nextOpen) setQuery('')
            if (!nextOpen) {
              setColorOption(null)
              if (mode === 'multiple' && open) onSelectionBlur?.()
              if (open) onDismiss?.()
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-id={mode === 'single' ? 'pill-select' : 'multi-select-trigger'}
              aria-label={ariaLabel}
              aria-describedby={ariaDescribedBy}
              aria-invalid={invalid || undefined}
              disabled={disabled}
              className={cn(
                'flex w-full min-w-0 items-center gap-1 overflow-hidden text-left text-xs text-foreground outline-none focus:ring-2 focus:ring-inset focus:ring-ring/20 disabled:pointer-events-none disabled:opacity-50',
                profile === 'pill-cell'
                  ? 'min-h-7 rounded-sm px-1 hover:bg-accent/40'
                  : 'min-h-8 rounded-md border border-border bg-background px-2 py-1 hover:border-ring focus:border-ring',
                mode === 'single' && 'justify-between gap-2',
                invalid && 'border-destructive focus:border-destructive focus:ring-destructive/20',
              )}
            >
              {mode === 'single' ? (
                singleSelection
                  ? profile === 'menu'
                    ? <span className="min-w-0 flex-1 truncate px-0.5 text-xs">{singleSelection.label}</span>
                    : <OptionPill label={singleSelection.label} color={singleSelection.color} />
                  : <span className="text-muted-foreground">{emptyOptionLabel ?? 'None'}</span>
              ) : value.length > 0 ? (
                <span data-id="multi-select-preview" className="flex min-w-0 flex-nowrap gap-1 overflow-hidden">
                  {value.map((selected) => {
                    const option = selectedOption(knownOptions, selected)
                    return <OptionPill key={selected} label={option.label} color={option.color} />
                  })}
                </span>
              ) : (
                <span className={cn('text-muted-foreground', profile !== 'pill-cell' && 'px-0.5')}>None</span>
              )}
              {mode === 'single' && (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            data-id="input-widget-overlay"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(event) => {
              if (mode === 'single' && !creatable) return
              event.preventDefault()
              inputRef.current?.focus()
            }}
            className={cn(
              'text-foreground',
              mode === 'multiple'
                ? 'w-[min(36rem,calc(100vw-2rem))] p-0'
                : 'min-w-[var(--radix-dropdown-menu-trigger-width)] p-1',
            )}
          >
            {mode === 'single' ? (
              <>
                {creatable && !readOnly && (
                  <div className="border-b border-border p-1.5">
                    <input
                      ref={inputRef}
                      aria-label="Filter or add options"
                      value={query}
                      placeholder="Type to add an option…"
                      className="h-8 w-full rounded-md bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={handleQueryKeyDown}
                    />
                  </div>
                )}
                {emptyOptionLabel && (
                  <button
                    type="button"
                    data-id="pill-select-option"
                    aria-pressed={!singleSelection}
                    className="flex min-h-8 w-full items-center justify-between gap-3 rounded-md px-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={() => choose('')}
                  >
                    <span className="px-2 text-xs text-muted-foreground">{emptyOptionLabel}</span>
                    {!singleSelection && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
                  </button>
                )}
                {optionButtons}
                {canCreate && (
                  <button
                    type="button"
                    data-id="select-create"
                    className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                    onClick={createOption}
                  >
                    Add <OptionPill label={query.trim()} />
                  </button>
                )}
                {visibleOptions.length === 0 && !canCreate && (
                  <p className="px-2 py-3 text-xs text-muted-foreground">No matching options</p>
                )}
              </>
            ) : (
              <>
                <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border p-2.5">
                  {value.map((selected) => {
                    const option = selectedOption(knownOptions, selected)
                    return (
                      <OptionPill
                        key={selected}
                        label={option.label}
                        color={option.color}
                        onRemove={readOnly ? undefined : () => choose(selected)}
                      />
                    )
                  })}
                  {!readOnly && (
                    <input
                      ref={inputRef}
                      aria-label="Filter options"
                      value={query}
                      placeholder={value.length === 0 ? 'Add an option…' : ''}
                      className="h-6 min-w-24 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground"
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={handleQueryKeyDown}
                    />
                  )}
                </div>
                <div className="p-2">
                  <p className="px-1.5 pb-1.5 text-[0.6875rem] font-medium text-muted-foreground">
                    {readOnly ? 'Selected options' : creatable ? 'Select an option or create one' : 'Select an option'}
                  </p>
                  <div data-id="multi-select-options" className="max-h-64 space-y-0.5 overflow-y-auto">
                    {optionButtons}
                    {canCreate && (
                      <button
                        type="button"
                        data-id="multi-select-create"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                        onClick={createOption}
                      >
                        Create <OptionPill label={query.trim()} />
                      </button>
                    )}
                    {visibleOptions.length === 0 && !canCreate && (
                      <p className="px-2 py-3 text-xs text-muted-foreground">No matching options</p>
                    )}
                  </div>
                </div>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  },
)
ChoiceControl.displayName = 'ChoiceControl'
