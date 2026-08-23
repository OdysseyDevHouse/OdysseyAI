'use client'

import { useEffect, type RefObject } from 'react'

/**
 * A keypad listens on `window`, because the cashier types at the till without
 * clicking the pad first — there is nothing to focus, and demanding a focus
 * would make the keyboard useless.
 *
 * That reach is also the danger. Two guards make it safe, and both were bugs
 * before they were guards:
 *
 * 1. A <dialog> is NEVER unmounted — `Modal` only toggles visibility with
 *    showModal()/close(). So a pad inside a closed modal keeps its listener
 *    bound and keeps swallowing digits and Backspace across the whole POS
 *    screen. Every closed modal's pad was eating the product search box.
 *
 * 2. Even while open, a pad shares its dialog with text fields — a payout
 *    reason, a customer name. Keys aimed at a field belong to the field.
 *
 * `hidden` covers the first: it is true when the pad's own subtree is not being
 * rendered to the user, which `HTMLElement.checkVisibility()` answers for the
 * closed-<dialog> case that `disabled` props cannot see.
 */
export function usePadKeys(
  anchor: RefObject<HTMLElement | null>,
  onKey: (event: KeyboardEvent) => void,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return

    function handler(event: KeyboardEvent) {
      // A key already claimed by something else — a browser shortcut, another
      // pad higher up — is not ours to act on a second time.
      if (event.defaultPrevented) return
      if (isTypingTarget(event.target)) return
      if (!isVisible(anchor.current)) return
      onKey(event)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [anchor, onKey, enabled])
}

/**
 * Whether the event is headed for somewhere a person is typing prose or a
 * number BY HAND. A pad must not touch those keys: backspace deletes a
 * character, and a digit is a digit.
 *
 * Checked on the event target rather than `document.activeElement` so it stays
 * right inside a shadow root and for a synthetic event, and it reads the live
 * `isContentEditable` rather than the attribute, which is inherited.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true

  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true

  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    // A checkbox, a radio or a button IS an input but carries no caret, so a
    // pad may still take the keys — the space bar is theirs, not ours.
    return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit'
  }

  return false
}

/**
 * Whether this element is actually on screen. `checkVisibility()` is what
 * answers the closed-<dialog> case: the pad is still mounted and still in the
 * document, so `isConnected` and `offsetParent` are no help, but the dialog
 * around it is `display: none` and this reports false.
 *
 * The fallback covers a browser without it: a hidden subtree has no layout
 * boxes, so its client rects come back empty.
 */
function isVisible(element: HTMLElement | null): boolean {
  if (!element) return false
  if (typeof element.checkVisibility === 'function') return element.checkVisibility()
  return element.getClientRects().length > 0
}
