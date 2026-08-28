'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { usePadKeys } from './padKeys'
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
   *
   * `wide` is `lg`'s proportion at a dialog's scale: keys that still fill the
   * width they are given — so a dialog whose subject IS the amount does not
   * put a 256px block in the middle of it — but at a height a modal can carry
   * alongside a figure, a text field and a footer. The drawer-movement dialogs
   * are the case: at `lg` their body overran the modal's cap on a 1366×768
   * till and pushed the required Reason field below the fold.
   */
  size?: 'default' | 'wide' | 'lg'
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

  /* The anchor `usePadKeys` measures to decide whether this pad is on screen at
     all. A pad inside a closed <dialog> is still mounted — see padKeys.ts. */
  const rootRef = useRef<HTMLDivElement>(null)

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key >= '0' && event.key <= '9') press(event.key)
      else if (event.key === '.' || event.key === ',') press('.')
      else if (event.key === 'Backspace') press('back')
      else return
      // Only for keys we handled — Enter and Escape belong to the dialog around
      // us, and swallowing them here would break its confirm and cancel.
      event.preventDefault()
    },
    [press],
  )

  usePadKeys(rootRef, onKey, !disabled)

  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

  const lg = size === 'lg'
  const wide = size === 'wide'
  /* Only the GAP still varies with the size — the keys themselves no longer
     take an override, so there is nothing else to branch on here. */
  const fills = lg || wide
  /* The SIZE prop, and nothing through a className. Button concatenates its own
     size classes with whatever it is handed and does not resolve the conflict,
     so both land in the same Tailwind layer and source order decides: an
     `h-auto text-3xl` passed in lost to `h-touch text-base`, and the digits'
     `font-bold` lost to `font-medium` — the keys rendered at 56px/14px/500
     while every class sat right there in the DOM. Each of these sizes puts the
     height, the type, the weight and w-full where they can win.

     `pad` rather than `touch` for the default, so this pad's digits are the
     same weight and size as PinPad's — a cashier meets both on one till. */
  const keySize = lg ? 'keypad' : wide ? 'keypad-sm' : 'pad'

  /* variant="key", the same fill PinPad's digits wear — this pad was `ghost`,
     which rests on `surface` and so renders white-on-white inside the card or
     dialog around it. Two pads that a cashier meets minutes apart on the same
     till looked like two different controls. `key` is the one answer: a filled
     grey pad that reads as physical, with the brand arriving only on hover. */
  return (
    <div ref={rootRef} className={`grid grid-cols-3 ${fills ? 'gap-3' : 'gap-2'}`}>
      {KEYS.map((key) => (
        <Button
          key={key}
          variant="key"
          size={keySize}
          disabled={disabled}
          onClick={() => press(key)}
        >
          {key}
        </Button>
      ))}

      {maxDecimals > 0 ? (
        <Button
          variant="key"
          size={keySize}
          disabled={disabled}
          onClick={() => press('.')}
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
        variant="key"
        size={keySize}
        disabled={disabled}
        onClick={() => press('0')}
      >
        0
      </Button>

      <Button
        variant="key"
        size={keySize}
        disabled={disabled || value === ''}
        onClick={() => press('back')}
        aria-label="Backspace"
      >
        {/* The key a cashier already knows. A ChevronLeft — which this used to
            be — reads as "go back a screen" on a touch till, which is the one
            thing this key must not be mistaken for mid-entry. */}
        <Icons.Backspace size={lg ? 30 : wide ? 26 : 22} />
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
  suffix,
}: {
  label?: string
  value: string
  placeholder?: string
  /** `danger` while the entry is refused — over a discount ceiling, say. */
  tone?: 'default' | 'danger'
  /**
   * A unit set after the figure, smaller and quieter — "%" on a percentage pad.
   *
   * Part of the FIGURE rather than the label, because "Percent off the sale …
   * 20" and "… 20 %" are the same statement said twice, and the cashier reading
   * the number needs the unit next to the number. `plaque` only: the smaller
   * layouts have no room to set it without crowding the digits.
   */
  suffix?: string
  /**
   * `stacked` puts the label above the figure — the default, and right for a
   * pad in a modal where the label runs long ("Cash — amount handed over").
   *
   * `inline` sets the label and the figure on one line, and paints the figure
   * in brand. It reads as one statement — "Opening float … 0.00" — which suits
   * a pad that IS the screen rather than one control on it. Opt in; a long
   * label would crowd the figure on the same row.
   *
   * `plaque` is the till's own step: the label small along the top, the figure
   * large along the bottom right, at the biggest step of the three. For a
   * dialog whose ONLY subject is the number being typed — a payout, a pay-in, a
   * drop, a discount — where the figure and the pad under it are the whole
   * screen.
   *
   * All three sit on the SAME deep plaque — the dark block `DeepPanel` gives
   * the till's opening float. They differ in how the label and figure are
   * arranged and at what size, never in what they are drawn on: a cashier
   * meets several of these on one till, and three different grounds meant the
   * number they read moved and changed colour between dialogs.
   *
   * The label goes ABOVE rather than beside, unlike `inline`: these labels are
   * sentences ("Percent off the sale", "Cash — amount handed over") and on one
   * line a long one squeezes the figure it is describing. Above, the label can
   * run as long as it needs and the figure keeps its size.
   */
  layout?: 'stacked' | 'inline' | 'plaque'
}) {
  const empty = value === ''
  const plaque = layout === 'plaque'
  const inline = layout === 'inline'

  /* THE DEEP PLAQUE, at every layout — the same dark block the till's opening
     float wears, which is what `DeepPanel` was built for. It used to be three
     different grounds: a pale `canvas` box, a `surface-2` row and a brand-tinted
     field, so the figure a cashier reads changed colour depending on which
     dialog they happened to be in. One ground means the number is always in the
     same place and always the brightest thing in the box.

     `danger` keeps the plaque and reddens it, rather than swapping to the pale
     `danger-soft` it used to use: a refused entry should not also relocate the
     figure onto a different-coloured card. */
  const field =
    tone === 'danger'
      ? 'bg-gradient-to-br from-danger-deep to-danger-deep-2'
      : 'bg-gradient-to-br from-deep to-deep-2'

  /* WHITE, and white while empty too. The figure is the one thing on the
     plaque worth reading, and a resting "0" set in the muted step looked
     disabled — which is exactly wrong for the number a cashier is about to
     type over. `deep-ink` at every state; the placeholder is distinguished by
     being a placeholder, not by being dimmer than the plaque's own label. */
  const figure = `numeric font-extrabold leading-none text-deep-ink ${
    plaque ? 'text-4xl' : 'text-3xl'
  }`

  /* The label in white as well. `deep-muted` is the caption step — right for
     DeepPanel's optional `hint` under the label, too quiet for the label
     itself, which names the figure and has to be readable at a glance. */
  const labelTone = 'text-deep-ink'

  /* The suffix stays a step down: it qualifies the figure ("%") and must not
     compete with it. `deep-muted` on white digits is the same relationship
     DeepPanel gives its currency mark. */
  const suffixTone = 'text-deep-muted'

  /* NO margin here, deliberately. The gap to the pad belongs to whatever lays
     the two out: every dialog that uses this already wraps the pair in a flex
     column with a gap-2/3/4, and a margin-bottom on a flex item ADDS to the
     column's gap rather than being absorbed by it — measured, 16px gap plus a
     12px margin comes to 28px — so a floor set here would loosen every one of
     those screens to fix the one place that renders the two as bare siblings.
     That place is the caller to fix. */

  if (plaque) {
    return (
      <div className={`rounded-card px-5 py-4 ${field}`}>
        {label && (
          <span className={`block text-xs font-bold uppercase tracking-wider ${labelTone}`}>
            {label}
          </span>
        )}
        {/* `items-baseline`, so a suffix sits ON the figure's baseline rather
            than centred against a 36px line box and floating above it. */}
        <div className="mt-2 flex items-baseline justify-end gap-1.5">
          <span className={figure}>{empty ? placeholder : value}</span>
          {suffix && <span className={`text-xl font-semibold ${suffixTone}`}>{suffix}</span>}
        </div>
      </div>
    )
  }

  if (inline) {
    return (
      <div className={`flex items-center justify-between gap-4 rounded-card px-5 py-4 ${field}`}>
        {label && (
          <span className={`text-xs font-bold uppercase tracking-wider ${labelTone}`}>{label}</span>
        )}
        <span className={`${figure} shrink-0`}>{empty ? placeholder : value}</span>
      </div>
    )
  }

  /* `stacked` — the label along the top, the figure hard right under it. The
     same shape as `plaque` at a smaller step, rather than the different box it
     used to be: the two sit side by side on the till (a tender pad beside a
     line edit) and reading as two unrelated controls was the whole complaint. */
  return (
    <div className={`rounded-card px-5 py-4 ${field}`}>
      {label && (
        <span className={`block text-xs font-bold uppercase tracking-wider ${labelTone}`}>
          {label}
        </span>
      )}
      <span className={`mt-2 block text-right ${figure}`}>{empty ? placeholder : value}</span>
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
