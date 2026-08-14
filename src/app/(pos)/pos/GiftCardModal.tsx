'use client'

import { useState, useTransition } from 'react'
import { Button, CurrencyInput, Field, Icons, Input, Modal } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { TillProduct } from '@/lib/site/tillSearch'
import { lookupGiftCardAction, issueGiftCardCodeAction } from './giftCardActions'

/**
 * Selling a gift card: capture the card and the amount BEFORE the line exists.
 *
 * The code is checked server-side on entry — a card already active, cancelled
 * or spent is refused here, at the counter, rather than at finalise with the
 * customer's bags packed. The server checks again inside the finalise
 * transaction regardless; this is the courtesy pass.
 *
 * "No card to scan" mints a fresh pending code for shops selling the concept
 * rather than the plastic — the code prints on the slip.
 */
/**
 * The balance-enquiry prompt behind the quick key: a code in, an answer out,
 * no sale involved. Reuses the same lookup as the tender pad, so the two can
 * never disagree about what a card holds.
 */
export function GiftCardBalanceModal({ onClose }: { onClose: () => void }) {
  const [entry, setEntry] = useState('')
  const [answer, setAnswer] = useState<{ display: string; balance: number; expiresOn: string | null } | null>(null)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()

  function check() {
    if (!entry.trim()) return
    start(async () => {
      const result = await lookupGiftCardAction(entry, 'redeem')
      if (!result.ok) {
        setError(result.error)
        setAnswer(null)
        return
      }
      setError('')
      setAnswer({ display: result.display, balance: result.balance, expiresOn: result.expiresOn })
    })
  }

  return (
    <Modal open onClose={onClose} title="Gift card balance">
      <div className="space-y-4">
        <Field label="Card number" hint="Scan or type the card." error={error || undefined}>
          <Input
            autoFocus
            value={entry}
            placeholder="XXXX-XXXX-XXXX"
            onChange={(e) => {
              setEntry(e.target.value)
              setAnswer(null)
              setError('')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') check()
            }}
          />
        </Field>

        {answer && (
          <div className="rounded-card border border-success/40 bg-success-soft px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-success-ink">Card {answer.display}</span>
              <span className="numeric text-2xl font-extrabold text-success-ink">
                {formatMoney(answer.balance)}
              </span>
            </div>
            {answer.expiresOn && (
              <p className="mt-0.5 text-xs text-success-ink/80">Valid until {answer.expiresOn}</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" onClick={check} disabled={busy || !entry.trim()}>
            {busy ? 'Checking…' : 'Check'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function GiftCardModal({
  product,
  onConfirm,
  onCancel,
}: {
  product: TillProduct
  onConfirm: (card: { code: string; display: string; amount: number }) => void
  onCancel: () => void
}) {
  const [entry, setEntry] = useState('')
  const [checked, setChecked] = useState<{ code: string; display: string } | null>(null)
  const [amount, setAmount] = useState<number>(product.priceIncl > 0 ? product.priceIncl : 0)
  const [error, setError] = useState('')
  const [busy, start] = useTransition()

  function check(raw: string) {
    if (!raw.trim()) return
    start(async () => {
      const result = await lookupGiftCardAction(raw, 'sell')
      if (!result.ok) {
        setError(result.error)
        setChecked(null)
        return
      }
      setError('')
      setChecked({ code: result.code, display: result.display })
    })
  }

  function mint() {
    start(async () => {
      const result = await issueGiftCardCodeAction()
      if (!result.ok) {
        setError(result.error)
        return
      }
      setError('')
      setEntry(result.display)
      setChecked({ code: result.code, display: result.display })
    })
  }

  const valid = checked !== null && Number.isFinite(amount) && amount > 0

  return (
    <Modal open onClose={onCancel} title="Sell a gift card">
      <div className="space-y-4">
        <Field
          label="Card number"
          hint="Scan or type the card, then press Enter to check it."
          error={error || undefined}
        >
          <Input
            autoFocus
            value={entry}
            placeholder="XXXX-XXXX-XXXX"
            onChange={(e) => {
              setEntry(e.target.value)
              setChecked(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') check(entry)
            }}
            onBlur={() => {
              if (entry.trim() && !checked) check(entry)
            }}
          />
        </Field>

        <div className="flex items-center justify-between gap-2">
          {checked ? (
            <span className="text-sm text-success-ink">
              <Icons.Check size={14} className="mr-1 inline align-text-bottom" />
              Card {checked.display} is ready to sell.
            </span>
          ) : (
            <span className="text-sm text-muted">No card checked yet.</span>
          )}
          <Button variant="ghost" size="sm" onClick={mint} disabled={busy}>
            No card to scan — issue a code
          </Button>
        </div>

        <Field label="Amount on the card" hint="The customer pays this; the card holds it.">
          <CurrencyInput
            value={amount || ''}
            onChange={(e) => setAmount(Number(e.target.value) || 0)}
            className="text-right"
          />
        </Field>

        {valid && (
          <div className="flex justify-between rounded-control bg-surface-2 px-3 py-2 text-sm">
            <span className="text-muted">This line</span>
            <span className="numeric text-ink">{formatMoney(amount)}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="success"
            disabled={!valid || busy}
            onClick={() => checked && onConfirm({ ...checked, amount })}
          >
            Add to sale
          </Button>
        </div>
      </div>
    </Modal>
  )
}
