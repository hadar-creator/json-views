import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'

import {
  convertDateTimeToOffset,
  formatFixedOffset,
  localOffsetForDate,
  parseDateValue,
  serializeDateEditorValue,
  validateDateValue,
  type DateTypeDescriptor,
} from '@script-it/json-views-core'
import { cn } from '../lib/cn.js'
import { submitsOnEnter } from '../lib/enter-key.js'
import { MenuSelect } from '../primitives/menu-select.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu.js'

interface DateValueDisplayProps {
  compact?: boolean
  value: unknown
}

interface DateValueEditorProps {
  descriptor: DateTypeDescriptor
  disabled: boolean
  error?: string
  label: string
  value: unknown
  onCancel: () => void
  onClear?: () => void
  onCommit: (value?: unknown) => void
}

interface CalendarDay {
  date: string
  day: number
  inMonth: boolean
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

function calendarDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

function localToday(): string {
  const today = new Date()
  return calendarDate(today.getFullYear(), today.getMonth() + 1, today.getDate())
}

function calendarDays(year: number, month: number): CalendarDay[] {
  const first = new Date(Date.UTC(year, month - 1, 1))
  const mondayOffset = (first.getUTCDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(Date.UTC(year, month - 1, index - mondayOffset + 1))
    return {
      date: calendarDate(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate()),
      day: current.getUTCDate(),
      inMonth: current.getUTCMonth() === month - 1,
    }
  })
}

function dateParts(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function shiftDate(value: string, days: number): string {
  const parts = dateParts(value)
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return calendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

function shiftMonth(value: string, months: number): string {
  const parts = dateParts(value)
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1))
  return calendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1)
}

function offsetLabel(timezone: string, padded = false): string {
  if (timezone === 'Z') return 'UTC'
  if (!padded) {
    const match = /^([+-])0?(\d{1,2}):(\d{2})$/.exec(timezone)
    if (match) return `GMT${match[1]}${Number(match[2])}${match[3] === '00' ? '' : `:${match[3]}`}`
  }
  return `GMT${timezone}`
}

function wallClockDate(parsed: ReturnType<typeof parseDateValue>): Date | undefined {
  if (parsed.year === undefined || parsed.month === undefined || parsed.day === undefined) return undefined
  return new Date(Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hour ?? 12,
    parsed.minute ?? 0,
    parsed.second ?? 0,
  ))
}

export function DateValueDisplay({ compact = false, value }: DateValueDisplayProps) {
  const parsed = parseDateValue(value)
  if (parsed.kind === 'empty') return <span className="italic text-muted-foreground">—</span>
  if (parsed.kind === 'invalid') return <span className="break-words">{String(value)}</span>
  const wall = wallClockDate(parsed)
  if (!wall) return <span>{String(value)}</span>
  const date = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(compact && parsed.year === new Date().getFullYear() ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(wall)
  if (parsed.kind === 'date') return <span title={String(value)}>{date}</span>
  const time = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(wall)
  const timezone = parsed.kind === 'datetime' ? ` ${offsetLabel(parsed.timezone ?? 'Z')}` : ''
  return <span title={String(value)}>{date} · {time}{timezone}</span>
}

function timezoneChoices(original: string | undefined, local: string): Array<{ value: string; label: string }> {
  const choices = new Map<string, string>()
  if (original) choices.set(original, `Original · ${offsetLabel(original, true)}`)
  if (!choices.has(local)) choices.set(local, `Local · ${offsetLabel(local, true)}`)
  choices.set('Z', 'UTC')
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const value = formatFixedOffset(offset)
    if (!choices.has(value)) choices.set(value, offsetLabel(value, true))
  }
  return [...choices].map(([value, label]) => ({ value, label }))
}

export function DateValueEditor({
  descriptor,
  disabled,
  error,
  label,
  value,
  onCancel,
  onClear,
  onCommit,
}: DateValueEditorProps) {
  const editorId = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const parsed = useMemo(() => parseDateValue(value), [value])
  const today = useMemo(localToday, [])
  const initialDate = parsed.calendarDate ?? ''
  const initialMonth = dateParts(initialDate || today)
  const [open, setOpen] = useState(true)
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [focusDate, setFocusDate] = useState(initialDate || today)
  const [month, setMonth] = useState({ year: initialMonth.year, month: initialMonth.month })
  const existingHasTime = parsed.kind === 'datetime' || parsed.kind === 'floating-datetime'
  const [includeTime, setIncludeTime] = useState(existingHasTime || (parsed.kind === 'empty' && descriptor.defaultIncludeTime === true))
  const [time, setTime] = useState(existingHasTime ? `${pad(parsed.hour ?? 0)}:${pad(parsed.minute ?? 0)}` : '')
  const [seconds, setSeconds] = useState(existingHasTime ? parsed.second ?? 0 : 0)
  const [fractionalSeconds, setFractionalSeconds] = useState(existingHasTime ? parsed.fractionalSeconds ?? '' : '')
  const defaultTimezone = localOffsetForDate(initialDate || today, time || '12:00')
  const [timezone, setTimezone] = useState(parsed.kind === 'datetime' ? parsed.timezone ?? defaultTimezone : '')
  const [attemptedSave, setAttemptedSave] = useState(false)
  const completed = useRef(false)
  const days = useMemo(() => calendarDays(month.year, month.month), [month])
  const localTimezone = localOffsetForDate(selectedDate || today, time || '12:00')
  const timezoneOptions = useMemo(() => timezoneChoices(parsed.kind === 'datetime' ? parsed.timezone : undefined, localTimezone), [localTimezone, parsed.kind, parsed.timezone])
  const serialized = useMemo(() => {
    if (!selectedDate) return { value: undefined, error: 'Select a date' }
    try {
      const next = serializeDateEditorValue({
        date: selectedDate,
        includeTime,
        time,
        seconds,
        fractionalSeconds,
        timezone,
      })
      return { value: next, error: validateDateValue(next, descriptor) }
    } catch (serializeError) {
      return { value: undefined, error: serializeError instanceof Error ? serializeError.message : 'Enter a valid date' }
    }
  }, [descriptor, fractionalSeconds, includeTime, seconds, selectedDate, time, timezone])
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(month.year, month.month - 1, 1)))
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => (
    new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2024, 0, index + 1)))
  )), [])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => {
      popoverRef.current?.querySelector<HTMLElement>(`[data-date="${focusDate}"]`)?.focus()
    })
    return () => window.clearTimeout(timer)
  }, [focusDate, open])

  const cancel = () => {
    completed.current = true
    setOpen(false)
    onCancel()
  }
  const save = () => {
    setAttemptedSave(true)
    if (!serialized.value || serialized.error || disabled) return
    completed.current = true
    onCommit(serialized.value)
  }
  const clear = () => {
    if (descriptor.required || disabled) return
    completed.current = true
    if (onClear) onClear()
    else onCommit(null)
  }
  const chooseDate = (date: string) => {
    const parts = dateParts(date)
    setSelectedDate(date)
    setFocusDate(date)
    setMonth({ year: parts.year, month: parts.month })
  }
  const moveFocus = (next: string) => {
    const parts = dateParts(next)
    setFocusDate(next)
    setMonth({ year: parts.year, month: parts.month })
  }
  const onCalendarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-date]') : null
    const current = target?.dataset.date
    if (!current) return
    const weekday = (new Date(`${current}T00:00:00Z`).getUTCDay() + 6) % 7
    let next: string | undefined
    if (event.key === 'ArrowLeft') next = shiftDate(current, -1)
    else if (event.key === 'ArrowRight') next = shiftDate(current, 1)
    else if (event.key === 'ArrowUp') next = shiftDate(current, -7)
    else if (event.key === 'ArrowDown') next = shiftDate(current, 7)
    else if (event.key === 'Home') next = shiftDate(current, -weekday)
    else if (event.key === 'End') next = shiftDate(current, 6 - weekday)
    else if (event.key === 'PageUp') next = shiftMonth(current, -1)
    else if (event.key === 'PageDown') next = shiftMonth(current, 1)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    moveFocus(next)
  }
  const changeTimezone = (nextTimezone: string) => {
    if (includeTime && selectedDate && time && timezone && nextTimezone) {
      try {
        const current = serializeDateEditorValue({ date: selectedDate, includeTime: true, time, seconds, fractionalSeconds, timezone })
        const converted = parseDateValue(convertDateTimeToOffset(current, nextTimezone))
        if (converted.kind === 'datetime') {
          setSelectedDate(converted.calendarDate ?? selectedDate)
          setTime(`${pad(converted.hour ?? 0)}:${pad(converted.minute ?? 0)}`)
          setSeconds(converted.second ?? 0)
          setFractionalSeconds(converted.fractionalSeconds ?? '')
          if (converted.year && converted.month) setMonth({ year: converted.year, month: converted.month })
        }
      } catch {
        // An incomplete draft has no instant yet; choosing a timezone simply
        // establishes the offset that will be used when it becomes complete.
      }
    }
    setTimezone(nextTimezone)
  }
  const visibleError = error ?? (attemptedSave || (selectedDate && serialized.error?.startsWith('Date must')) ? serialized.error : undefined)

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen && !completed.current) onCancel()
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-id="date-editor-trigger"
          aria-label={`Edit ${label}`}
          className="flex min-h-7 w-full items-center rounded-sm px-1 text-left text-xs outline-none ring-1 ring-inset ring-ring"
        >
          {selectedDate || descriptor.placeholder || 'Select a date'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={popoverRef}
        data-id="date-editor-popover"
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-[min(21rem,calc(100vw-1.5rem))] p-3 text-foreground"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancel()
            return
          }
          // Enter in a field (the time, the Include time checkbox) saves the
          // draft; a day or other button keeps its own Enter action.
          if (event.target instanceof HTMLButtonElement) return
          if (submitsOnEnter(event, { multiline: false, enterKey: 'submit' })) {
            event.preventDefault()
            event.stopPropagation()
            save()
          }
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <strong className="text-sm font-medium">{monthLabel}</strong>
          <div className="flex gap-1">
            <button type="button" aria-label="Previous month" className="grid h-8 w-8 place-items-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
              const next = shiftMonth(calendarDate(month.year, month.month, 1), -1)
              const parts = dateParts(next)
              setMonth({ year: parts.year, month: parts.month })
              setFocusDate(next)
            }}><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" aria-label="Next month" className="grid h-8 w-8 place-items-center rounded-md hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => {
              const next = shiftMonth(calendarDate(month.year, month.month, 1), 1)
              const parts = dateParts(next)
              setMonth({ year: parts.year, month: parts.month })
              setFocusDate(next)
            }}><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>

        <div role="grid" aria-label={`${monthLabel} calendar`} className="mt-2 grid grid-cols-7 gap-0.5" onKeyDown={onCalendarKeyDown}>
          <div role="row" className="contents">
            {weekdays.map((weekday) => <div key={weekday} role="columnheader" className="py-1 text-center text-[0.6875rem] font-medium text-muted-foreground">{weekday}</div>)}
          </div>
          {Array.from({ length: 6 }, (_, row) => (
            <div key={row} role="row" className="contents">
              {days.slice(row * 7, row * 7 + 7).map((item) => {
                const selected = item.date === selectedDate
                const current = item.date === today
                const readable = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeZone: 'UTC' })
                  .format(new Date(`${item.date}T00:00:00Z`))
                return (
                  <div key={item.date} role="gridcell" aria-selected={selected} className="grid place-items-center">
                    <button
                      type="button"
                      data-date={item.date}
                      aria-label={`Choose ${readable}`}
                      aria-current={current ? 'date' : undefined}
                      tabIndex={item.date === focusDate ? 0 : -1}
                      className={cn(
                        'grid h-8 w-8 place-items-center rounded-md text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        item.inMonth ? 'text-foreground' : 'text-muted-foreground/55',
                        selected ? 'bg-primary font-semibold text-primary-foreground' : 'hover:bg-accent',
                        current && !selected && 'ring-1 ring-inset ring-ring',
                      )}
                      onClick={() => chooseDate(item.date)}
                    >{item.day}</button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <label className="flex min-h-8 items-center gap-2 text-xs font-medium">
            <input
              type="checkbox"
              aria-label="Include time"
              checked={includeTime}
              disabled={disabled}
              className="h-4 w-4 accent-primary"
              onChange={(event) => setIncludeTime(event.target.checked)}
            />
            Include time
          </label>
          {includeTime && (
            <div className="mt-2 grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 text-xs">
              <label htmlFor={`${editorId}-time`} className="text-muted-foreground">Time</label>
              <input
                id={`${editorId}-time`}
                type="time"
                aria-label="Time"
                value={time}
                disabled={disabled}
                className="h-8 rounded-md border border-border bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onInput={(event) => {
                  setTime(event.currentTarget.value)
                  setSeconds(0)
                  setFractionalSeconds('')
                }}
              />
              <span className="text-muted-foreground">Timezone</span>
              <MenuSelect
                ariaLabel="Timezone"
                disabled={disabled}
                className="min-w-0"
                emptyOptionLabel="No timezone · floating time"
                options={timezoneOptions}
                value={timezone}
                onChange={changeTimezone}
              />
            </div>
          )}
          {!includeTime && existingHasTime && (
            <p className="mt-2 flex items-start gap-1.5 text-[0.6875rem] text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Saving will remove the stored time.
            </p>
          )}
          {visibleError && <p role="alert" className="mt-2 text-[0.6875rem] text-destructive">{visibleError}</p>}
        </div>

        <footer className="mt-3 flex items-center gap-1 border-t border-border pt-2">
          <button type="button" data-id="date-editor-clear" disabled={descriptor.required || disabled} className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={clear}>Clear</button>
          <span className="flex-1" />
          <button type="button" data-id="date-editor-cancel" className="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={cancel}>Cancel</button>
          <button type="button" data-id="date-editor-save" disabled={disabled || !serialized.value || Boolean(serialized.error)} className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40" onClick={save}>Save</button>
        </footer>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type { DateValueDisplayProps, DateValueEditorProps }
