'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button, CurrencyInput, Field, Modal, Radio } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { payAccountAction } from './actions'

/**
 * Pay money onto the ACCOUNT, rather than against one invoice.
 *
 * ── WHY THIS IS NOT PayButton WITH AN AMOUNT BOX ───────────────────────────
 *
 * PayButton settles one document for a figure the system computed; the customer
 * accepts it or does not. Here the customer CHOOSES, and that difference runs
 * all the way down: a different intent purpose, a different target table, and a
 * settlement that auto-allocates across open items instead of receipting one.
 * Bolting an optional amount onto PayButton would put "how much" under the
 * caller's control on the invoice path too, which is the one guard that path
 * has.
 *
 * ── IT ASKS BEFORE IT CHARGES ──────────────────────────────────────────────
 *
 * A dialog, not an inline box. The amount is the whole decision on this screen
 * and it is the last chance to change it — after this the customer is on
 * PayFast's own page with a card in their hand. An inline field beside a button
 * invites a press before the number has been read; a dialog makes the figure
 * the thing being confirmed.
 *
 * ── AND IT OFFERS THE BALANCE AS A CHOICE, NOT AS A CEILING ────────────────
 *
 * Two radios, because "settle what I owe" and "pay some other amount" are
 * genuinely different intentions and a customer arrives holding one of them.
 * Pre-filling the balance into a free box would serve the first badly — it
 * reads as a suggestion to be edited rather than the figure on their statement
 * — and offering only the balance would make a top-up impossible.
 *
 * Overpaying is deliberate and supported: anything above the balance lands as
 * an unallocated credit on the ledger, which is what a deposit onto an account
 * has always meant. So the "other amount" box has no upper bound of its own;
 * the server holds the only cap.
 */
export default function PayAccountButton({
  token,
  /** What is owed right now. Zero or negative means nothing to settle. */
  balance,
  variant = 'primary',
  size = 'md',
  label,
}: {
  token: string
  balance: number
  variant?: 'primary' | 'secondary'
  size?: 'md' | 'sm'
  /** Overrides the button's own wording where a screen needs different words. */
  label?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const owing = balance > 0.005
  /* Blank, not "0.00" — an empty money box means "not said yet", and CurrencyInput
     keeps that distinction on purpose. See Field.tsx. */
  const [custom, setCustom] = useState<string>('')
  const [mode, setMode] = useState<'balance' | 'other'>(owing ? 'balance' : 'other')

  const typed = Number(custom.replace(',', '.'))
  const amount = mode === 'balance' ? Math.max(0, balance) : typed
  const valid = Number.isFinite(amount) && amount > 0.005

  function submit() {
    setError(null)
    if (!valid) {
      setError('Please enter an amount greater than zero.')
      return
    }
    start(async () => {
      const result = await payAccountAction(token, amount)
      if (result.ok) router.push(result.url)
      else setError(result.error)
    })
  }

  function openDialog() {
    // Reset every time. A dialog's children never unmount, so a figure typed
    // and abandoned last time would still be sitting in the box — and the next
    // press of Pay would charge it.
    setError(null)
    setCustom('')
    setMode(owing ? 'balance' : 'other')
    setOpen(true)
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={openDialog}>
        {label ?? (owing ? 'Pay now' : 'Top up')}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={owing ? 'Pay your account' : 'Top up your account'}
        description={
          owing
            ? 'Settle what you owe, or pay a different amount.'
            : 'Money paid now sits as credit against your future invoices.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending || !valid}>
              {pending ? 'One moment…' : `Pay ${valid ? formatMoney(amount) : ''}`.trim()}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {owing && (
            <>
              {/* The balance first, because it is what most people came to pay. */}
              <Radio
                name="pay-amount"
                label={`Settle my balance — ${formatMoney(balance)}`}
                checked={mode === 'balance'}
                onChange={() => {
                  setMode('balance')
                  setError(null)
                }}
              />
              <Radio
                name="pay-amount"
                label="Pay a different amount"
                checked={mode === 'other'}
                onChange={() => {
                  setMode('other')
                  setError(null)
                }}
              />
            </>
          )}

          {mode === 'other' && (
            <Field
              label="Amount to pay"
              hint={
                owing
                  ? 'Anything above your balance stays on your account as credit.'
                  : 'This will sit as credit against your future invoices.'
              }
              /* Only once they have tried. An error under a box nobody has
                 typed in yet is the form telling somebody off for nothing. */
              error={error && mode === 'other' ? error : undefined}
            >
              <CurrencyInput
                value={custom}
                onChange={(event) => {
                  setCustom(event.currentTarget.value)
                  setError(null)
                }}
                autoFocus
              />
            </Field>
          )}

          {error && mode === 'balance' && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}

          <p className="text-xs text-muted">
            You will be taken to PayFast to complete the payment. Your card details are
            never handled by us.
          </p>
        </div>
      </Modal>
    </>
  )
}
