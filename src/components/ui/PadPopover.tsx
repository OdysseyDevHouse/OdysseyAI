'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { NumPad } from './NumPad'
import * as Icons from './icons'

/**
 * The number pad, brought to the box being typed into.
 *
 * ── WHY A POP-UP AND NOT A PANEL ────────────────────────────────────────────
 *
 * A pad parked in a dialog spends ~250px of that dialog on keys that are only
 * wanted while somebody is typing — and on a tabletop till, where the dialog is
 * already the whole screen, that 250px comes out of the ONE thing the screen
 * exists to show. The cash-up is the case this was built for: eleven
 * denominations, eight tenders and a fold-out grid were reading through a
 * 200px-tall slot because a permanently-visible pad sat under them.
 *
 * So the keys arrive when a box is tapped, over content that is not being read
 * at that moment, and leave when it is done. The list underneath gets the whole
 * panel back.
 *
 * ── IT MUST NOT TAKE THE FOCUS ──────────────────────────────────────────────
 *
 * `onMouseDown` is prevented on the whole surface, which is the one thing
 * holding the arrangement together. The field this types into stays focused, so
 *
 *   - the caret stays where the cashier put it and the box keeps its ring, so
 *     the pad visibly belongs to that box rather than floating free;
 *   - a physical keyboard keeps working — the keys go to the focused input, and
 *     NumPad's own window listener stands down while something is being typed
 *     into (see padKeys.ts);
 *   - a caller's `onBlur` does not fire on every keypress. That one is not
 *     cosmetic: the cash-up commits a tender on blur and asks the server for
 *     its expected figure in exchange, so a pad that stole focus would spend
 *     the reveal on the first digit of a number not yet typed.
 *
 * ── WHERE IT LANDS ──────────────────────────────────────────────────────────
 *
 * Below the box and right-aligned to it, flipping above and then beside as the
 * room runs out — never OVER the box, because a pad covering the figure it is
 * typing is worse than no pad at all. Re-measured on scroll (captured, so an
 * inner pane counts) and on resize, so it stays stuck to a box in a list that
 * moves under it.
 *
 * `position: fixed` and rendered where it is written rather than portalled: the
 * host is usually a <dialog>, which draws in the top layer, and a portal to
 * document.body would put the pad UNDER the modal it belongs to. Fixed escapes
 * the scroll pane's clipping on its own, which is the only reason a portal
 * would have been wanted.
 */
export function PadPopover({
  open,
  anchor,
  label,
  value,
  onChange,
  maxDecimals = 2,
  onEnter,
  enterLabel = 'Enter',
  hint,
  onClose,
  disabled = false,
}: {
  open: boolean
  /**
   * The box being typed into. The pad is positioned against it and closes when
   * it goes away — pass the element itself, usually captured from the focus
   * event that opened this.
   */
  anchor: HTMLElement | null
  /** What is being counted, e.g. “R20 · how many”. Shown above the keys. */
  label?: ReactNode
  /** The decimal string being typed — see NumPad. Never a number. */
  value: string
  onChange: (next: string) => void
  /** 0 for a whole-number pad (a pile of notes), 2 for an amount. */
  maxDecimals?: number
  /**
   * The pad's own action key. Omit and the pad is digits only.
   *
   * It is the caller's Enter, not a submit: in a count it banks the figure and
   * drops to the next row, which is why the wording is theirs to give.
   */
  onEnter?: () => void
  enterLabel?: string
  /** One line under the keys saying what Enter will do. */
  hint?: ReactNode
  /** Tapped outside, or Escape. The caller decides what that commits. */
  onClose: () => void
  disabled?: boolean
}) {
  const padRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  /* Held in a ref so the listeners below never rebind: `onClose` is usually an
     inline arrow and would otherwise tear down and re-add the document
     listeners on every keystroke. */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  const place = useCallback(() => {
    const pad = padRef.current
    if (!pad || !anchor) return

    const box = anchor.getBoundingClientRect()
    /* An anchor with no box at all has been unmounted or hidden under this pad
       — a row folded away while it was being typed into. Stay where the last
       measurement put it rather than snapping to the corner of the screen,
       which is what a zero rect resolves to. The owner is expected to drop the
       aim in that case; this is only so the pad does not lurch first. */
    if (box.width === 0 && box.height === 0) return
    const w = pad.offsetWidth
    const h = pad.offsetHeight
    /* Off the window edge, and off the box. The second is smaller on purpose:
       the pad should read as belonging to the field it hangs from. */
    const EDGE = 8
    const GAP = 6

    const fitsBelow = box.bottom + GAP + h <= window.innerHeight - EDGE
    const fitsAbove = box.top - GAP - h >= EDGE

    let top: number
    let left = box.right - w

    if (fitsBelow) top = box.bottom + GAP
    else if (fitsAbove) top = box.top - GAP - h
    else {
      /* No room either way — a short till screen with a box in the middle of
         it. Beside the box rather than over it: the figure being typed stays
         readable, which is the whole rule here. */
      top = Math.min(Math.max(EDGE, box.top), window.innerHeight - EDGE - h)
      const toLeft = box.left - GAP - w
      left = toLeft >= EDGE ? toLeft : box.right + GAP
    }

    left = Math.min(Math.max(EDGE, left), window.innerWidth - EDGE - w)
    setPos({ top, left })
  }, [anchor])

  /* Before paint, so the pad is never seen at the previous box's position for a
     frame when the aim moves from one row to the next. */
  useLayoutEffect(() => {
    if (!open || !anchor) return
    place()
  }, [open, anchor, label, hint, place])

  useEffect(() => {
    if (!open || !anchor) return

    /* Captured: the box lives in a pane that scrolls, and a scroll inside an
       element does not bubble to the window. */
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)

    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node
      if (padRef.current?.contains(target)) return
      /* The box itself is not "outside": tapping the field the pad belongs to
         is how somebody puts the caret back, not how they dismiss it. */
      if (anchor?.contains(target) || anchor === target) return
      onCloseRef.current()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      /* Prevented, or the <dialog> around this takes the same Escape and shuts
         the whole screen — losing a half-counted drawer to a key that was meant
         to put the keys away. */
      event.preventDefault()
      event.stopPropagation()
      onCloseRef.current()
    }

    document.addEventListener('mousedown', onPointerDown)
    /* Captured, to reach Escape before the dialog's own handling of it. */
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open, anchor, place])

  if (!open || !anchor) return null

  return (
    <div
      ref={padRef}
      role="group"
      aria-label="Number pad"
      style={pos ?? { top: 0, left: 0 }}
      /* `invisible` until measured — one paint at the wrong place is a pad that
         appears to jump as it opens. */
      className={`fixed z-40 w-60 rounded-card border border-border bg-surface p-3 shadow-pop ${
        pos ? '' : 'invisible'
      }`}
      /* THE LINE THIS WHOLE COMPONENT RESTS ON — see the header. */
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-muted">{label}</span>
        {/* A way out that is not "tap somewhere harmless". A cashier who has
            finished a box needs one deliberate key, and on a touch screen the
            nearest empty space may be another input. */}
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Close the pad"
          onClick={onClose}
        >
          <Icons.Close size={16} />
        </Button>
      </div>

      <NumPad value={value} onChange={onChange} maxDecimals={maxDecimals} disabled={disabled} />

      {onEnter && (
        <Button
          variant="primary"
          size="touch"
          className="mt-2 w-full"
          disabled={disabled}
          onClick={onEnter}
        >
          {enterLabel}
          <Icons.ArrowRight size={16} />
        </Button>
      )}

      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </div>
  )
}
