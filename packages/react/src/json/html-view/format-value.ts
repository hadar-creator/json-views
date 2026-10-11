/** Explicit, text-only presentation. Never evaluates template expressions. */
export function formatHtmlValue(value: unknown, attrs: Record<string, string>, resolve: (binding: string) => unknown): string | undefined {
  if (attrs.labels) {
    const labels: unknown = JSON.parse(attrs.labels)
    if (!labels || typeof labels !== 'object' || Array.isArray(labels) || Object.values(labels).some(label => typeof label !== 'string')) throw new Error('labels must be a JSON object of string labels')
    if (Object.hasOwn(labels, String(value))) return (labels as Record<string, string>)[String(value)]
  }
  if (!attrs.format) return undefined
  if (value == null) return '—'
  if (attrs.format === 'currency-minor') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('currency-minor requires a safe integer')
    const formatter = currencyFormatter(attrs, resolve)
    return formatter.format(value / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2))
  }
  if (['date', 'time', 'datetime'].includes(attrs.format)) {
    const unit = attrs['date-unit'] ?? 'iso'
    let date: Date
    if (unit === 'seconds' || unit === 'milliseconds') {
      if (!(typeof value === 'number' || typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) throw new Error('Timestamp must be numeric')
      date = new Date(Number(value) * (unit === 'seconds' ? 1000 : 1))
    } else if (unit === 'iso' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) date = new Date(value)
    else throw new Error('Dates require an ISO value or an explicit timestamp unit')
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid date')
    return new Intl.DateTimeFormat('en-US', {
      timeZone: attrs['time-zone'] ?? 'UTC',
      ...(attrs.format !== 'time' ? { month: 'short', day: 'numeric', ...(attrs.format === 'date' ? { year: 'numeric' } : {}) } as const : {}),
      ...(attrs.format !== 'date' ? { hour: 'numeric', minute: '2-digit' } as const : {}),
    }).format(date)
  }
  if (attrs.format === 'base64url') {
    if (typeof value !== 'string' || !/^[\w-]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1) throw new Error('Invalid base64url text')
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  throw new Error(`Unsupported value format: ${attrs.format}`)
}

function currencyFormatter(attrs: Record<string, string>, resolve: (binding: string) => unknown): Intl.NumberFormat {
  const currency = attrs['currency-bind'] ? resolve(attrs['currency-bind']) : attrs.currency
  if (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) throw new Error('currency-minor requires a currency code')
  return new Intl.NumberFormat('en-US', { style: 'currency', currency })
}

function minorUnitFactor(attrs: Record<string, string>, resolve: (binding: string) => unknown): number {
  return 10 ** (currencyFormatter(attrs, resolve).resolvedOptions().maximumFractionDigits ?? 2)
}

/** The editor shows human units; the source retains its API encoding. */
export function htmlValueForEditing(value: unknown, attrs: Record<string, string>, resolve: (binding: string) => unknown = () => undefined): unknown {
  if (attrs.format === 'base64url') return formatHtmlValue(value, attrs, resolve)
  if (attrs.format === 'currency-minor' && typeof value === 'number') return value / minorUnitFactor(attrs, resolve)
  return value
}

export function htmlValueFromEditing(value: unknown, attrs: Record<string, string>, resolve: (binding: string) => unknown = () => undefined): unknown {
  if (attrs.format === 'base64url') {
    if (typeof value !== 'string') throw new Error('Enter text')
    const bytes = new TextEncoder().encode(value)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  if (attrs.format === 'currency-minor') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Enter a finite amount')
    const scaled = value * minorUnitFactor(attrs, resolve), rounded = Math.round(scaled)
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-7) throw new Error('Amount has unsupported precision')
    return rounded
  }
  return value
}
