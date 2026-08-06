'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icons,
  Input,
  SegmentedControl,
  Textarea,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { useCart } from '../CartContext'
import { placeOrderAction, quoteDeliveryAction } from './actions'

/**
 * Basket and checkout, in one screen.
 *
 * One screen rather than a wizard because a corner-shop order is five items
 * and a phone number: every extra step is somewhere to abandon. The basket
 * stays editable right up to the moment of ordering, since noticing a wrong
 * quantity is the most common reason to go back.
 *
 * Every figure shown here is INDICATIVE. The server re-prices the basket from
 * the catalogue and re-quotes delivery from the current zones when the order
 * is placed, so what the shop receives is never what this page computed.
 */
export default function Checkout({
  token,
  collectEnabled,
  deliverEnabled,
  minOrderIncl,
  leadTimeMinutes,
  payOnline,
}: {
  token: string
  collectEnabled: boolean
  deliverEnabled: boolean
  minOrderIncl: number
  leadTimeMinutes: number
  /** True when the shop takes payment at checkout rather than on collection. */
  payOnline: boolean
}) {
  const cart = useCart()
  const toast = useToast()
  const router = useRouter()
  const [placing, startPlacing] = useTransition()
  const [quoting, startQuoting] = useTransition()

  const [fulfilment, setFulfilment] = useState<'collect' | 'deliver'>(
    collectEnabled ? 'collect' : 'deliver',
  )
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [line1, setLine1] = useState('')
  const [suburb, setSuburb] = useState('')
  const [postcode, setPostcode] = useState('')
  const [deliveryNotes, setDeliveryNotes] = useState('')
  const [customerNote, setCustomerNote] = useState('')

  const [quote, setQuote] = useState<{ fee: number; reason: string; deliverable: boolean } | null>(
    null,
  )

  const belowMinimum = minOrderIncl > 0 && cart.subtotal < minOrderIncl
  const total = cart.subtotal + (fulfilment === 'deliver' && quote?.deliverable ? quote.fee : 0)

  function checkDelivery() {
    if (!suburb.trim() && !postcode.trim()) {
      toast.error('Enter your suburb or postal code first.')
      return
    }
    startQuoting(async () => {
      const result = await quoteDeliveryAction(token, suburb, postcode, cart.subtotal)
      if (!result.ok) {
        toast.error(result.error)
        setQuote(null)
        return
      }
      setQuote({ fee: result.fee, reason: result.reason, deliverable: result.deliverable })
    })
  }

  function placeOrder() {
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
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      // Cleared only after the server confirms — a failed order must leave the
      // basket intact so the shopper can fix the problem and try again.
      cart.clear()

      // Paying online: hand the browser to the gateway. Submitting a real form
      // rather than fetching, because the shopper has to END UP on PayFast's
      // own page — that is what keeps card details away from this app
      // entirely.
      if (result.payment) {
        const form = document.createElement('form')
        form.method = 'POST'
        form.action = result.payment.action
        for (const [name, value] of Object.entries(result.payment.fields)) {
          const field = document.createElement('input')
          field.type = 'hidden'
          field.name = name
          field.value = value
          form.appendChild(field)
        }
        document.body.appendChild(form)
        form.submit()
        return
      }

      router.push(
        `/store/${token}/done?order=${encodeURIComponent(result.orderNumber)}&total=${result.total}`,
      )
    })
  }

  if (!cart.ready) {
    return <p className="py-10 text-center text-sm text-muted">Loading your basket…</p>
  }

  if (cart.lines.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Icons.Package size={22} />}
          title="Your basket is empty"
          hint="Add something from the shop and it will show up here."
          action={
            <Link href={`/store/${token}`}>
              <Button variant="primary">Browse the shop</Button>
            </Link>
          }
        />
      </Card>
    )
  }

  const canOrder =
    name.trim() !== '' &&
    (phone.trim() !== '' || email.trim() !== '') &&
    !belowMinimum &&
    (fulfilment === 'collect' || (line1.trim() !== '' && quote?.deliverable === true))

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Your basket" description={`${cart.count} item${cart.count === 1 ? '' : 's'}`} />
        <ul className="divide-y divide-border">
          {cart.lines.map((line) => (
            <li key={line.productId} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {line.description}
                </span>
                <span className="numeric text-xs text-muted">
                  {formatMoney(line.priceIncl)} each
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`One fewer ${line.description}`}
                  onClick={() => cart.setQty(line.productId, line.qty - 1)}
                >
                  <Icons.ChevronDown size={15} />
                </Button>
                <span className="numeric w-8 text-center text-sm text-ink">{line.qty}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label={`One more ${line.description}`}
                  onClick={() => cart.setQty(line.productId, line.qty + 1)}
                >
                  <Icons.ChevronUp size={15} />
                </Button>
              </div>

              <span className="numeric w-24 shrink-0 text-right text-sm font-medium text-ink">
                {formatMoney(line.priceIncl * line.qty)}
              </span>

              <Button
                variant="danger-ghost"
                size="sm"
                iconOnly
                aria-label={`Remove ${line.description}`}
                onClick={() => cart.remove(line.productId)}
              >
                <Icons.Close size={15} />
              </Button>
            </li>
          ))}
        </ul>

        {belowMinimum && (
          <p className="border-t border-border bg-warning-soft px-5 py-3 text-sm text-warning-ink">
            Orders start at {formatMoney(minOrderIncl)}. Add{' '}
            {formatMoney(minOrderIncl - cart.subtotal)} more to place this one.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="How would you like it?"
          description={
            fulfilment === 'collect'
              ? `Ready in about ${leadTimeMinutes} minutes once we confirm.`
              : 'We deliver to selected areas.'
          }
        />
        <div className="flex flex-col gap-4 p-5">
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

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
            </Field>
            <Field label="Phone" hint="So we can reach you about the order.">
              <Input
                value={phone}
                type="tel"
                onChange={(e) => setPhone(e.target.value)}
                placeholder="082 123 4567"
              />
            </Field>
          </div>

          <Field label="Email" hint="Optional if you gave a phone number.">
            <Input
              value={email}
              type="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </Field>

          {fulfilment === 'deliver' && (
            <>
              <Field label="Street address">
                <Input
                  value={line1}
                  onChange={(e) => setLine1(e.target.value)}
                  placeholder="12 Main Road"
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Suburb">
                  <Input
                    value={suburb}
                    onChange={(e) => {
                      setSuburb(e.target.value)
                      setQuote(null)
                    }}
                    placeholder="Claremont"
                  />
                </Field>
                <Field label="Postal code">
                  <Input
                    value={postcode}
                    onChange={(e) => {
                      setPostcode(e.target.value)
                      setQuote(null)
                    }}
                    placeholder="7708"
                  />
                </Field>
              </div>

              <div className="flex items-center gap-3">
                <Button variant="secondary" onClick={checkDelivery} disabled={quoting}>
                  {quoting ? 'Checking…' : 'Check if you deliver here'}
                </Button>
                {quote && (
                  <span
                    className={`text-sm ${quote.deliverable ? 'text-success' : 'text-danger'}`}
                  >
                    {quote.reason}
                  </span>
                )}
              </div>

              <Field label="Delivery notes" hint="Gate code, which door, anything we should know.">
                <Textarea
                  value={deliveryNotes}
                  rows={2}
                  maxLength={500}
                  onChange={(e) => setDeliveryNotes(e.target.value)}
                />
              </Field>
            </>
          )}

          <Field label="Anything else?" hint="Optional note for the shop.">
            <Textarea
              value={customerNote}
              rows={2}
              maxLength={500}
              onChange={(e) => setCustomerNote(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col gap-2 p-5">
          <div className="flex justify-between gap-4 text-sm">
            <span className="text-muted">Items</span>
            <span className="numeric text-ink">{formatMoney(cart.subtotal)}</span>
          </div>
          {fulfilment === 'deliver' && quote?.deliverable && (
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-muted">Delivery</span>
              <span className="numeric text-ink">{formatMoney(quote.fee)}</span>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-border pt-2">
            <span className="font-medium text-ink">Total</span>
            <span className="numeric text-lg font-semibold text-ink">{formatMoney(total)}</span>
          </div>

          <p className="mt-1 text-sm text-muted">
            {payOnline
              ? 'You’ll pay securely on the next screen. We confirm your order once the payment goes through.'
              : `You pay when you ${fulfilment === 'deliver' ? 'receive' : 'collect'} your order. We confirm it before preparing anything.`}
          </p>

          <Button
            variant="primary"
            className="mt-2"
            onClick={placeOrder}
            disabled={!canOrder || placing}
          >
            {placing
              ? payOnline
                ? 'Taking you to pay…'
                : 'Placing your order…'
              : payOnline
                ? 'Pay now'
                : 'Place order'}
          </Button>

          {!canOrder && !belowMinimum && (
            <p className="text-sm text-muted">
              {name.trim() === ''
                ? 'Enter your name to continue.'
                : phone.trim() === '' && email.trim() === ''
                  ? 'Give us a phone number or an email address.'
                  : fulfilment === 'deliver' && line1.trim() === ''
                    ? 'Enter your street address.'
                    : 'Check that we deliver to your area to continue.'}
            </p>
          )}
        </div>
      </Card>
    </div>
  )
}
