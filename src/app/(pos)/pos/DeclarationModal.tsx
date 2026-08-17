'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  Field,
  Input,
  Modal,
  NumPad,
  Select,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_NUMERIC,
  useToast,
} from '@/components/ui'
import { formatMoney, round } from '@/lib/decimals'
import {
  tillDeclarationViewAction,
  tillSupervisorsAction,
  tillRevealTenderAction,
  tillSaveDeclarationAction,
  tillFinalizeDeclarationAction,
} from './shiftActions'
import type { VisibleDeclaration } from '@/app/(app)/sales/cashup/[shiftId]/declare/visible'

/**
 * The detailed cash-up, at the till.
 *
 * ── WHY THIS EXISTS RATHER THAN A LINK ──────────────────────────────────────
 *
 * The same declaration lives in the back office at /sales/cashup/[id]/declare,
 * and sending the cashier there would be wrong twice over: it needs a
 * back-office login the person holding the PIN may not have, and navigating
 * away abandons whatever is on the till screen. A drawer is counted where the
 * drawer is.
 *
 * It is a MODAL and not a route for the same reason everything else at this
 * till is: the POS is one screen that never navigates. The count survives the
 * dialog being closed because the draft is saved server-side on every tender
 * commit — so an interruption mid-count loses nothing, which is the property
 * the back office got from having a URL.
 *
 * ── ONE BOARD, NOT THREE TABS ───────────────────────────────────────────────
 *
 * This used to stack the count into tabs. It is now a single full-width board,
 * because tabs were answering the wrong question: a cashier counting a drawer
 * is not working through three steps in order, they are working across the
 * whole thing at once — counting notes while watching the cash difference,
 * declaring the card slip while the payout total is still on screen. A tab that
 * hides the difference while you enter the number that produces it makes the
 * screen a memory test.
 *
 * The numbered panels are deliberate. A supervisor reads a cash-up out loud
 * over the phone ("what does panel 8 say?"), and the legacy till this replaces
 * numbered them too — so the numbers are the shared vocabulary, not decoration.
 *
 * ── ONE ENGINE, TWO FACES ───────────────────────────────────────────────────
 *
 * Every figure here comes from `declarationView` via the till actions, which
 * reuse the back office's own engine and its `visibleFor` strip. This file owns
 * the LAYOUT and nothing else — no arithmetic, no rules about what may be seen.
 *
 * ── BLIND, THEN REVEALED IN PLACE ───────────────────────────────────────────
 *
 * Expected figures are withheld by the SERVER until a tender is declared, and
 * are asked for on blur — one tender at a time, in exchange for a committed
 * count. A cashier who can see the target is copying rather than counting.
 *
 * So every total panel below has two faces: an em dash before its tender has
 * been declared, the real figure after. The board never rearranges when a
 * figure arrives — the tile is the same size either way — because a layout that
 * reflows mid-count loses the cashier's place in the drawer.
 */

/** Which box the numpad is typing into. */
type Target =
  | { kind: 'denomination'; id: number }
  | { kind: 'tender'; id: number }
  | { kind: 'bank' }
  | null

export default function DeclarationModal({
  open,
  shiftId,
  pendingSales,
  onClose,
  onFinalized,
}: {
  open: boolean
  /** Null while there is no open shift — the dialog simply says so. */
  shiftId: number | null
  /** Outbox depth. A close while sales are queued reads over by their value. */
  pendingSales: number
  onClose: () => void
  /** Fires once the shift is signed off, so the shell can drop its KV.shift. */
  onFinalized: () => void
}) {
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<VisibleDeclaration | null>(null)
  const [supervisors, setSupervisors] = useState<{ id: number; name: string }[]>([])

  const [supervisorId, setSupervisorId] = useState('')
  const [qty, setQty] = useState<Record<number, number>>({})
  const [declared, setDeclared] = useState<Record<number, number | undefined>>({})
  /** Expected figures this browser has EARNED by committing a count. */
  const [revealed, setRevealed] = useState<
    Record<number, { expected: number; floatIncluded: number }>
  >({})
  const [bankDeclared, setBankDeclared] = useState(0)
  const [bankReference, setBankReference] = useState('')
  const [varianceNote, setVarianceNote] = useState('')
  const [note, setNote] = useState('')

  /* ── The numpad's target ──────────────────────────────────────────────────
     The pad types into whichever box was last focused, and `entry` is that
     box's value as a DECIMAL STRING while it is being typed — the same trick
     NumPad itself uses, and for the same reason: a number cannot represent
     "5." or a trailing zero mid-entry. It is parsed on commit. */
  const [target, setTarget] = useState<Target>(null)
  const [entry, setEntry] = useState('')

  /* Loaded on open rather than held: a shift's takings move with every sale,
     so a view cached from the last time this was opened would be counting
     against a stale target. */
  useEffect(() => {
    if (!open || shiftId === null) return
    setTarget(null)
    setEntry('')
    setLoading(true)
    void Promise.all([tillDeclarationViewAction(shiftId), tillSupervisorsAction()])
      .then(([result, people]) => {
        if ('ok' in result) {
          toast.error(result.error)
          return
        }
        setView(result)
        setSupervisorId(
          Array.isArray(people)
            ? (people.find((s) => s.name === result.supervisorName)?.id?.toString() ?? '')
            : '',
        )
        setSupervisors(Array.isArray(people) ? people : [])
        /* Seeded from the stored draft so a resumed count shows the work
           already done rather than an empty grid somebody has to redo. */
        setQty(Object.fromEntries(result.counted.map((c) => [c.denominationId, c.qty])))
        setDeclared(
          Object.fromEntries(
            result.tenders
              .filter((t) => t.declared !== null)
              .map((t) => [t.tenderTypeId, t.declared!]),
          ),
        )
        setRevealed(
          Object.fromEntries(
            result.tenders
              .filter((t) => t.expected !== null)
              .map((t) => [
                t.tenderTypeId,
                { expected: t.expected!, floatIncluded: t.floatIncluded ?? 0 },
              ]),
          ),
        )
        setBankDeclared(result.bankDeclared)
        setBankReference(result.bankReference ?? '')
        setVarianceNote(result.varianceNote ?? '')
        setNote(result.note ?? '')
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shiftId])

  /* Derived on every keystroke rather than stored: a total the cashier can edit
     independently of the counts under it is a figure that can silently
     disagree with them. */
  const declaredCash = useMemo(
    () =>
      (view?.denominations ?? []).reduce(
        (sum, d) => round(sum + d.value * (qty[d.id] ?? 0), 2),
        0,
      ),
    [qty, view],
  )

  /* `every` over an empty list is TRUE, which on a shift that took nothing read
     as "every tender is declared" and put a confident green "Balanced R0.00" on
     screen before anybody had opened the drawer. A shift with no tenders has
     nothing to reconcile, so it has no variance either. */
  const everyTenderDeclared =
    view !== null &&
    view.tenders.length > 0 &&
    view.tenders.every((t) => declared[t.tenderTypeId] !== undefined)

  const liveVariance = useMemo(() => {
    if (!view || !everyTenderDeclared) return null
    if (view.tenders.some((t) => revealed[t.tenderTypeId] === undefined)) return null
    return view.tenders.reduce(
      (sum, t) =>
        round(sum + ((declared[t.tenderTypeId] ?? 0) - revealed[t.tenderTypeId].expected), 2),
      0,
    )
  }, [view, declared, revealed, everyTenderDeclared])

  const outside = liveVariance !== null && view !== null && Math.abs(liveVariance) > view.tolerance

  function input() {
    return {
      supervisorId: supervisorId ? Number(supervisorId) : null,
      supervisorName: supervisors.find((s) => s.id.toString() === supervisorId)?.name ?? '',
      denominations: qty,
      tenders: Object.fromEntries(
        Object.entries(declared)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [Number(k), v as number]),
      ),
      bankDeclared,
      bankReference: bankReference.trim() || null,
      varianceNote: varianceNote.trim() || null,
      note: note.trim() || null,
    }
  }

  /**
   * Commits one tender and asks for its expected figure in exchange.
   *
   * On BLUR rather than per keystroke: revealing while somebody is still typing
   * hands them the target half way through entering their own number, which is
   * the copying the blind count exists to prevent.
   */
  const commitTender = useCallback(
    (tenderTypeId: number, value: number | undefined, counts: Record<number, number>) => {
      if (shiftId === null || value === undefined) return
      /* Already revealed: the draft still needs the new figure saved, but the
         expected one must not be asked for twice — the reveal is a one-way
         door and re-asking would let a cashier probe it by retyping. */
      if (revealed[tenderTypeId]) return
      startTransition(async () => {
        const result = await tillRevealTenderAction(shiftId, tenderTypeId, value, counts)
        if (!result.ok) {
          toast.error(result.error)
          return
        }
        setRevealed((r) => ({
          ...r,
          [tenderTypeId]: { expected: result.expected, floatIncluded: result.floatIncluded },
        }))
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shiftId, revealed],
  )

  /* ── Numpad plumbing ──────────────────────────────────────────────────────
     `commit` writes the typed string into whichever box owns it and clears the
     entry. Called on Enter, and on focus moving to another box — so a cashier
     who taps straight from one denomination to the next never loses the figure
     they just typed. */
  const commit = useCallback(
    (t: Target, raw: string) => {
      if (!t || raw === '') return
      const trimmed = raw.endsWith('.') ? raw.slice(0, -1) : raw
      const n = Number(trimmed)
      if (!Number.isFinite(n)) return

      if (t.kind === 'denomination') {
        setQty((q) => ({ ...q, [t.id]: Math.max(0, Math.floor(n)) }))
      } else if (t.kind === 'tender') {
        const value = round(n, 2)
        setDeclared((d) => ({ ...d, [t.id]: value }))
        /* The count grid as it stands right now — commitTender saves the draft
           alongside the reveal, and a stale `qty` here would persist a count
           the cashier has already corrected. */
        setQty((q) => {
          commitTender(t.id, value, q)
          return q
        })
      } else {
        setBankDeclared(round(n, 2))
      }
    },
    [commitTender],
  )

  /** Focus moved, or Enter pressed: bank what was typed, then aim at the new box. */
  const aim = useCallback(
    (next: Target, seed = '') => {
      setTarget((current) => {
        setEntry((typed) => {
          if (current && typed !== '') commit(current, typed)
          return seed
        })
        return next
      })
    },
    [commit],
  )

  /* Enter commits and drops to the next denomination down, which is how a
     drawer is actually counted — R200s, then R100s, then R50s, without ever
     reaching for the mouse. */
  const denominationOrder = useMemo(
    () => (view?.denominations ?? []).map((d) => d.id),
    [view],
  )

  const onEnter = useCallback(() => {
    setTarget((current) => {
      setEntry((typed) => {
        if (current && typed !== '') commit(current, typed)
        return ''
      })
      if (current?.kind !== 'denomination') return current
      const at = denominationOrder.indexOf(current.id)
      const next = denominationOrder[at + 1]
      return next === undefined ? current : { kind: 'denomination', id: next }
    })
  }, [commit, denominationOrder])

  /* Enter is the pad's own key and belongs to it, not the dialog — a cash-up is
     not a form that submits, and letting Enter fall through to the footer would
     put "Finalize" one stray keypress away mid-count. */
  useEffect(() => {
    if (!open || target === null) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Enter') return
      event.preventDefault()
      onEnter()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, target, onEnter])

  function saveNow() {
    if (shiftId === null) return
    startTransition(async () => {
      const result = await tillSaveDeclarationAction(shiftId, input())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
    })
  }

  function finalizeNow() {
    if (shiftId === null) return
    startTransition(async () => {
      const result = await tillFinalizeDeclarationAction(shiftId, input())
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.variance === 0
          ? 'Cashed up exactly.'
          : `Cashed up ${result.variance < 0 ? 'short' : 'over'} by ${Math.abs(result.variance).toFixed(2)}.`,
      )
      onFinalized()
      onClose()
    })
  }

  const signed = view?.finalizedAt != null

  /*
   * The totals tiles, numbered in one pass.
   *
   * Panels 1–4 are fixed and always render, so these continue from 5. Computing
   * the numbers here rather than as arithmetic at each call site is what stops
   * a gap appearing: a shift with no cash tender used to skip straight from 4
   * to 6, and a supervisor reading "panel 6" down the phone would be pointing
   * at a panel the other person could not find.
   *
   * Cash leads because it is the tender the drawer in front of the cashier
   * actually holds; the machine-settled ones follow in the order the site
   * defined them.
   */
  const totalsPanels = useMemo(() => {
    const tenders = view?.tenders ?? []
    const ordered = [
      ...tenders.filter((t) => t.countsAsDrawerCash),
      ...tenders.filter((t) => !t.countsAsDrawerCash),
    ]
    return ordered.map((t, i) => ({
      tenderTypeId: t.tenderTypeId,
      n: 5 + i,
      title: t.countsAsDrawerCash ? 'Cash totals' : `${t.tenderName} totals`,
      label: t.tenderName,
      /* Null until this tender has been declared — the tile renders an em dash
         rather than the target the count is meant to test. */
      expected: revealed[t.tenderTypeId]?.expected ?? null,
    }))
  }, [view, revealed])

  const countersPanelNumber = 5 + totalsPanels.length

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="full"
      bodyFills
      title="Cash-up / Cash declaration"
      description={
        view
          ? `${view.ownerLabel} · trading since ${new Date(view.openedAt).toLocaleString('en-ZA')}`
          : undefined
      }
      /* Half-counted work behind a stray click is exactly what this must not
         lose — the draft is saved per tender, but the grid is not. */
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Close
          </Button>
          {view && !signed && (
            <>
              <Button variant="ghost" onClick={saveNow} disabled={pending}>
                Save count
              </Button>
              <Button
                variant="success"
                disabled={
                  pending || !everyTenderDeclared || !supervisorId || (outside && !varianceNote.trim())
                }
                onClick={finalizeNow}
              >
                {pending ? 'Signing off…' : 'Finalize cash-up'}
              </Button>
            </>
          )}
        </>
      }
    >
      {shiftId === null ? (
        <Callout tone="brand" title="No shift is open on this till">
          Open a shift before cashing up — there is nothing to count against yet.
        </Callout>
      ) : loading && !view ? (
        <p className="py-8 text-center text-sm text-muted">Reading the shift…</p>
      ) : !view ? null : signed ? (
        <Callout tone="success" title="This cash-up is signed off">
          Every figure was committed at the time. The back office holds the record.
        </Callout>
      ) : (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {pendingSales > 0 && (
            <Callout
              tone="warning"
              title={`${pendingSales} sale${pendingSales === 1 ? '' : 's'} still to send`}
            >
              The expected figures exclude them — send the outbox before signing off, or the
              drawer will read over by their whole value.
            </Callout>
          )}

          {/* Three columns on a till screen, stacking on anything narrower.
              The left one is the count and never moves; the middle and right
              are what the count is being measured against. */}
          <div className="grid gap-4 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)_minmax(0,1fr)]">
            {/* ── 1 · The drawer, counted by pile ─────────────────────────
                The pad sits BESIDE the grid, not under it. Under it, the pad
                either falls off the bottom of an eleven-row drawer or — made
                sticky to fix that — floats over the very row being counted.
                Side by side, the whole drawer and every key are on screen at
                once, which is the only arrangement where a cashier can work
                down the piles without hunting for either. */}
            <Panel n={1} title="Declare cash by denomination">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {/* The grid takes the room that is left; the pad beside it is a
                  fixed width, so `min-w-0` is what stops the table forcing the
                  pair wider than the column. */}
              <div className="min-w-0 flex-1">
              {/* table-fixed so the three columns divide the width they are
                  GIVEN. Left to itself the table sizes to its content and
                  spills under the pad, which put the Amount column behind the
                  keys — the one figure the count is checked against. */}
              <table className={`${TABLE} table-fixed`}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Denomination</th>
                    {/* Fixed, or the qty inputs are the first thing the browser
                        squeezes when the pad takes its width beside them. */}
                    <th className={`${TABLE_TH} w-24 text-right`}>Qty</th>
                    <th className={`${TABLE_TH} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {view.denominations.map((d) => {
                    const aimed = target?.kind === 'denomination' && target.id === d.id
                    const n = qty[d.id] ?? 0
                    return (
                      <tr key={d.id}>
                        <td className={TABLE_TD}>{d.label}</td>
                        <td className={`${TABLE_TD} text-right`}>
                          {/*
                            A plain Input, deliberately NOT NumberInput.
                            NumberInput keeps its own buffer while focused and
                            ignores `value` until blur — which is right when a
                            keyboard is the only writer, and wrong here: the pad
                            writes to `entry`, so the focused box would go on
                            showing its stale buffer and a touch-only cashier
                            would watch their taps do nothing. This screen
                            already holds the decimal string itself.
                          */}
                          <Input
                            className="numeric w-full min-w-14 text-right"
                            inputMode="numeric"
                            /* While aimed at, the box shows the string being
                               typed — including "1" on the way to "11". */
                            value={aimed ? entry : n === 0 ? '' : String(n)}
                            disabled={pending}
                            onFocus={() =>
                              aim({ kind: 'denomination', id: d.id }, n === 0 ? '' : String(n))
                            }
                            onChange={(e) => setEntry(e.target.value.replace(/[^0-9]/g, ''))}
                          />
                        </td>
                        {/* Zero stays faint: a column of 0.00 competes with the
                            three rows that actually hold money. */}
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${n === 0 ? 'text-faint' : ''}`}>
                          {formatMoney(round(d.value * n, 2))}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* The running total belongs under the grid it sums, not beside
                  the pad — it is the answer to the counting, not part of it. */}
              <div className="mt-3 flex items-baseline justify-between rounded-card bg-warning-soft px-4 py-3">
                <span className="text-sm font-medium text-ink">Total cash (declared)</span>
                <span className="numeric text-xl font-bold text-ink">
                  {formatMoney(declaredCash)}
                </span>
              </div>
              </div>

              {/* `sm:w-48` and not a fraction: a numpad's keys want a stable
                  size under the thumb, and a percentage width would resize them
                  every time the column did. */}
              <div className="shrink-0 sm:w-48">
                <NumPad
                  value={entry}
                  onChange={setEntry}
                  /* Whole numbers when counting a pile of notes, decimals when
                     declaring a machine slip. The pad reshapes to its target. */
                  maxDecimals={target?.kind === 'denomination' ? 0 : 2}
                  disabled={pending || target === null}
                />
                <Button
                  variant="primary"
                  size="touch"
                  className="mt-2 w-full"
                  disabled={pending || target === null}
                  onClick={onEnter}
                >
                  Enter
                </Button>
                <p className="mt-2 text-xs text-muted">
                  {target === null
                    ? 'Tap a box to start counting — the pad types into it.'
                    : 'Enter drops to the next row down.'}
                </p>
              </div>
              </div>
            </Panel>

            {/* ── The middle column: what was taken, and the banking ────── */}
            <div className="flex flex-col gap-4">
              <Panel n={2} title="Declare each tender">
                <p className="mb-3 text-sm text-muted">
                  The drawer for cash, the machine&rsquo;s own slip for card. What was expected
                  appears once you have committed your figure.
                </p>
                {/*
                  "Nothing was taken" is only true if nothing was taken.

                  `view.tenders` is built from sales tenders alone, so a shift
                  that took a lay-by deposit and rang up no sale showed this
                  beside a drawer holding the deposit — telling a cashier to
                  expect the float when the right answer was the float plus it.
                  The same fix as the back office's declaration screen; this is
                  the copy a cashier actually reads, and now that the till can
                  take lay-by payments it is the one that would be wrong.
                */}
                {view.tenders.length === 0 && (
                  <p className="text-sm text-muted">
                    {view.offLedgerCash !== 0 ? (
                      <>
                        No sale was rung up on this shift, but{' '}
                        <span className="numeric font-semibold text-ink">
                          {formatMoney(view.offLedgerCash)}
                        </span>{' '}
                        came in against lay-bys and deposits. Count the drawer for the float and
                        that.
                      </>
                    ) : (
                      'Nothing was taken on this shift. Signing off records the float only.'
                    )}
                  </p>
                )}
                <div className="flex flex-col gap-3">
                  {view.tenders.map((tender) => {
                    const aimed = target?.kind === 'tender' && target.id === tender.tenderTypeId
                    const value = declared[tender.tenderTypeId]
                    return (
                      <Field
                        key={tender.tenderTypeId}
                        label={tender.tenderName}
                        hint={
                          tender.countsAsDrawerCash
                            ? 'The drawer, including the float.'
                            : 'What the machine or bank reports.'
                        }
                      >
                        {/* Plain Input for the same reason as the grid above —
                            the pad is the writer, so the box must render
                            `entry` rather than a buffer of its own. Blurred, it
                            shows the committed figure at two decimals. */}
                        <Input
                          className="numeric text-right"
                          inputMode="decimal"
                          value={
                            aimed ? entry : value === undefined ? '' : value.toFixed(2)
                          }
                          /* "Not counted", never "0.00" — a blank box must not
                             look declared before anybody has counted it. */
                          placeholder="Not counted"
                          disabled={pending}
                          onFocus={() =>
                            aim(
                              { kind: 'tender', id: tender.tenderTypeId },
                              value === undefined ? '' : String(value),
                            )
                          }
                          onChange={(e) =>
                            setEntry(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))
                          }
                          onBlur={() => {
                            if (!aimed || entry === '') return
                            commit({ kind: 'tender', id: tender.tenderTypeId }, entry)
                          }}
                        />
                      </Field>
                    )
                  })}
                </div>
                {declaredCash > 0 && (
                  <p className="mt-3 text-xs text-muted">
                    The denomination grid totals {formatMoney(declaredCash)}.
                  </p>
                )}
              </Panel>

              <Panel n={3} title="Other transactions">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <Figure label="Opening float" value={view.openingFloat} />
                  <Figure label="Payouts" value={-view.payoutsTotal} />
                  <Figure label="Pay-ins" value={view.payinsTotal} />
                  <Figure label="Drops to safe" value={-view.dropsTotal} />
                  <Figure label="Refunds" value={-view.refundsTotal} />
                  {/* The 5c the drawer legitimately does not hold. */}
                  <Figure label="Rounding" value={view.roundingTotal} />
                  <Figure label="Tips" value={view.tipsTotal} />
                  <Figure label="Lay-buy deposits" value={view.laybyDeposits} />
                  <Figure label="Lay-buy instalments" value={view.laybyPayments} />
                  <Figure label="Sale deposits" value={view.saleDepositsTaken} />
                  {view.saleDepositsRefunded > 0 && (
                    <Figure label="Deposits refunded" value={-view.saleDepositsRefunded} />
                  )}
                  <Figure label="Gift cards sold" value={view.giftCardSold} />
                  <Figure label="Gift cards redeemed" value={-view.giftCardRedeemed} />
                  <Figure label="Loyalty top-ups" value={view.loyaltyWallet} />
                </dl>
              </Panel>

              {/* Banking is its own question: a drawer can reconcile perfectly
                  and still have the wrong amount put in the bag. */}
              <Panel n={4} title="To bank">
                <div className="flex flex-wrap items-end gap-4">
                  <Field label="Bank declared" className="w-40">
                    <Input
                      className="numeric text-right"
                      inputMode="decimal"
                      value={target?.kind === 'bank' ? entry : bankDeclared.toFixed(2)}
                      disabled={pending}
                      onFocus={() => aim({ kind: 'bank' }, String(bankDeclared))}
                      onChange={(e) =>
                        setEntry(e.target.value.replace(',', '.').replace(/[^0-9.]/g, ''))
                      }
                      onBlur={() => {
                        if (target?.kind !== 'bank' || entry === '') return
                        commit({ kind: 'bank' }, entry)
                      }}
                    />
                  </Field>
                  <Field label="Bag / reference" className="w-48">
                    <Input
                      value={bankReference}
                      disabled={pending}
                      onFocus={() => aim(null)}
                      onChange={(e) => setBankReference(e.target.value)}
                      placeholder="e.g. BAG-0194"
                    />
                  </Field>
                  <div className="pb-1">
                    <span className="block text-xs font-medium text-muted">Available to bank</span>
                    <span className="numeric text-base font-semibold text-ink">
                      {view.expectedCashVisible === null ? (
                        <span className="text-faint">—</span>
                      ) : (
                        formatMoney(view.bankExpected)
                      )}
                    </span>
                  </div>
                </div>
              </Panel>
            </div>

            {/* ── The right column: what it all comes to ─────────────────── */}
            <div className="flex flex-col gap-4">
              {/* The bottom line sits FIRST in this column and not in a tab,
                  because it is the answer the whole dialog exists to produce. */}
              <div className="rounded-card border border-border bg-surface-2 px-4 py-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <Field label="Supervisor" className="w-56">
                    <Select
                      value={supervisorId}
                      disabled={pending}
                      onFocus={() => aim(null)}
                      onChange={(e) => setSupervisorId(e.target.value)}
                    >
                      <option value="">— Who witnessed the count —</option>
                      {supervisors.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="text-right">
                    <span className="block text-sm text-ink-2">
                      {liveVariance === null
                        ? 'Declare every tender to see the difference'
                        : liveVariance === 0
                          ? 'Balanced'
                          : liveVariance < 0
                            ? 'Short by'
                            : 'Over by'}
                    </span>
                    <span
                      className={`numeric text-3xl font-bold ${
                        liveVariance === null
                          ? 'text-faint'
                          : liveVariance === 0
                            ? 'text-success'
                            : outside
                              ? 'text-danger'
                              : 'text-ink'
                      }`}
                    >
                      {liveVariance === null ? '—' : formatMoney(Math.abs(liveVariance))}
                    </span>
                  </div>
                </div>

                {outside && (
                  <div className="mt-3">
                    <Field
                      label="Explain the difference"
                      hint={`Outside the ${formatMoney(view.tolerance)} tolerance, so this is required.`}
                    >
                      <Input
                        value={varianceNote}
                        disabled={pending}
                        onFocus={() => aim(null)}
                        onChange={(e) => setVarianceNote(e.target.value)}
                        placeholder="e.g. Two R20 notes could not be found. Reported."
                      />
                    </Field>
                  </div>
                )}

                <div className="mt-3">
                  <Field label="Note" hint="Anything the manager should read with this cash-up.">
                    <Input
                      value={note}
                      disabled={pending}
                      onFocus={() => aim(null)}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </Field>
                </div>
              </div>

              {/* One totals tile per tender, numbered in sequence off whatever
                  came before. Built from the tender list rather than hardcoded,
                  because a site that adds a tender type must get a tile for it
                  without anyone editing this file — and a shift that took
                  nothing must not leave a hole where panel 5 should be. */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                {totalsPanels.map((p) => (
                  <TotalsPanel
                    key={p.tenderTypeId}
                    n={p.n}
                    title={p.title}
                    label={p.label}
                    expected={p.expected}
                    declaredValue={declared[p.tenderTypeId]}
                  />
                ))}
              </div>

              <Panel n={countersPanelNumber} title="Counters">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
                  <Count label="Sales" value={view.counters.salesCount} />
                  <Count label="Cash only" value={view.counters.cashSales} />
                  <Count label="Card only" value={view.counters.cardSales} />
                  <Count label="Account" value={view.counters.accountSales} />
                  <Count label="Refunds" value={view.counters.refundCount} />
                  <Count
                    label="Voided sales"
                    value={view.counters.voidedSales}
                    tone={view.counters.voidedSales > 0 ? 'warning' : undefined}
                  />
                  <Count label="Payouts" value={view.counters.payoutCount} />
                </dl>
              </Panel>

              <Panel n={countersPanelNumber + 1} title="Every tender, side by side">
                <div className="overflow-x-auto">
                  <table className={TABLE}>
                    <thead>
                      <tr className={TABLE_HEAD_ROW}>
                        <th className={TABLE_TH}>Tender</th>
                        {/* "Txns", not "Sales": a split sale puts a row under
                            each tender, so these sum to more than the sale
                            count. */}
                        <th className={`${TABLE_TH} text-right`}>Txns</th>
                        <th className={`${TABLE_TH} text-right`}>Expected</th>
                        <th className={`${TABLE_TH} text-right`}>Declared</th>
                        <th className={`${TABLE_TH} text-right`}>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.tenders.map((t) => {
                        const value = declared[t.tenderTypeId]
                        const shown = revealed[t.tenderTypeId]
                        const variance =
                          value !== undefined && shown ? round(value - shown.expected, 2) : null
                        return (
                          <tr key={t.tenderTypeId}>
                            <td className={TABLE_TD}>{t.tenderName}</td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{t.transactionCount}</td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              {/* An em dash: this browser has not been told the
                                  figure, rather than being styled out of view. */}
                              {!shown ? (
                                <span className="text-faint">—</span>
                              ) : (
                                formatMoney(shown.expected)
                              )}
                            </td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              {value === undefined ? (
                                <span className="text-faint">—</span>
                              ) : (
                                formatMoney(value)
                              )}
                            </td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              {variance === null ? (
                                <span className="text-faint">—</span>
                              ) : variance === 0 ? (
                                <Badge tone="success">0.00</Badge>
                              ) : (
                                <Badge tone={variance < 0 ? 'danger' : 'warning'}>
                                  {variance < 0 ? '−' : '+'}
                                  {formatMoney(Math.abs(variance))}
                                </Badge>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * One numbered block of the board.
 *
 * The number is not decoration: a supervisor reads a cash-up out loud over the
 * phone, and "panel 8" is a shorter thing to say than "the card totals box on
 * the right". The legacy till numbered them for the same reason.
 */
function Panel({
  n,
  title,
  children,
}: {
  n: number
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-card border border-border bg-surface p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="numeric flex h-5 w-5 shrink-0 items-center justify-center rounded-pill bg-brand-soft text-xs font-bold text-brand">
          {n}
        </span>
        {title}
      </h3>
      {children}
    </section>
  )
}

/**
 * Expected / declared / difference, for one tender.
 *
 * The difference row is the only coloured thing in the tile, because it is the
 * only one that carries a judgement — and it stays neutral until the tender has
 * been declared rather than showing a scary red figure against a count nobody
 * has made yet. That was the mockup's one real flaw: a −160.00 in danger red
 * before the cashier has touched the drawer reads as an error they caused.
 */
function TotalsPanel({
  n,
  title,
  label,
  expected,
  declaredValue,
}: {
  n: number
  title: string
  label: string
  expected: number | null
  declaredValue: number | undefined
}) {
  const variance =
    expected !== null && declaredValue !== undefined ? round(declaredValue - expected, 2) : null

  return (
    <Panel n={n} title={title}>
      <dl className="flex flex-col gap-1.5">
        <Line label={label} value={expected} />
        <Line label="Declared" value={declaredValue ?? null} />
      </dl>
      <div
        className={`mt-2 flex items-baseline justify-between rounded-control px-3 py-2 ${
          variance === null
            ? 'bg-surface-2'
            : variance === 0
              ? 'bg-success-soft'
              : 'bg-danger-soft'
        }`}
      >
        <span className="text-xs font-medium text-ink">Difference</span>
        <span
          className={`numeric text-sm font-bold ${
            variance === null ? 'text-faint' : variance === 0 ? 'text-success' : 'text-danger'
          }`}
        >
          {variance === null ? '—' : formatMoney(variance)}
        </span>
      </div>
    </Panel>
  )
}

function Line({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="numeric text-sm font-semibold text-ink">
        {value === null ? <span className="text-faint">—</span> : formatMoney(value)}
      </dd>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`numeric text-sm font-semibold ${
          value < 0 ? 'text-danger' : value > 0 ? 'text-ink' : 'text-faint'
        }`}
      >
        {formatMoney(value)}
      </dd>
    </div>
  )
}

function Count({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'warning'
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`numeric text-sm font-semibold ${
          tone === 'warning' ? 'text-warning' : value === 0 ? 'text-faint' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  )
}
