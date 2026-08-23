'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  ActionTile,
  Badge,
  Button,
  Callout,
  CurrencyInput,
  Field,
  Icons,
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
  tillCloseShiftAction,
  type TillShiftStatus,
} from './shiftActions'

/**
 * The shift, from the till: start one, or cash up.
 *
 * ── WHAT LEFT, AND WHY ────────────────────────────────────────────────────
 *
 * Payout, Pay in and Drop to safe used to be three keys on this dialog's home
 * face. They are quick keys now — see DrawerMovementModal and the three slugs
 * in QUICK_KEY_ACTIONS — because they were at the wrong depth: opening a shift
 * happens once a day, while a payout happens whenever the milk arrives, with
 * somebody waiting at the counter. Two taps and a dialog is enough friction
 * that a cashier postpones it, and a postponed payout is a drawer short at
 * close with nobody able to say why.
 *
 * What is left is the pair of acts that genuinely bracket a day's trading.
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

  /* Two faces since the drawer movements left for their own keys: the home
     board, and the quick count. */
  type Face = { kind: 'home' } | { kind: 'count' }
  const [face, setFace] = useState<Face>({ kind: 'home' })

  const [floatEntry, setFloatEntry] = useState('')
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
      /*
        ── CASHING UP ENDS THIS DIALOG ─────────────────────────────────────

        `onShiftChanged(null)` tells the shell there is no shift, which raises
        OpenTillGate — the full-screen "Open your till" panel with its own float
        pad. This dialog used to stay up in front of it and, having just been
        told the shift is gone, re-render as its OWN no-shift face: two panels
        stacked, both asking for the same float, the top one covering the real
        gate behind it.

        Nothing was broken underneath — either pad opens the shift correctly —
        but a cashier who has just cashed up was shown what looked like a screen
        that had not registered it. The detailed cash-up never had this, because
        it closes itself on sign-off. This is that same ending.

        Closed FIRST, then the shell is told. The other order renders the
        no-shift face for a frame before unmounting, which is the flash this
        exists to remove. The shell clears the flag too (see noteShift) — that
        catches every other route to a closed shift; this one keeps the
        transition clean on the route we know about.
      */
      setFace({ kind: 'home' })
      onClose()
      onShiftChanged(null)
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
        face.kind === 'count'
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
          {/* Payout / Pay in / Drop to safe used to sit here as three keys.
              They are quick keys now — arranged on the shop's own board, one
              press from the sale rather than two taps inside this dialog. See
              DrawerMovementModal and the three slugs in QUICK_KEY_ACTIONS.

              What is left is what this dialog is actually for: starting a
              shift and ending one. */}
          {/*
            ── TWO TILES, NOT TWO BUTTONS ────────────────────────────────────

            These are the till's own surface, so they wear the till's own tile.
            A pair of kit buttons is the right control on a form, where the
            labels are short and the reader already knows what both of them do.
            This is a choice between two acts that differ in a way the captions
            alone cannot carry — one ENDS the shift, the other leaves it open —
            and a cashier meeting the pair for the first time is reading the
            hint, not the caption. `ActionTile` is the kit's shape for exactly
            that: a glyph to find it by, a caption, and a line underneath
            saying what pressing it will do.

            It also puts this dialog in the same visual language as the board
            behind it, where Cash up is already a tile wearing the same Coins
            disc — the key on the counter and the choice inside the dialog it
            opens should not look like two unrelated kinds of control.
          */}
          <div className="flex flex-col gap-2.5">
            <ActionTile
              title="Cash up this shift"
              hint="Count the drawer pile by pile, sign it off, and close the shift."
              icon={<Icons.Coins size={22} />}
              /* Rose, and the same Coins glyph the `cashup` quick key wears —
                 see QUICK_KEY_ACTIONS. Warm rather than the flat danger red a
                 Button painted across the whole width: this is the ordinary
                 end of a day's trading, not something to be talked out of, but
                 it is still the one act on this face that cannot be undone. */
              tone="rose"
              disabled={pending}
              onClick={onDeclare}
            />
            {/* The old flat count, kept and demoted. A shop that only wants to
                know whether the drawer balances should not be made to count
                every denomination — but it should not be the default either.
                Demoted by its TONE now rather than by being a ghost button:
                slate beside rose still reads as the quieter of the two, and a
                tile keeps room for the sentence that is the whole difference
                between them. */}
            <ActionTile
              title="Quick count instead"
              hint="One figure per tender, just to check the drawer balances. The shift stays open."
              icon={<Icons.Clock size={22} />}
              tone="slate"
              disabled={pending}
              onClick={() => setFace({ kind: 'count' })}
            />
          </div>
        </div>
      )}
    </Modal>
  )
}

/* The MOVEMENT_* word tables moved to DrawerMovementModal with the form they
   label. Deliberately moved rather than copied: two sets of the same sentences
   is how the payout key and the payout dialog come to describe a payout
   differently. */
