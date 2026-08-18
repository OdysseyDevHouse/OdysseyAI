'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import * as Icons from './icons'

/**
 * The till's number pad — one component for every "type an amount" moment:
 * quantity, price override, discount, tender, cash-out, covers.
 *
 * The value is held as a DECIMAL STRING typed left to right, never as a number.
 * That is the whole trick, and doing it the obvious way breaks in two visible
 * ways: with a number, typing "5." shows "5" (the point vanishes until a digit
 * follows it, so the pad looks broken), and "0.50" loses its trailing zero
 * mid-entry. Parsing happens once, when the value is read.
 *
 * A physical keyboard works too — a till with a keyboard is just as common as
 * one without, and a cashier who can touch-type figures is faster than any pad.
 */
export function NumPad({
  value,
  onChange,
  maxDecimals = 2,
  maxLength = 9,
  disabled = false,
  size = 'default',
}: {
  /** The decimal string being typed, e.g. "12.5" or "" — not a number. */
  value: string
  onChange: (next: string) => void
  /**
   * `default` is the pad inside a modal, where it shares the dialog with a
   * heading, a total and a confirm button and must not crowd them.
   *
   * `lg` is for a pad that IS the screen — the open-till gate. There the keys
   * are the only thing to hit, so they take the full width they are given and
   * grow to a comfortable thumb target rather than sitting as a small block in
   * the middle of an empty card. Opt in; it would burst a modal.
   */
  size?: 'default' | 'lg'
  /**
   * 0 for a whole-number pad (quantity of a non-fractional product, covers).
   * The decimal key is then rendered as a gap rather than removed, so the 0 and
   * backspace keys stay where the cashier's thumb already expects them.
   */
  maxDecimals?: number
  maxLength?: number
  disabled?: boolean
}) {
  // Held in a ref so the keyboard listener below can read the latest value
  // without listing it as a dependency and rebinding on every keystroke.
  const valueRef = useRef(value)
  valueRef.current = value

  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  const press = useCallback(
    (key: string) => {
      const current = valueRef.current

      if (key === 'back') {
        onChangeRef.current(current.slice(0, -1))
        return
      }

      if (key === '.') {
        // One point only, and never as the first character — ".5" is a value a
        // cashier can type but not one a slip should ever show.
        if (maxDecimals === 0 || current.includes('.') || current === '') return
        onChangeRef.current(`${current}.`)
        return
      }

      if (current.length >= maxLength) return

      // A leading zero is replaced rather than appended: "0" then "5" means 5,
      // not 05. But "0." is a real prefix and must survive.
      const base = current === '0' ? '' : current

      const [, decimals] = base.split('.')
      if (decimals !== undefined && decimals.length >= maxDecimals) return

      onChangeRef.current(base + key)
    },
    [maxDecimals, maxLength],
  )

  useEffect(() => {
    if (disabled) return
    function onKey(event: KeyboardEvent) {
      if (event.key >= '0' && event.key <= '9') press(event.key)
      else if (event.key === '.' || event.key === ',') press('.')
      else if (event.key === 'Backspace') press('back')
      else return
      // Only for keys we handled — Enter and Escape belong to the dialog around
      // us, and swallowing them here would break its confirm and cancel.
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press, disabled])

  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

  const lg = size === 'lg'
  /* The SIZE prop, not a className. Button concatenates its own size classes
     with whatever className it is handed and does not resolve the conflict, so
     an `h-auto text-3xl` passed in loses to `h-touch text-base` on source order
     alone — the keys stayed 56px and 14px while every class looked right in the
     DOM. `keypad` puts the same declarations where they can win. */
  const keySize = lg ? 'keypad' : 'touch'
  const keyClass = lg ? '' : 'text-xl font-bold'

  return (
    <div className={`grid grid-cols-3 ${lg ? 'gap-3' : 'gap-2'}`}>
      {KEYS.map((key) => (
        <Button
          key={key}
          variant="ghost"
          size={keySize}
          disabled={disabled}
          onClick={() => press(key)}
          className={keyClass}
        >
          {key}
        </Button>
      ))}

      {maxDecimals > 0 ? (
        <Button
          variant="ghost"
          size={keySize}
          disabled={disabled}
          onClick={() => press('.')}
          className={keyClass}
          aria-label="Decimal point"
        >
          .
        </Button>
      ) : (
        /* A gap, not a missing key: removing it would slide 0 and backspace one
           position left, so a whole-number pad and a decimal one would have
           their most-used keys in different places. */
        <span aria-hidden />
      )}

      <Button
        variant="ghost"
        size={keySize}
        disabled={disabled}
        onClick={() => press('0')}
        className={keyClass}
      >
        0
      </Button>

      <Button
        variant="ghost"
        size={keySize}
        disabled={disabled || value === ''}
        onClick={() => press('back')}
        aria-label="Backspace"
        className={keyClass}
      >
        {/* The key a cashier already knows. A ChevronLeft — which this used to
            be — reads as "go back a screen" on a touch till, which is the one
            thing this key must not be mistaken for mid-entry. */}
        <Icons.Backspace size={lg ? 30 : 22} />
      </Button>
    </div>
  )
}

/**
 * The figure being typed, above the pad.
 *
 * Its own component because every dialog that uses NumPad needs exactly this
 * and they must not each invent it: the label sits small and left, the figure
 * large and right, and the box holds its height when empty so the pad does not
 * jump the moment a digit is entered.
 */
export function NumPadDisplay({
  label,
  value,
  placeholder = '0',
  tone = 'default',
  layout = 'stacked',
}: {
  label?: string
  value: string
  placeholder?: string
  /** `danger` while the entry is refused — over a discount ceiling, say. */
  tone?: 'default' | 'danger'
  /**
   * `stacked` puts the label above the figure — the default, and right for a
   * pad in a modal where the label runs long ("Cash — amount handed over").
   *
   * `inline` sets the label and the figure on one line, and paints the figure
   * in brand. It reads as one statement — "Opening float … 0.00" — which suits
   * a pad that IS the screen rather than one control on it. Opt in; a long
   * label would crowd the figure on the same row.
   */
  layout?: 'stacked' | 'inline'
}) {
  const empty = value === ''
  const inline = layout === 'inline'
  const figure = `numeric font-extrabold ${inline ? 'text-3xl' : 'block text-right text-3xl'} ${
    tone === 'danger'
      ? 'text-danger'
      : /* Brand, not faint, when inline: the figure is the subject of the
           screen, and greying the resting value made the one number the
           cashier is about to change look disabled. */
        inline
        ? 'text-brand'
        : empty
          ? 'text-faint'
          : 'text-ink'
  }`

  if (inline) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-4 py-3.5">
        {label && <span className="text-sm font-semibold text-ink">{label}</span>}
        <span className={figure}>{empty ? placeholder : value}</span>
      </div>
    )
  }

  return (
    <div className="rounded-control border border-border bg-canvas px-4 py-3">
      {label && <span className="block text-xs font-semibold text-muted">{label}</span>}
      <span className={figure}>{empty ? placeholder : value}</span>
    </div>
  )
}

/**
 * Parse what NumPad produced.
 *
 * "" and "5." are both mid-entry states rather than errors, and both mean the
 * number to their left — so a cashier who has typed "12." and taps Confirm gets
 * 12 rather than a validation message about a character they can see is missing.
 */
export function numPadValue(value: string): number {
  if (value === '') return 0
  // "12." -> "12". The trailing point is a state, not a digit.
  const trimmed = value.endsWith('.') ? value.slice(0, -1) : value
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : 0
}
