'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { HEADER_ACTIONS_SLOT } from './styles'

/**
 * Puts a button in the page header from anywhere on the page.
 *
 * ── WHY A PORTAL AND NOT A PROP ───────────────────────────────────────────
 *
 * Every record editor keeps its Save in the top bar, beside the record's other
 * actions. On the product screen that is a prop — <PageHeader action={...}> —
 * because `SaveProductButton` is a bare `<button form="product-form">` with no
 * state of its own, so the server page can render it.
 *
 * Most of the other editors' Save buttons are not like that. They say
 * "Saving…" while the action is in flight, they read "Create customer" or
 * "Save changes" depending on whether the record exists, and the customer form's
 * says "Save anyway" while a duplicate warning stands. All of that lives in the
 * CLIENT form component, and a server page cannot render it or be told about it
 * without lifting the form's state out of the form.
 *
 * So the button stays exactly where it is, inside the form that knows what it
 * should say, and this moves the rendered result into the header. The form is
 * unchanged; only where it paints moves.
 *
 * ── USING IT ──────────────────────────────────────────────────────────────
 *
 *   <HeaderActions>
 *     <SubmitButton isNew={isNew} />
 *   </HeaderActions>
 *
 * One per screen. Two mounted at once put both sets of buttons in the bar, in
 * mount order — which is right for a screen with genuinely two, and a bug on a
 * tabbed screen that forgot to render only the active tab's.
 *
 * Renders nothing at all when there is no <PageHeader> on the screen, so a form
 * shared with a dialog does not have to care which it is in today.
 */
export function HeaderActions({ children }: { children: ReactNode }) {
  /*
   * Held in state rather than read during render, because the slot is in the
   * DOM the server sent and `document` is not there to be read on the server.
   * The effect runs immediately after mount, so the button lands in the bar in
   * the same commit the rest of the form appears in.
   */
  const [host, setHost] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setHost(document.getElementById(HEADER_ACTIONS_SLOT))
  }, [])

  if (!host) return null
  return createPortal(children, host)
}
