import { describe, expect, it } from 'vitest'
import { formatHtmlValue, htmlValueForEditing, htmlValueFromEditing } from './format-value.js'

const format = (value: unknown, attrs: Record<string, string>) => formatHtmlValue(value, attrs, () => 'usd')

describe('HTML value presentation', () => {
  it('formats native minor units according to the currency without changing data', () => {
    expect(format(24900, { format: 'currency-minor', 'currency-bind': 'payment.currency' })).toBe('$249.00')
    expect(format(24900, { format: 'currency-minor', currency: 'JPY' })).toBe('¥24,900')
    expect(format(24900, { format: 'currency-minor', currency: 'BHD' })).toContain('24.900')
    expect(() => format(2.5, { format: 'currency-minor', currency: 'USD' })).toThrow('safe integer')
    expect(() => format(Number.MAX_SAFE_INTEGER + 1, { format: 'currency-minor', currency: 'USD' })).toThrow('safe integer')
  })

  it('handles fractional Slack timestamps, Gmail milliseconds and date-only properties', () => {
    const attrs = { format: 'datetime', 'time-zone': 'Asia/Jerusalem' }
    expect(format('1789638120.000100', { ...attrs, 'date-unit': 'seconds' })).toBe('Sep 17, 12:42 PM')
    expect(format('1789630920000', { ...attrs, 'date-unit': 'milliseconds' })).toBe('Sep 17, 10:42 AM')
    expect(format('2026-09-22', { format: 'date' })).toBe('Sep 22, 2026')
    expect(() => format('', { format: 'time', 'date-unit': 'seconds' })).toThrow('numeric')
    expect(() => format('not a date', { format: 'date' })).toThrow('ISO')
  })

  it('round-trips edits to currency units and encoded Unicode bodies', () => {
    const attrs = { format: 'currency-minor', currency: 'usd' }
    expect(htmlValueForEditing(24900, attrs)).toBe(249)
    expect(htmlValueFromEditing(19.99, attrs)).toBe(1999)
    expect(() => htmlValueFromEditing(19.999, attrs)).toThrow('precision')
    const body = 'Hi Maya 👋\nתודה'
    const encoded = htmlValueFromEditing(body, { format: 'base64url' })
    expect(htmlValueForEditing(encoded, { format: 'base64url' })).toBe(body)
  })

  it('uses explicit labels, falling back to the original value for unknown IDs', () => {
    const attrs = { labels: '{"U01":"Maya Chen","thumbsup":"👍"}' }
    expect(format('U01', attrs)).toBe('Maya Chen')
    expect(format('thumbsup', attrs)).toBe('👍')
    expect(format('missing', attrs)).toBeUndefined()
    expect(format('toString', attrs)).toBeUndefined()
    expect(() => format('U01', { labels: '{"U01":{}}' })).toThrow('string labels')
  })

  it('uses bound currency consistently for display and edits, ahead of a literal currency', () => {
    const attrs = { format: 'currency-minor', 'currency-bind': 'payment.currency' }
    const usd = (binding: string) => binding === 'payment.currency' ? 'USD' : undefined
    expect(formatHtmlValue(24900, attrs, usd)).toBe('$249.00')
    expect(htmlValueForEditing(24900, attrs, usd)).toBe(249)
    expect(htmlValueFromEditing(19.99, attrs, usd)).toBe(1999)
    const conflicting = { ...attrs, currency: 'JPY' }
    expect(formatHtmlValue(24900, conflicting, usd)).toBe('$249.00')
    expect(htmlValueForEditing(24900, conflicting, usd)).toBe(249)
    expect(htmlValueFromEditing(19.99, conflicting, usd)).toBe(1999)
    expect(htmlValueForEditing(24900, { ...attrs, currency: 'USD' }, () => 'JPY')).toBe(24900)
    expect(htmlValueFromEditing(1999, { ...attrs, currency: 'USD' }, () => 'JPY')).toBe(1999)
    expect(() => htmlValueForEditing(24900, conflicting, () => undefined)).toThrow('currency code')
    expect(() => htmlValueFromEditing(19.99, conflicting, () => undefined)).toThrow('currency code')
  })

  it('decodes UTF-8 base64url as text, never HTML', () => {
    const text = 'Hello 👋\n<script>alert(1)</script>'
    expect(format(Buffer.from(text).toString('base64url'), { format: 'base64url' })).toBe(text)
    expect(() => format('?', { format: 'base64url' })).toThrow('Invalid base64url')
    expect(() => format('_w', { format: 'base64url' })).toThrow()
    expect(format(null, { format: 'date' })).toBe('—')
    expect(format(24900, {})).toBeUndefined()
    expect(() => format(1, { format: 'eval' })).toThrow('Unsupported')
  })
})
