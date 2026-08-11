'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Modal,
  Button,
  Field,
  Input,
  NumPad,
  NumPadDisplay,
  numPadValue,
  TouchRow,
  Callout,
  Badge,
  Icons,
  ReasonPicker,
  type PickableReason,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import type { TenderType } from '@/lib/site/tenderTypes'

/**
 * Paying a customer back.
 *
 * ── WHY THIS IS NOT THE TENDER PAD ────────────────────────────────────────
 *
 * It looks like its mirror image and is deliberately not built as one. A refund has no
 * change to give, no vouchers to spend, no loyalty to redeem and no cash rounding — and
 * the tender pad's hardest logic is exactly those four things and the order they apply
 * in. Reusing it would mean a `refund` flag threaded through every one of them, in the
 * one component where a mistake pays out the wrong amount.
 *
 * What IS shared is the money vocabulary: a refund line records what was handed BACK,
 * per method, and the sum must not exceed the credit. That rule is asserted here and
 * again by `createCreditNote` server-side, which is the one that counts.
 *
 * ── THE RULES THIS SCREEN GETS RIGHT ──────────────────────────────────────
 *
 *   1. NOT EVERY METHOD CAN BE REFUNDED. `allowsRefund` is a per-tender setting, and a
 *      card refund at the till is exactly the thing many shops forbid — it goes back
 *      through the bank instead. Methods that cannot be refunded are not shown, with the
 *      reason said once rather than per row.
 *
 *   2. A REASON IS REQUIRED, and it is a CODE. `createCreditNote` refuses a missing one,
 *      so collecting it here is the difference between a cashier fixing it in three
 *      seconds and a return that is rejected at sync, after the cash is gone. It is
 *      picked from the shop's own list rather than typed, because typed reasons cannot
 *      be added up — "faulty" and "Faulty" were two different reasons, and the question
 *      the field exists to answer went unanswered. The typed note survives beside it,
 *      for the reasons whose code does not say enough on its own.
 *
 *   3. REFUNDING LESS THAN THE CREDIT IS LEGITIMATE. The remainder stays on the
 *      customer's account, which is what happens when somebody wants a credit note
 *      rather than cash. So "Done" is enabled below the full amount — with the
 *      difference named, so nobody does it by accident.
 */

type Given = { tenderTypeId: number; amount: number; reference?: string | null }

export function RefundPad({
  open,
  onClose,
  tenders,
  totalIncl,
  hasCustomer,
  reasons,
  pending,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  tenders: TenderType[]
  /** What the return is worth, positive. */
  totalIncl: number
  /**
   * Whether an account is attached.
   *
   * Decides whether an under-refund is offerable at all: with no customer there is no
   * account for the remainder to sit on, so the shop would be keeping money with no
   * record of owing it.
   */
  hasCustomer: boolean
  /** The site's return reasons, active ones only. */
  reasons: PickableReason[]
  pending: boolean
  onConfirm: (
    given: Given[],
    reason: { reasonId: number; note: string | null },
  ) => void
}) {
  const [given, setGiven] = useState<Given[]>([])
  const [active, setActive] = useState<TenderType | null>(null)
  /** The pad's live value — a decimal STRING, never a number. See NumPad. */
  const [entry, setEntry] = useState('')
  const [reference, setReference] = useState('')
  const [reasonId, setReasonId] = useState<number | null>(null)
  const [note, setNote] = useState('')

  // Reset between returns, so the next customer never inherits the last one's
  // half-entered refund or, worse, their reason.
  useEffect(() => {
    if (!open) return
    setGiven([])
    setActive(null)
    setEntry('')
    setReference('')
    setReasonId(null)
    setNote('')
  }, [open])

  /*
   * Only what may actually be refunded at a till.
   *
   * Filtered rather than disabled-with-a-tooltip: a greyed key on a touch screen invites
   * a tap and then explains itself, which at a counter with a customer waiting is worse
   * than not offering it. The reason appears once, below.
   */
  const refundable = useMemo(() => tenders.filter((t) => t.allowsRefund), [tenders])
  const blocked = useMemo(() => tenders.filter((t) => !t.allowsRefund), [tenders])

  const handedBack = round(
    given.reduce((sum, g) => sum + g.amount, 0),
    2,
  )
  const remaining = round(Math.max(0, totalIncl - handedBack), 2)
  const over = round(handedBack - totalIncl, 2)

  function add() {
    if (!active) return
    const typed = numPadValue(entry)
    /* Default to what is still owed rather than to zero. The overwhelming case is one
       method for the whole amount, and making that a tap instead of six keystrokes is
       most of what a till is for. */
    const amount = typed > 0 ? typed : remaining
    if (amount <= 0) return

    setGiven((rows) => [
      ...rows,
      { tenderTypeId: active.id, amount, reference: reference.trim() || null },
    ])
    setActive(null)
    setEntry('')
    setReference('')
  }

  const reasonMissing = reasonId === null
  /* Over-refunding is refused HERE as well as server-side. createCreditNote checks it
     too, but by then the cash is counted out — a refusal at sync is a shortage nobody
     can explain. */
  const canConfirm = given.length > 0 && over <= 0.005 && !reasonMissing && !pending

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Refund"
      description={`${formatMoney(totalIncl)} to pay back`}
      size="lg"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <Button variant="ghost" size="touch" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <div className="flex items-center gap-3">
            {/*
              WHY Done is unavailable, in the footer beside it.
              A disabled primary button on a dark panel still reads as solid — the
              variant dims to 40% but 40% of a bright colour over a dark surface looks
              live — so a cashier taps it and nothing happens. Saying what is missing
              costs one line and turns a dead button into an instruction. Verified in a
              browser: this was the one thing the screenshot showed that the assertions
              could not.
            */}
            {!canConfirm && !pending && (
              <span className="text-sm text-muted">
                {given.length === 0
                  ? 'Choose how the money goes back'
                  : reasonMissing
                    ? 'Add a reason'
                    : over > 0.005
                      ? 'Too much — take a line off'
                      : ''}
              </span>
            )}
            {/* Named, not hidden. An under-refund is legitimate — the remainder sits on
                the account — but it must never happen without the cashier seeing it. */}
            {canConfirm && remaining > 0.005 && (
              <span className="text-sm text-muted">
                {formatMoney(remaining)}{' '}
                {hasCustomer ? 'stays on the account' : 'not paid back'}
              </span>
            )}
            <Button
              variant="success"
              size="touch-lg"
              onClick={() =>
                reasonId !== null && onConfirm(given, { reasonId, note: note.trim() || null })
              }
              disabled={!canConfirm}
            >
              <Icons.Check size={20} />
              Done
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        {/* ── Left: what has been handed back ──────────────────────────── */}
        <div className="space-y-3">
          <ReasonPicker
            reasons={reasons}
            value={reasonId}
            note={note}
            onChange={setReasonId}
            onNoteChange={setNote}
            label="Why is it coming back?"
            hint="Kept for the audit trail, and what a returns report groups by."
            error={reasonMissing && given.length > 0 ? 'A return needs a reason.' : undefined}
            disabled={pending}
          />

          {given.length === 0 ? (
            <p className="text-sm text-muted">Choose how the money is going back.</p>
          ) : (
            <ul className="space-y-2">
              {given.map((g, i) => {
                const type = tenders.find((t) => t.id === g.tenderTypeId)
                return (
                  <li key={i}>
                    <TouchRow
                      title={type?.name ?? 'Payment'}
                      subtitle={g.reference ?? undefined}
                      trailing={
                        <span className="flex items-center gap-2">
                          <span className="numeric text-base font-semibold text-ink">
                            {formatMoney(g.amount)}
                          </span>
                          <Icons.Trash size={18} className="text-danger" />
                        </span>
                      }
                      showChevron={false}
                      onClick={() => setGiven((rows) => rows.filter((_, n) => n !== i))}
                    />
                  </li>
                )
              })}
            </ul>
          )}

          {/* The one figure that must never be wrong. */}
          <div className="flex items-baseline justify-between border-t border-border pt-3">
            <span className="text-sm text-muted">Still to pay back</span>
            <span className="numeric text-2xl font-semibold text-ink">
              {formatMoney(remaining)}
            </span>
          </div>
          {over > 0.005 && (
            <Callout tone="danger">
              That is {formatMoney(over)} more than the return is worth. Take a line off.
            </Callout>
          )}
        </div>

        {/* ── Right: how ───────────────────────────────────────────────── */}
        <div className="space-y-3">
          {active ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-base font-medium text-ink">{active.name}</span>
                <Button variant="ghost" size="sm" onClick={() => setActive(null)}>
                  Change
                </Button>
              </div>
              <NumPadDisplay label={`${active.name} — amount handed back`} value={entry} />
              <NumPad value={entry} onChange={setEntry} disabled={pending} />
              {active.requiresReference && (
                <Field label="Reference">
                  <Input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="Card slip, transfer ref..."
                    size="touch"
                  />
                </Field>
              )}
              <Button variant="primary" size="touch" className="w-full" onClick={add}>
                Add {formatMoney(numPadValue(entry) > 0 ? numPadValue(entry) : remaining)}
              </Button>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                {refundable.map((t) => (
                  <Button
                    key={t.id}
                    variant="secondary"
                    size="touch"
                    onClick={() => setActive(t)}
                    disabled={remaining <= 0.005}
                  >
                    {t.name}
                  </Button>
                ))}
              </div>
              {refundable.length === 0 && (
                <Callout tone="warning">
                  No payment method here can be refunded at the till. Pay this back through
                  the bank, or turn on refunds for a method in Setup → Payment methods.
                </Callout>
              )}
              {/* Said ONCE, listing what is excluded — rather than a greyed key per
                  method, which invites a tap and then explains itself. */}
              {blocked.length > 0 && refundable.length > 0 && (
                <p className="text-xs text-muted">
                  {blocked.map((t) => t.name).join(', ')}{' '}
                  {blocked.length === 1 ? 'cannot' : 'cannot'} be refunded at the till —
                  those go back through the bank.
                </p>
              )}
              {remaining <= 0.005 && given.length > 0 && (
                <Badge tone="success">The full amount is accounted for.</Badge>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
