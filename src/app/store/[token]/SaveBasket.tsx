'use client'

import { useState, useTransition } from 'react'
import { Button, Icons, Input } from '@/components/ui'
import { useCart } from './CartContext'
import { saveBasketAction } from './basketActions'

/**
 * "Email me my basket."
 *
 * ── IT IS A DISCLOSED OFFER, NOT A GATE ──────────────────────────────────
 *
 * Collapsed to a single line until someone chooses to open it, and never in
 * front of the checkout button. The moment a shop makes this compulsory to
 * proceed it stops being a convenience and becomes an email harvest, and the
 * shopper who wanted bread leaves instead.
 *
 * The wording says plainly what happens — one reminder — because "we'll send
 * you a reminder if you don't come back" is what someone is actually agreeing
 * to, and burying it is how a storefront ends up marked as spam.
 *
 * ── THE ONLY REPLY IS "DONE" ─────────────────────────────────────────────
 *
 * The action returns nothing about the saved basket, deliberately. Handing a
 * recovery link straight back to the browser would let anyone mint one for any
 * address they typed; the link only ever arrives at the address itself.
 */
export default function SaveBasket({ token }: { token: string }) {
  const cart = useCart()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, startSaving] = useTransition()

  if (cart.lines.length === 0) return null

  if (saved) {
    return (
      <p className="mt-3 flex items-center gap-2 rounded-control bg-success-soft px-3 py-2 text-sm text-success">
        <Icons.Check size={16} />
        Saved — we&rsquo;ll email you the link.
      </p>
    )
  }

  if (!open) {
    return (
      <button
        type="button"
        data-kit-ok
        onClick={() => setOpen(true)}
        /* Not a kit Button: this is a quiet inline disclosure under the total,
           and every Button variant would give it a box and a weight that
           competes with Checkout — the one thing on this panel that matters. */
        className="mt-3 flex items-center gap-1.5 text-sm text-brand underline-offset-2 hover:underline"
      >
        <Icons.Mail size={15} />
        Email me this basket
      </button>
    )
  }

  function save() {
    setError('')
    startSaving(async () => {
      const result = await saveBasketAction(token, {
        email,
        lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved(true)
    })
  }

  return (
    <div className="mt-3 rounded-control border border-border bg-surface-2 p-3">
      <p className="text-sm font-medium text-ink">Email me this basket</p>
      <p className="mt-0.5 text-xs text-muted">
        We&rsquo;ll send you a link to pick up where you left off, and one reminder if you
        don&rsquo;t come back. Nothing else.
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="min-w-[12rem] flex-1">
          <Input
            value={email}
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Your email address"
            onChange={(e) => setEmail(e.target.value)}
          />
        </span>
        <Button variant="secondary" disabled={busy || !email.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Save it'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
