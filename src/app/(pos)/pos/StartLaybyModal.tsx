'use client'

import { useEffect, useState } from 'react'
import {
  Modal,
  Button,
  Field,
  Input,
  CurrencyInput,
  Select,
  Callout,
  Icons,
  SummaryList,
  SummaryRow,
  SummaryTotal,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import { laybyTendersAction } from './laybyActions'

type Tender = { id: number; name: string; countsAsDrawerCash: boolean }

/**
 * Putting the basket aside as a lay-by.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────
 *
 * A customer picks four things off the shelf, cannot pay today, and asks the
 * shop to hold them. The cashier has already rung them up — the basket IS the
 * lay-by, and the alternative is keying every line again on another screen with
 * the customer watching.
 *
 * ── WHY THE CUSTOMER IS REQUIRED AND THE DEPOSIT IS NOT ───────────────────
 *
 * A lay-by is goods held for a NAMED person, for weeks, against money they
 * have not finished paying. "Walk-in" cannot come back and claim it, so the
 * customer is the one thing this refuses without.
 *
 * A deposit is the opposite: the law does not require one, and some shops do
 * not take one. It defaults to nothing rather than to a percentage nobody
 * asked for, and the shop's own habit is expressed by what the cashier types.
 */
export function StartLaybyModal({
  open,
  onClose,
  onStart,
  customerName,
  totalIncl,
  lineCount,
  defaultDueDate,
  busy,
}: {
  open: boolean
  onClose: () => void
  onStart: (input: {
    deposit: { amount: number; tenderTypeId: number } | null
    dueDate: string | null
  }) => void
  /** Null when no account is attached — which this refuses to proceed without. */
  customerName: string | null
  totalIncl: number
  lineCount: number
  /** Today plus the shop's `layby_default_days`, resolved by the server page. */
  defaultDueDate: string | null
  busy: boolean
}) {
  const [tenders, setTenders] = useState<Tender[]>([])
  const [deposit, setDeposit] = useState(0)
  const [tenderId, setTenderId] = useState<number | null>(null)
  const [dueDate, setDueDate] = useState(defaultDueDate ?? '')

  useEffect(() => {
    if (!open) return
    laybyTendersAction()
      .then((rows) => {
        setTenders(rows)
        setTenderId((current) => current ?? rows[0]?.id ?? null)
      })
      .catch(() => setTenders([]))
  }, [open])

  /* A fresh dialog every time. A deposit amount left over from the last
     customer is money on the wrong lay-by. */
  useEffect(() => {
    if (open) return
    setDeposit(0)
    setDueDate(defaultDueDate ?? '')
  }, [open, defaultDueDate])

  const outstanding = round(Math.max(totalIncl - deposit, 0), 2)
  const tooMuch = deposit > totalIncl + 0.004

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Put this aside as a lay-by"
      description={`${lineCount} line${lineCount === 1 ? '' : 's'} · ${formatMoney(totalIncl)}`}
      size="md"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button variant="secondary" size="touch" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="success"
            size="touch"
            disabled={busy || !customerName || tooMuch || (deposit > 0 && !tenderId)}
            onClick={() =>
              onStart({
                deposit: deposit > 0 && tenderId ? { amount: deposit, tenderTypeId: tenderId } : null,
                dueDate: dueDate.trim() || null,
              })
            }
          >
            <Icons.Package size={18} />
            {deposit > 0 ? `Open it and take ${formatMoney(deposit)}` : 'Open it'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/*
          THE ONE THING IT REFUSES WITHOUT.

          Said here rather than left to a failed round trip: the customer key is
          on the screen behind this dialog, and a cashier told now can close
          this, attach the account and come straight back with the basket intact.
        */}
        {!customerName ? (
          <Callout tone="warning" title="Attach the customer first">
            A lay-by is goods held for a named person, sometimes for months. Close this, tap
            Customer on the sale, then put it aside.
          </Callout>
        ) : (
          <Callout tone="brand" title={`Held for ${customerName}`}>
            Nothing moves off the shelf yet and no VAT is declared. That happens when they collect.
          </Callout>
        )}

        <Field
          label="Deposit"
          hint="What they are putting down today. Leave it at zero if they are paying nothing yet."
          error={tooMuch ? `That is more than the ${formatMoney(totalIncl)} total.` : undefined}
        >
          <CurrencyInput
            value={deposit}
            onChange={(e) =>
              setDeposit(round(Number(String(e.target.value).replace(',', '.')) || 0, 2))
            }
          />
        </Field>

        {/* Only when there is money to attribute. A payment method chosen for a
            deposit of nothing is a question with no consequence. */}
        {deposit > 0 && (
          <Field label="Paid by">
            <Select
              value={tenderId ?? ''}
              onChange={(e) => setTenderId(Number(e.target.value) || null)}
            >
              {tenders.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="To be collected by"
          hint="The shop's usual term, and editable. Blank means no date."
        >
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>

        <SummaryList>
          <SummaryRow label="Goods put aside" value={formatMoney(totalIncl)} />
          <SummaryRow label="Paid today" value={formatMoney(deposit)} />
          <SummaryTotal label="Still to pay" value={formatMoney(outstanding)} />
        </SummaryList>
      </div>
    </Modal>
  )
}
