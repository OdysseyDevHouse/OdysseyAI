'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Icons,
  Input,
  SegmentedControl,
  Textarea,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { useCart } from '../CartContext'
import { placeOrderAction, quoteDeliveryAction } from './actions'

/**
 * Checkout.
 *
 * ── ONE PAGE, NOT A WIZARD ───────────────────────────────────────────────
 *
 * A corner-shop order is five items and a phone number. Every step in a wizard
 * is somewhere to abandon, so everything is on screen at once and the delivery
 * fields simply appear when they become relevant.
 *
 * ── EVERY FIGURE HERE IS INDICATIVE ──────────────────────────────────────
 *
 * The server re-prices the basket from the catalogue and re-quotes delivery
 * from the current zones when the order is placed. A basket edited in devtools
 * changes what is ordered, never what it costs.
 *
 * ── ERRORS DO NOT GO IN A TOAST ──────────────────────────────────────────
 *
 * They sit above the button, permanently, until fixed. A toast that says "give
 * us a phone number" and then disappears leaves a shopper pressing a button
 * that seems to do nothing.
 */
export default function Checkout({
  token,
  collectEnabled,
  deliverEnabled,
  minOrderIncl,
  leadTimeMinutes,
  payOnline,
  allowAccount,
  storeName,
  account,
}: {
  token: string
  collectEnabled: boolean
  deliverEnabled: boolean
  minOrderIncl: number
  leadTimeMinutes: number
  /** True when the shop takes payment at checkout rather than on collection. */
  payOnline: boolean
  /** Whether this shop offers account orders at all. */
  allowAccount: boolean
  storeName: string
  /**
   * The signed-in customer, or null when nobody is signed in.
   *
   * Only what the panel needs to draw. Whether the order may go on the account
   * is decided server-side when it is placed, never from this.
   */
  account: {
    name: string
    phone: string
    email: string
    availableCredit: number
    accountOpen: boolean
  } | null
}) {
  const cart = useCart()
  const router = useRouter()
  const [placing, startPlacing] = useTransition()

  const [fulfilment, setFulfilment] = useState<'collect' | 'deliver'>(
    collectEnabled ? 'collect' : 'deliver',
  )
  /*
   * Prefilled for a signed-in customer, and EDITABLE.
   *
   * We already know who they are, so making them retype it is friction for no
   * gain. Editable because the person collecting is often not the person whose
   * name is on the account — and what they type here goes on this order only,
   * never back onto their customer record.
   */
  const [name, setName] = useState(account?.name ?? '')
  const [phone, setPhone] = useState(account?.phone ?? '')
  const [email, setEmail] = useState(account?.email ?? '')
  const [line1, setLine1] = useState('')
  const [suburb, setSuburb] = useState('')
  const [postcode, setPostcode] = useState('')
  const [deliveryNotes, setDeliveryNotes] = useState('')
  const [customerNote, setCustomerNote] = useState('')
  const [error, setError] = useState('')
  const [payOnAccount, setPayOnAccount] = useState(false)

  const [quote, setQuote] = useState<{ fee: number; reason: string; deliverable: boolean } | null>(
    null,
  )

  const belowMinimum = minOrderIncl > 0 && cart.subtotal < minOrderIncl
  const deliveryFee = fulfilment === 'deliver' && quote?.deliverable ? quote.fee : 0
  const total = cart.subtotal + deliveryFee

  /*
   * ── Whether this order is actually going on the account ────────────────
   *
   * `payOnAccount` is what the shopper ticked. `chargingAccount` is whether it
   * currently applies — and it is the second one that is submitted.
   *
   * The box is NOT unticked when the total grows past the remaining credit.
   * Un-ticking a control someone deliberately set is startling, and they may
   * be about to remove a line and bring the total back down. Instead the tick
   * stays, this goes false, and the reason appears beside it.
   */
  const accountUsable = allowAccount && !!account?.accountOpen
  const overCredit =
    accountUsable &&
    total > account!.availableCredit + 0.005
  const chargingAccount = payOnAccount && accountUsable && !overCredit

  /*
   * Quote delivery as the address is typed, debounced.
   *
   * The guard is a request SEQUENCE, not a boolean: these settle out of order,
   * and a slow quote for "Clare" landing after a fast one for "Claremont"
   * would replace the right answer with a stale one.
   *
   * It depends on the basket total too, so removing a line re-checks a
   * free-over-this-amount threshold rather than leaving a fee that no longer
   * applies.
   */
  const seq = useRef(0)
  useEffect(() => {
    if (fulfilment !== 'deliver' || (!suburb.trim() && !postcode.trim())) {
      setQuote(null)
      return
    }
    const mine = ++seq.current
    const timer = setTimeout(async () => {
      const result = await quoteDeliveryAction(token, suburb, postcode, cart.subtotal)
      if (mine !== seq.current) return
      setQuote(
        result.ok
          ? { fee: result.fee, reason: result.reason, deliverable: result.deliverable }
          : null,
      )
    }, 500)
    return () => clearTimeout(timer)
  }, [fulfilment, suburb, postcode, cart.subtotal, token])

  function placeOrder() {
    setError('')

    // Checked in the order a shopper fills the form in, so the message names
    // the first thing they still have to do rather than the last.
    if (cart.lines.length === 0) return setError('Your basket is empty.')
    if (!name.trim()) return setError('Please enter your name so the shop knows who to expect.')
    if (!phone.trim() && !email.trim()) {
      return setError('Please leave a phone number or email so the shop can reach you.')
    }
    if (fulfilment === 'deliver' && !line1.trim()) {
      return setError('Please enter the address we’re delivering to.')
    }
    if (fulfilment === 'deliver' && quote && !quote.deliverable) return setError(quote.reason)
    if (fulfilment === 'deliver' && !quote) {
      return setError('Please enter your suburb or postal code so we can check delivery.')
    }
    if (belowMinimum) {
      return setError(`Orders start at ${formatMoney(minOrderIncl)}. Please add a little more.`)
    }

    startPlacing(async () => {
      const result = await placeOrderAction(token, {
        fulfilment,
        contactName: name,
        contactPhone: phone,
        contactEmail: email,
        deliveryLine1: line1,
        deliverySuburb: suburb,
        deliveryPostcode: postcode,
        deliveryNotes,
        customerNote,
        lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        payOnAccount: chargingAccount,
      })

      if (!result.ok) {
        // The basket is left intact so the shopper can fix it and try again.
        setError(result.error)
        return
      }

      cart.clear()

      /*
       * Paying online: hand the browser to the gateway with a REAL form POST.
       * A fetch would not do — the shopper has to end up on the gateway's own
       * page, which is what keeps card details out of this app entirely.
       *
       * The cart is cleared before the handoff, so someone who backs out of
       * the payment page cannot submit the same basket a second time.
       */
      if (result.payment) {
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = result.payment.action
        for (const [key, value] of Object.entries(result.payment.fields)) {
          const field = document.createElement('input')
          field.type = 'hidden'
          field.name = key
          field.value = value
          form.appendChild(field)
        }
        document.body.appendChild(form)
        form.submit()
        // Deliberately NOT re-enabling the button: it must stay disabled
        // through the navigation, or an impatient second press orders twice.
        return
      }

      // The track token rides to the confirmation page so a guest gets a
      // "follow your order" link without an account. Omitted when signing
      // failed — the page then shows the order number alone, as before.
      const track = result.trackToken ? `&t=${encodeURIComponent(result.trackToken)}` : ''
      router.push(
        `/store/${token}/done?order=${encodeURIComponent(result.orderNumber)}&total=${result.total}${track}`,
      )
    })
  }

  // `ready` gates the first paint: the basket is read from storage in an
  // effect, so rendering before that flashes "empty" at someone who has one.
  if (!cart.ready) {
    return <p className="py-10 text-center text-sm text-muted">Loading your basket…</p>
  }

  if (cart.lines.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Icons.Package size={22} />}
          title="Your basket is empty"
          hint="Add something you'd like and come back here to finish."
          action={
            <Link href={`/store/${token}`}>
              <Button variant="primary">Start shopping</Button>
            </Link>
          }
        />
      </Card>
    )
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink">Checkout</h1>
      <p className="mt-1 text-sm text-muted">Almost there — check your order and place it.</p>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        {/* ── The form ── */}
        <Card>
          <div className="flex flex-col gap-4 p-4">
            {/* Only when there is a genuine choice. A shop that only collects
                gets no control at all rather than one with a single option. */}
            {collectEnabled && deliverEnabled && (
              <SegmentedControl
                value={fulfilment}
                onChange={(value) => {
                  setFulfilment(value as 'collect' | 'deliver')
                  setQuote(null)
                }}
                options={[
                  { value: 'collect', label: 'Collect' },
                  { value: 'deliver', label: 'Deliver' },
                ]}
              />
            )}

            {fulfilment === 'collect' && (
              <p className="text-sm text-muted">
                Ready in about {leadTimeMinutes} minutes once the shop confirms.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Your name">
                <Input
                  value={name}
                  autoComplete="name"
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Phone">
                <Input
                  value={phone}
                  inputMode="tel"
                  autoComplete="tel"
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Email" hint="So the shop can send your confirmation">
                  <Input
                    value={email}
                    inputMode="email"
                    autoComplete="email"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
              </div>
            </div>

            {fulfilment === 'deliver' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Street address">
                    <Input
                      value={line1}
                      autoComplete="address-line1"
                      onChange={(e) => setLine1(e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Suburb">
                  <Input
                    value={suburb}
                    autoComplete="address-level2"
                    onChange={(e) => setSuburb(e.target.value)}
                  />
                </Field>
                <Field label="Postal code">
                  <Input
                    value={postcode}
                    autoComplete="postal-code"
                    onChange={(e) => setPostcode(e.target.value)}
                  />
                </Field>
                {/* Directly under the two fields that produced it. Below the
                    notes box it sits a screen away from the address someone
                    just typed, so the answer looks unrelated to the question. */}
                {quote && (
                  <div
                    className={`sm:col-span-2 rounded-control border px-3 py-2 text-sm ${
                      // "We don't deliver there" is information, not an error
                      // the shopper caused — so it is not red.
                      quote.deliverable
                        ? 'border-border bg-surface-2 text-ink'
                        : 'border-border bg-brand-soft text-ink'
                    }`}
                  >
                    {quote.reason}
                  </div>
                )}

                <div className="sm:col-span-2">
                  <Field label="Delivery notes (optional)" hint="e.g. blue gate, ring twice">
                    <Textarea
                      rows={2}
                      maxLength={500}
                      value={deliveryNotes}
                      onChange={(e) => setDeliveryNotes(e.target.value)}
                    />
                  </Field>
                </div>
              </div>
            )}

            <Field label="Anything else? (optional)">
              <Textarea
                rows={2}
                maxLength={500}
                value={customerNote}
                onChange={(e) => setCustomerNote(e.target.value)}
              />
            </Field>

            <Link
              href={`/store/${token}`}
              className="text-sm text-brand underline-offset-2 hover:underline"
            >
              ← Add something else
            </Link>
          </div>
        </Card>

        {/* ── The order summary ── */}
        <Card className="lg:sticky lg:top-32">
          <div className="p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold text-ink">Order summary</h2>
              <span className="text-xs text-muted">
                {cart.count} {cart.count === 1 ? 'item' : 'items'}
              </span>
            </div>

            <ul className="mt-3 flex flex-col gap-3">
              {cart.lines.map((line) => (
                <li key={line.productId} className="flex items-center gap-3">
                  <span className="flex h-7 min-w-7 shrink-0 items-center justify-center rounded-pill bg-brand px-1.5 text-xs font-semibold text-white">
                    {line.qty}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{line.description}</span>
                    {/* Only worth saying when it differs from the line total.
                        At a quantity of one it prints the same figure twice,
                        which reads as a mistake rather than as a breakdown. */}
                    {line.qty > 1 && (
                      <span className="numeric block text-xs text-muted">
                        {formatMoney(line.priceIncl)} each
                      </span>
                    )}
                  </span>
                  <span className="numeric shrink-0 text-sm text-ink">
                    {formatMoney(line.qty * line.priceIncl)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Remove ${line.description}`}
                    onClick={() => cart.setQty(line.productId, 0)}
                  >
                    <Icons.Close size={15} />
                  </Button>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
              <Row label="Subtotal" value={formatMoney(cart.subtotal)} />
              {/* Only once a quote exists. Showing "Delivery R0.00" before the
                  address is typed would read as free delivery. */}
              {fulfilment === 'deliver' && quote && (
                <Row
                  label="Delivery"
                  value={deliveryFee > 0 ? formatMoney(deliveryFee) : 'Free'}
                />
              )}
            </div>

            <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
              <span className="text-base font-semibold text-ink">Total</span>
              <span className="numeric text-lg font-semibold text-ink">{formatMoney(total)}</span>
            </div>
            <p className="mt-1 text-xs text-muted">Including VAT</p>

            {belowMinimum && (
              <p className="mt-3 text-sm text-muted">
                Orders start at {formatMoney(minOrderIncl)}.
              </p>
            )}

            {/* ── On account ──────────────────────────────────────────────
                Three states, and a fourth that renders nothing at all: a shop
                with accounts switched off never mentions the word. */}
            {allowAccount && account && account.accountOpen && (
              <div
                className={`mt-4 rounded-control border px-3 py-3 ${
                  chargingAccount ? 'border-brand bg-brand-soft' : 'border-border bg-surface-2'
                }`}
              >
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox
                    checked={payOnAccount}
                    onChange={(e) => setPayOnAccount(e.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">
                      Put this on my account
                    </span>
                    <span className="block text-xs text-muted">
                      {formatMoney(account.availableCredit)} available. Nothing to pay now.
                    </span>
                  </span>
                </label>

                {/* Only once they have asked for it. Telling someone their
                    order is too big for an account they were not trying to
                    use is noise. */}
                {payOnAccount && overCredit && (
                  <p role="alert" className="mt-2 text-xs text-danger">
                    This order is more than the{' '}
                    {formatMoney(account.availableCredit)} left on your
                    account, so it can&rsquo;t go on account. Please remove an item or pay as
                    usual.
                  </p>
                )}
              </div>
            )}

            {allowAccount && account && !account.accountOpen && (
              <p className="mt-4 text-xs text-muted">
                Your account is on hold, so this order can&rsquo;t go on it. Please contact{' '}
                {storeName}.
              </p>
            )}

            {allowAccount && !account && (
              <p className="mt-4 text-xs text-muted">
                Have an account with {storeName}?{' '}
                <Link
                  href={`/store/${token}/account`}
                  className="font-medium text-brand underline-offset-2 hover:underline"
                >
                  Sign in
                </Link>{' '}
                to put this order on it.
              </p>
            )}

            {error && (
              <p
                role="alert"
                className="mt-3 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {error}
              </p>
            )}

            <Button
              variant="primary"
              className="mt-3 w-full"
              onClick={placeOrder}
              disabled={placing || belowMinimum}
            >
              {placing
                ? 'Please wait…'
                : chargingAccount
                  ? `Place order on account · ${formatMoney(total)}`
                  : payOnline
                    ? `Pay ${formatMoney(total)}`
                    : `Place order · ${formatMoney(total)}`}
            </Button>

            <p className="mt-2 text-center text-xs text-muted">
              {chargingAccount
                ? 'Nothing to pay now — it goes on your statement.'
                : payOnline
                  ? 'You’ll pay securely on the next screen.'
                  : `You pay when you ${fulfilment === 'deliver' ? 'receive' : 'collect'} your order.`}
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-muted">{label}</span>
      <span className="numeric text-ink">{value}</span>
    </div>
  )
}
