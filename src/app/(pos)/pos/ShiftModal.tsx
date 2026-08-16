'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  CurrencyInput,
  Field,
  Input,
  Modal,
  NumPad,
  NumPadDisplay,
  numPadValue,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  tillShiftStatusAction,
  tillOpenShiftAction,
  tillDrawerMovementAction,
  tillCloseShiftAction,
  type TillShiftStatus,
} from './shiftActions'

/**
 * The drawer, from the till: open a shift, move money, cash up.
 *
 * ── THE COUNT IS BLIND ────────────────────────────────────────────────────
 *
 * The count face shows tender names and empty boxes, never the expected
 * figures — those stay on the server, and `closeShift` does the comparison
 * there. A cashier who can see the target is counting towards a number, and
 * the variance stops meaning anything. When the count lands outside tolerance
 * the server's refusal (which states the variance) is shown, and THEN the
 * explanation box appears — blind count first, explanation second, which is
 * the whole cash-up discipline in one flow.
 *
 * ── ONLINE ONLY, SAID PLAINLY ─────────────────────────────────────────────
 *
 * A shift lives on the server. Offline, this modal refuses with a sentence
 * rather than pretending: sales keep queueing offline regardless, and the
 * shift is opened or closed when the line is back.
 */
export default function ShiftModal({
  open,
  online,
  terminalId,
  pendingSales,
  onClose,
  onShiftChanged,
  onDeclare,
}: {
  open: boolean
  online: boolean
  terminalId: number | null
  /** Outbox depth — a close while sales are still queued is warned about. */
  pendingSales: number
  onClose: () => void
  /** Fires with the open shift's id (or null) so the shell can stash KV.shift. */
  onShiftChanged: (shiftId: number | null) => void
  /**
   * Hands off to the DETAILED cash-up.
   *
   * The quick count below still exists and is still the right tool for a till
   * that just needs to balance and go home. But the ordinary act of cashing up
   * is the full declaration — notes and coin by pile, a supervisor's name on
   * it — so that is what this button offers, and the quick count sits under it.
   */
  onDeclare: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [status, setStatus] = useState<TillShiftStatus | null>(null)
  const [loading, setLoading] = useState(false)

  type Face =
    | { kind: 'home' }
    | { kind: 'movement'; type: 'payout' | 'payin' | 'drop' }
    | { kind: 'count' }
  const [face, setFace] = useState<Face>({ kind: 'home' })

  const [floatEntry, setFloatEntry] = useState('')
  const [amountEntry, setAmountEntry] = useState('')
  const [reason, setReason] = useState('')
  const [counts, setCounts] = useState<Record<number, number>>({})
  const [varianceNote, setVarianceNote] = useState('')
  /** The server's out-of-tolerance refusal — shown, then explained. */
  const [closeRefusal, setCloseRefusal] = useState<string | null>(null)

  function reload() {
    setLoading(true)
    void tillShiftStatusAction(terminalId)
      .then((result) => {
        if ('ok' in result) {
          toast.error(result.error)
          return
        }
        setStatus(result)
        onShiftChanged(result.shift?.id ?? null)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!open || !online) return
    setFace({ kind: 'home' })
    setFloatEntry('')
    setAmountEntry('')
    setReason('')
    setCounts({})
    setVarianceNote('')
    setCloseRefusal(null)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, online])

  function openShiftNow() {
    startTransition(async () => {
      const result = await tillOpenShiftAction(terminalId, numPadValue(floatEntry))
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Shift opened.')
      setFloatEntry('')
      reload()
    })
  }

  function recordMovement(type: 'payout' | 'payin' | 'drop') {
    const shiftId = status?.shift?.id
    if (!shiftId) return
    startTransition(async () => {
      const result = await tillDrawerMovementAction(shiftId, {
        type,
        amount: numPadValue(amountEntry),
        reason,
        terminalId,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(MOVEMENT_DONE[type])
      setAmountEntry('')
      setReason('')
      setFace({ kind: 'home' })
      reload()
    })
  }

  function closeNow() {
    const shiftId = status?.shift?.id
    if (!shiftId) return
    startTransition(async () => {
      const counted = (status?.tenders ?? []).map((t) => ({
        tenderTypeId: t.tenderTypeId,
        amount: counts[t.tenderTypeId] ?? 0,
      }))
      const result = await tillCloseShiftAction(
        shiftId,
        counted,
        varianceNote.trim() || null,
      )
      if (!result.ok) {
        // Out of tolerance: the server states the variance. Show it and open
        // the explanation box — blind count first, explanation second.
        setCloseRefusal(result.error)
        return
      }
      toast.success(
        result.variance === 0
          ? 'Cashed up exactly.'
          : `Cashed up ${result.variance < 0 ? 'short' : 'over'} by ${Math.abs(result.variance).toFixed(2)}.`,
      )
      onShiftChanged(null)
      setFace({ kind: 'home' })
      reload()
    })
  }

  const shift = status?.shift ?? null
  const drawerTenders = (status?.tenders ?? []).filter((t) => t.countsAsDrawerCash)
  const otherTenders = (status?.tenders ?? []).filter((t) => !t.countsAsDrawerCash)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        face.kind === 'movement'
          ? MOVEMENT_TITLES[face.type]
          : face.kind === 'count'
            ? 'Cash up — count the drawer'
            : shift
              ? 'Shift'
              : 'Open a shift'
      }
      footer={
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          Close
        </Button>
      }
    >
      {!online ? (
        <Callout tone="brand" title="Cash management needs the connection">
          Sales keep working offline and queue safely on this till. Open or cash up the shift
          when the line is back.
        </Callout>
      ) : loading && !status ? (
        <p className="py-8 text-center text-sm text-muted">Reading the shift…</p>
      ) : !status ? null : !status.canCashup ? (
        <Callout tone="warning" title="This needs the cash-up right">
          Ask a manager — they can open, move money or cash up under their own PIN.
        </Callout>
      ) : !shift ? (
        /* ── No shift: count the float in, open ─────────────────────────── */
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted">
            Count the float INTO the drawer before trading — a float that is wrong at the
            start makes every variance wrong in the same direction.
            {status.mode === 'user' && ' This shift belongs to you, not to the till.'}
          </p>
          <div className="w-64">
            <NumPadDisplay label="Opening float" value={floatEntry} />
            <NumPad value={floatEntry} onChange={setFloatEntry} />
          </div>
          <Button variant="primary" disabled={pending} onClick={openShiftNow}>
            {pending ? 'Opening…' : 'Open the shift'}
          </Button>
        </div>
      ) : face.kind === 'movement' ? (
        /* ── Money in or out, with the reason the variance report will show ── */
        <div className="flex flex-col items-center gap-4">
          <p className="text-sm text-muted">{MOVEMENT_HINTS[face.type]}</p>
          <div className="w-64">
            <NumPadDisplay label="Amount" value={amountEntry} />
            <NumPad value={amountEntry} onChange={setAmountEntry} />
          </div>
          <Field label="Reason" className="w-full">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={MOVEMENT_PLACEHOLDERS[face.type]}
            />
          </Field>
          {/* Said before the server refuses it: a movement with no reason is a
              variance nobody can explain at close. */}
          <div className="flex w-full justify-between gap-2">
            <Button variant="secondary" disabled={pending} onClick={() => setFace({ kind: 'home' })}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={pending || !reason.trim() || numPadValue(amountEntry) <= 0}
              onClick={() => recordMovement(face.type)}
            >
              {pending ? 'Recording…' : 'Record it'}
            </Button>
          </div>
        </div>
      ) : face.kind === 'count' ? (
        /* ── The blind count ────────────────────────────────────────────── */
        <div className="flex flex-col gap-4">
          {pendingSales > 0 && (
            <Callout tone="warning" title={`${pendingSales} sale${pendingSales === 1 ? '' : 's'} still to send`}>
              The expected figure excludes them — send the outbox before cashing up, or the
              drawer will read over by their whole value.
            </Callout>
          )}
          <p className="text-sm text-muted">
            Count what is THERE — the drawer cash first, then the machine totals for the
            rest. The comparison happens on the server.
          </p>
          {status.tenders.length === 0 && (
            <p className="text-sm text-muted">
              Nothing was taken on this shift. Cashing up records the float only.
            </p>
          )}
          {[...drawerTenders, ...otherTenders].map((t) => (
            <Field
              key={t.tenderTypeId}
              label={`${t.tenderName}${t.countsAsDrawerCash ? ' (in the drawer)' : ''}`}
            >
              <CurrencyInput
                value={counts[t.tenderTypeId] ?? ''}
                onChange={(e) =>
                  setCounts((c) => ({
                    ...c,
                    [t.tenderTypeId]: Number(String(e.target.value).replace(',', '.')) || 0,
                  }))
                }
              />
            </Field>
          ))}
          {closeRefusal && (
            <>
              <Callout tone="danger" title="Outside tolerance">
                {closeRefusal}
              </Callout>
              <Field
                label="Explain the difference"
                hint="Frozen onto the cash-up for the manager to read."
              >
                <Input
                  value={varianceNote}
                  onChange={(e) => setVarianceNote(e.target.value)}
                  placeholder="e.g. paid the window cleaner, no slip"
                />
              </Field>
            </>
          )}
          <div className="flex justify-between gap-2">
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setCloseRefusal(null)
                setFace({ kind: 'home' })
              }}
            >
              Back
            </Button>
            <Button
              variant="danger"
              disabled={pending || (closeRefusal !== null && !varianceNote.trim())}
              onClick={closeNow}
            >
              {pending ? 'Closing…' : 'Close the shift'}
            </Button>
          </div>
        </div>
      ) : (
        /* ── Shift open: the drawer's controls ──────────────────────────── */
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">Shift open</Badge>
            <span className="text-sm text-ink-2">
              {shift.userName} · float {formatMoney(shift.openingFloat)} ·{' '}
              {shift.salesCount} sale{shift.salesCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Button
              variant="secondary"
              size="touch"
              disabled={pending}
              onClick={() => setFace({ kind: 'movement', type: 'payout' })}
            >
              Payout
            </Button>
            <Button
              variant="secondary"
              size="touch"
              disabled={pending}
              onClick={() => setFace({ kind: 'movement', type: 'payin' })}
            >
              Pay in
            </Button>
            <Button
              variant="secondary"
              size="touch"
              disabled={pending}
              onClick={() => setFace({ kind: 'movement', type: 'drop' })}
            >
              Drop to safe
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="danger" disabled={pending} onClick={onDeclare}>
              Cash up this shift
            </Button>
            {/* The old flat count, kept and demoted. A shop that only wants to
                know whether the drawer balances should not be made to count
                every denomination — but it should not be the default either. */}
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setFace({ kind: 'count' })}
            >
              Quick count instead
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

const MOVEMENT_TITLES = {
  payout: 'Payout — money out of the drawer',
  payin: 'Pay in — money into the drawer',
  drop: 'Drop — cash to the safe',
} as const

const MOVEMENT_HINTS = {
  payout: 'Milk, the window cleaner, a COD delivery — money out that is not a sale.',
  payin: 'Extra change from the safe, or money returned to the drawer.',
  drop: 'Skimming excess cash to the safe mid-shift. It still counts toward the shift.',
} as const

const MOVEMENT_PLACEHOLDERS = {
  payout: 'e.g. milk for the kitchen',
  payin: 'e.g. change from the safe',
  drop: 'e.g. lunchtime skim',
} as const

const MOVEMENT_DONE = {
  payout: 'Payout recorded.',
  payin: 'Pay-in recorded.',
  drop: 'Drop recorded.',
} as const
