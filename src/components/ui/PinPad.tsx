'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { usePadKeys } from './padKeys'
import * as Icons from './icons'

/**
 * A numeric keypad for entering a PIN.
 *
 * Big targets because the hardware is a touchscreen at counter height, often
 * used by someone holding something in their other hand. The physical keyboard
 * works too — a till with a keyboard is just as common — so digits, Backspace
 * and Enter are bound as well.
 *
 * The entered PIN is shown as dots inside an entry box, never digits: the
 * customer is standing on the other side of the screen. The box carries the
 * "Enter PIN" prompt while it is empty, so the pad says what it wants rather
 * than showing a row of dots that could be read as decoration.
 *
 * Bottom row is backspace / 0 / confirm — the confirm sits IN the grid, so a
 * thumb ends every entry in the same corner it has been working in.
 */
export function PinPad({
  length = 4,
  onSubmit,
  onCancel,
  error,
  busy = false,
  submitLabel = 'OK',
  wide = false,
  display = 'box',
  rejectedAt = 0,
}: {
  /** Digits before it submits itself. Six-digit PINs need an explicit Enter. */
  length?: number
  onSubmit: (pin: string) => void
  onCancel?: () => void
  error?: string | null
  busy?: boolean
  /**
   * The confirm key's caption.
   *
   * Short — it is one cell of a three-wide grid, not a full-width button. The
   * wide pad's cell is about 165px and holds roughly ten characters at the size
   * a finger aims at ("Open till" on the sign-in screen is the longest in use);
   * the narrow pad inside a dialog has far less and should keep "OK". Past that
   * the label would have to shrink below a touch size, and the verb belongs on
   * the screen around the pad instead.
   */
  submitLabel?: string
  /**
   * The sign-in lock screen's pad: wider, with taller keys.
   *
   * A till's PIN screen is the whole viewport with nothing else on it, and a
   * 320px pad marooned in the middle of a 1024px counter display looks like a
   * dialog somebody forgot to finish. The override popup inside a modal keeps
   * the narrow default.
   */
  wide?: boolean
  /**
   * How the entry so far is drawn.
   *
   * `box` is the default and what every pad inside a dialog wears: a bordered
   * field that carries an "Enter PIN" prompt while it is empty, because a pad
   * that appears mid-task has to say what it wants.
   *
   * `dots` is the till's own sign-in screen, where the words above the pad
   * already say it — a second prompt inside the box was the same sentence
   * twice. Bare dots also read as progress from across a counter, which a
   * bordered field does not.
   *
   * Both are exactly one `length` of dots and neither ever renders a digit:
   * the customer is standing on the other side of the screen.
   */
  display?: 'box' | 'dots'
  /**
   * Bump on every rejected attempt to shake the pad.
   *
   * A counter, not a boolean: the caller leaves `error` set between tries, so
   * two wrong PINs in a row carry the identical message and only a changing
   * value tells them apart — otherwise the second attempt would not shake.
   */
  rejectedAt?: number
}) {
  const [pin, setPin] = useState('')

  // Cleared on animationend so each rejection restarts the animation rather
  // than finding the class already applied and doing nothing.
  const [shake, setShake] = useState(false)
  useEffect(() => {
    if (rejectedAt > 0) setShake(true)
  }, [rejectedAt])

  // The caller re-renders while the PIN is being checked — `busy` flips, a
  // router.refresh() lands — and a plain arrow function passed as `onSubmit`
  // is a new identity each time. Held in a ref so the effects below can call
  // the latest one without listing it as a dependency and re-firing.
  const onSubmitRef = useRef(onSubmit)
  useEffect(() => {
    onSubmitRef.current = onSubmit
  })

  // Same reason as onSubmitRef: an inline arrow is a new identity every render,
  // and the key handler must not be rebound for it.
  const onCancelRef = useRef(onCancel)
  useEffect(() => {
    onCancelRef.current = onCancel
  })

  // The keyboard handler needs the current pin to decide whether Enter is
  // valid, but reading it from state would put `pin` in that effect's
  // dependencies and rebind the listener on every keystroke.
  const pinRef = useRef(pin)
  pinRef.current = pin

  // Submitting empties the pad. Without this the auto-submit effect below sees
  // four digits still sitting there the moment `busy` goes false again and
  // fires a second time — which on the clock screen means clocking straight
  // back out, then in, then out, for as long as the page is open.
  const send = useCallback((value: string) => {
    setPin('')
    onSubmitRef.current(value)
  }, [])

  // Clearing on a failed attempt is what makes a second try possible without
  // the user having to work out how much of the old entry survived.
  useEffect(() => {
    if (error) setPin('')
  }, [error])

  /* Anchors the listener to whether this pad is actually on screen — a pad in a
     closed <dialog> is still mounted, and was still eating keys. See padKeys.ts. */
  const rootRef = useRef<HTMLDivElement>(null)

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key >= '0' && event.key <= '9') {
        setPin((current) => (current.length >= 6 ? current : current + event.key))
      } else if (event.key === 'Backspace') {
        setPin((current) => current.slice(0, -1))
      } else if (event.key === 'Enter') {
        if (pinRef.current.length >= 4) send(pinRef.current)
      } else if (event.key === 'Escape') {
        /* LEFT UNCLAIMED, always. Escape is the dialog's to act on: `Modal`
           closes on the <dialog>'s native `cancel` event, which the browser
           only raises if this keydown is not defaulted. Claiming it here would
           make a pad in a Modal with no onCancel impossible to close. */
        onCancelRef.current?.()
        return
      } else {
        return
      }
      /* CLAIMED, so nothing below acts on the same key twice — the contract
         NumPad already keeps, and the one `usePadKeys` reads when it skips an
         already-handled key. Without it, a PIN typed while another pad is also
         on screen is entered in both places: a supervisor's digits land in the
         quantity or price field behind the dialog as well as in this one. */
      event.preventDefault()
    },
    [send],
  )

  usePadKeys(rootRef, onKey, !busy)

  // A four-digit PIN submits on the fourth digit; a six-digit one cannot, since
  // there is no way to tell "done" from "halfway" until Enter.
  useEffect(() => {
    if (length === 4 && pin.length === 4 && !busy) send(pin)
  }, [pin, length, busy, send])

  const press = (digit: string) =>
    setPin((current) => (current.length >= 6 ? current : current + digit))

  // Taller keys on the lock screen, which owns the whole viewport; the override
  // popup inside a modal keeps the standard till size.
  const keySize = wide ? 'touch-lg' : 'touch'

  return (
    <div
      ref={rootRef}
      className={`flex flex-col gap-3 ${wide ? 'w-[510px] max-w-[92vw]' : 'w-full max-w-xs'} ${
        shake ? 'pin-shake' : ''
      }`}
      /* animationend BUBBLES in React — a key's own tap animation would clear
         the flag and cut the shake short, so only this element's own end counts. */
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setShake(false)
      }}
    >
      <div className="flex flex-col items-center gap-2">
        {/* A single entry BOX rather than a bare row of dots.
            The box is what makes the pad read as a field being filled in — it
            holds the prompt while empty, so a first-time user is told what to do
            rather than shown four dots that could equally be decoration.

            Bullet CHARACTERS, letter-spaced, rather than rendered circles: at
            this size the text sits on the same baseline the prompt uses, so the
            box does not change height between its two states. They are the whole
            reason this is not an <input> — the customer is standing on the other
            side of the screen, and a till that renders the digits hands them the
            PIN. */}
        {/* The SAME 58px tall either way, so the pad's overall height does not
            depend on which display it wears — the sign-in screen's 706px pane
            is measured from this, and a variant that came out shorter would
            leave the picture beside it hanging past the card. */}
        {display === 'dots' ? (
          /* One dot per expected digit, filling left to right.
             A count of what is left to type rather than a field being filled
             in: `length` dots exist from the start and change colour, so the
             row never changes width and nothing moves as a thumb works. */
          <div className="flex h-[58px] w-full items-center justify-center gap-3">
            {Array.from({ length }).map((_, i) => (
              <span
                key={i}
                className={`h-2.5 w-2.5 rounded-pill transition ${
                  i < pin.length ? 'bg-brand' : 'bg-border-strong'
                }`}
              />
            ))}
          </div>
        ) : (
          <div className="flex h-[58px] w-full items-center justify-center rounded-card border border-border bg-canvas px-4">
            {pin.length === 0 ? (
              <span className="text-sm font-semibold text-muted">Enter PIN</span>
            ) : (
              /* pl-[8px]: letter-spacing is applied after the LAST bullet too, so
                 the glyph row carries a trailing gap and centring lands it 4px
                 left of true. The padding gives that space back. */
              <span className="pl-[8px] text-[26px] font-extrabold tracking-[8px] text-ink">
                {'•'.repeat(pin.length)}
              </span>
            )}
          </div>
        )}
        {/* The count, for a screen reader only — the dots above are shapes with
            no text, so without this the pad is silent as it fills.
            The COUNT rather than the digits: reading a PIN out loud at a counter
            is the audible version of printing it on the screen. */}
        <span className="sr-only" aria-live="polite">
          {pin.length === 0 ? 'PIN empty' : `${pin.length} digits entered`}
        </span>
        {error && <p className="text-center text-sm text-danger">{error}</p>}
      </div>

      {/* size="touch"/"touch-lg" rather than a className height on each key:
          this pad was hand-writing h-14 five times before --spacing-touch
          existed, which is what a missing token looks like from the inside.

          The digits are `ghost` — NEUTRAL, not `secondary`.
          Secondary is brand-tinted, and ten tinted keys next to a brand-filled
          confirm is eleven things asking to be pressed. Colour on this pad means
          "this is the one that acts", which only OK may claim.

          w-full on every key: Button is inline-flex, so a key sizes to its own
          glyph plus padding and sits at the LEFT of its grid cell. On the wide
          pad the cells are ~165px and a "3" is nowhere near that, which left a
          band of dead space down the right-hand column — the grid was the right
          width all along, the keys inside it were not. */}
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <Button
            key={digit}
            variant="key"
            size={keySize}
            onClick={() => press(digit)}
            disabled={busy}
            className={`w-full font-bold ${wide ? 'text-[22px]' : 'text-[19px]'}`}
          >
            {digit}
          </Button>
        ))}

        {/* Backspace, 0, submit — the till layout, and the submit key is IN the
            grid rather than a full-width button under it. A cashier's thumb
            returns to the same corner every time instead of travelling to a
            different control once the last digit is in.

            Clear is gone with it. Backspace covers the mistyped digit, which is
            the real error, and holding a whole key for "start again" spent a
            third of the bottom row on the rarer of the two. */}
        <Button
          variant="key"
          size={keySize}
          onClick={() => setPin((current) => current.slice(0, -1))}
          disabled={busy || !pin}
          className="w-full"
          aria-label="Backspace"
        >
          <Icons.Backspace size={22} />
        </Button>
        <Button
          variant="key"
          size={keySize}
          onClick={() => press('0')}
          disabled={busy}
          className={`w-full font-bold ${wide ? 'text-[22px]' : 'text-[19px]'}`}
        >
          0
        </Button>
        {/* Still rendered for a four-digit PIN, which submits itself: a visible
            confirm is what tells a first-time user the pad is finished rather
            than stuck, and a five- or six-digit PIN has no other way in. */}
        <Button
          variant="primary"
          size={keySize}
          onClick={() => send(pin)}
          disabled={busy || pin.length < 4}
          className={`w-full whitespace-nowrap font-extrabold ${wide ? 'text-lg' : 'text-base'}`}
        >
          {busy ? '…' : submitLabel}
        </Button>
      </div>

      {onCancel && (
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      )}
    </div>
  )
}
