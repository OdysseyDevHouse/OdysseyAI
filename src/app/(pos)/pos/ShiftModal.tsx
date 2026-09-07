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
import {
  currentShift,
  openShiftOffline,
  type LocalShift,
} from '@/lib/posOffline/shiftOffline'

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
  siteId,
  terminalId,
  operatorUserId,
  operatorName,
  pendingSales,
  pendingMovements = 0,
  onClose,
  onShiftChanged,
  onDeclare,
}: {
  open: boolean
  online: boolean
  /**
   * Whose queue an offline shift joins — and whether offline opening is offered
   * at all.
   *
   * ── OPTIONAL, AND THE ABSENCE IS THE FEATURE ────────────────────────────
   *
   * The till passes these three. The INVOICING counter (InvoicingChrome) reuses
   * this same dialog and cannot: it has no site id and no operator id, because it
   * has no offline sale queue either — there is no posStore keyed to it and
   * nothing that would ever flush one.
   *
   * Queueing a shift there would write a row into a store nothing drains, which
   * is worse than refusing: the counter would believe it had opened a drawer, and
   * the office would never hear about it. So without them the dialog behaves
   * exactly as it did before offline opening existed — one sentence saying to
   * come back when the line is up.
   */
  siteId?: number
  terminalId: number | null
  /**
   * Who is counting the float.
   *
   * Needed only offline, where there is no session for the server to read it
   * from — a queued shift carries its own attribution, exactly as a queued sale
   * does, and the server re-resolves the person on arrival.
   */
  operatorUserId?: number
  operatorName?: string
  /** Outbox depth — a close while sales are still queued is warned about. */
  pendingSales: number
  /**
   * Drawer movements queued and not yet delivered (252).
   *
   * Its own figure and its own warning, because it is wrong in the OPPOSITE
   * direction: queued sales make the drawer read over, a queued payout makes it
   * read short. See the same pair in DeclarationModal.
   */
  pendingMovements?: number
  onClose: () => void
  /**
   * Fires with the shift the till is now on, so the shell can stash KV.shift.
   *
   * `uid` rather than an id for one opened OFFLINE (252), which has no server id
   * until it syncs. Both halves are passed because they describe one drawer: a
   * till holding an id from one shift beside a uid from another would bank its
   * sales into whichever the server resolved first.
   */
  onShiftChanged: (shift: { id: number | null; uid: string | null } | null) => void
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
  /**
   * The shift this till is on when there is no server to ask.
   *
   * Read from the till's own store rather than from `status`, which is a server
   * answer and is null offline. Null means the till is on no drawer — the state
   * this dialog can now do something about.
   */
  const [localShift, setLocalShift] = useState<LocalShift | null>(null)

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
        onShiftChanged(result.shift ? { id: result.shift.id, uid: null } : null)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!open) return
    setFace({ kind: 'home' })
    setFloatEntry('')
    setCounts({})
    setVarianceNote('')
    setCloseRefusal(null)
    /*
     * OFFLINE THIS DIALOG NOW HAS A JOB.
     *
     * It used to return here and show one sentence saying to come back when the
     * line was up. That was honest about cashing up and wrong about OPENING: a
     * shop whose line went down before anybody opened the till could not open one
     * all day, so every sale it took banked into no shift — real invoices, in a
     * real drawer, that no cash-up would ever account for.
     *
     * So the pad is offered offline and the queue takes the shift (252). Cashing
     * up still is not, and never will be: `closeShift` freezes EXPECTED beside
     * counted, and expected is a sum over sales that POSTED — which for this till
     * are sitting in its own outbox.
     */
    if (!online) {
      /* No site id means no offline queue — see the prop's own note. The dialog
         then keeps its old behaviour rather than offering a pad that would write
         into a store nothing drains. */
      if (siteId === undefined) return
      void currentShift(siteId)
        .then((shift) => setLocalShift(shift.id || shift.uid ? shift : null))
        .catch(() => setLocalShift(null))
      return
    }
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, online, siteId])

  function openShiftNow() {
    startTransition(async () => {
      if (!online && siteId !== undefined) {
        /*
         * Queued, and the till starts trading against it immediately.
         *
         * It does NOT check whether a shift is already open on this drawer — it
         * cannot, because that is a fact about the server. `postOfflineShift`
         * settles it on arrival by adopting whatever is already there, which is
         * the only answer that keeps the takings reconcilable, and records the
         * float counted here in the activity log rather than adding it.
         */
        const queued = await openShiftOffline(siteId, {
          terminalId,
          openingFloat: numPadValue(floatEntry),
          operatorUserId: operatorUserId ?? 0,
          operatorName: operatorName ?? '',
        })
        if (!queued.ok) {
          toast.error(queued.error)
          return
        }
        setFloatEntry('')
        setLocalShift({ id: null, uid: queued.shiftUid })
        onShiftChanged({ id: null, uid: queued.shiftUid })
        toast.success('Shift opened on this till. It will reach the office when the line is back.')
        onClose()
        return
      }

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
      /* A counting field per drawer and per other tender — as tall as the
         shop's tender list, which is exactly what the 60vh cap truncated. */
      bodyGrows
      footer={
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          Close
        </Button>
      }
    >
      {!online ? (
        siteId === undefined ? (
          /* A counter with no offline queue. Unchanged from before this feature,
             and deliberately so — see the `siteId` prop's note. */
          <Callout tone="brand" title="Cash management needs the connection">
            Open or cash up the shift when the line is back.
          </Callout>
        ) : localShift ? (
          /* On a shift already — so the only thing missing is the cash-up, and
             saying WHY is the point. "Needs the connection" invites a cashier to
             wait for one; the real reason is that the expected figure is a sum
             over sales this till has not delivered, and no amount of waiting at
             this dialog changes that. */
          <Callout tone="brand" title="Cashing up needs the connection">
            This till is on a shift and sales are queueing against it safely. Cashing up
            compares the drawer with what was rung up, and that sum lives on the server —
            so it waits for the line. Payouts and pay-ins still work.
          </Callout>
        ) : (
          /* ── No shift, no line: count the float in anyway ─────────────── */
          <div className="flex flex-col items-center gap-4">
            <Callout tone="warning" title="This till is on no shift">
              Every sale rung up now would belong to no cash-up. Open one here — it is
              recorded on this till and sends itself when the line is back.
            </Callout>
            <p className="text-sm text-muted">
              Count the float INTO the drawer before trading — a float that is wrong at the
              start makes every variance wrong in the same direction.
            </p>
            <div className="w-64">
              <NumPadDisplay label="Opening float" value={floatEntry} />
              <NumPad value={floatEntry} onChange={setFloatEntry} />
            </div>
            <Button variant="primary" disabled={pending} onClick={openShiftNow}>
              {pending ? 'Opening…' : 'Open the shift'}
            </Button>
          </div>
        )
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
          {pendingMovements > 0 && (
            <Callout
              tone="warning"
              title={`${pendingMovements} drawer movement${pendingMovements === 1 ? '' : 's'} still to send`}
            >
              The expected figure does not know about them yet, so the drawer will read
              SHORT by their value — the opposite way round to the sales above.
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
