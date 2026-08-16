'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import {
  Badge,
  Button,
  Callout,
  CurrencyInput,
  Field,
  Input,
  Modal,
  NumberInput,
  Select,
  Tabs,
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
 * ── ONE ENGINE, TWO FACES ───────────────────────────────────────────────────
 *
 * Every figure here comes from `declarationView` via the till actions, which
 * reuse the back office's own engine and its `visibleFor` strip. This file owns
 * the LAYOUT and nothing else — no arithmetic, no rules about what may be seen.
 * Where the back office spreads the count over two columns for a mouse, this
 * stacks it into tabs a cashier can work down with a finger.
 *
 * ── BLIND, THEN REVEALED ────────────────────────────────────────────────────
 *
 * Expected figures are withheld by the SERVER until a tender is declared, and
 * are asked for on blur — one tender at a time, in exchange for a committed
 * count. A cashier who can see the target is copying rather than counting.
 */

type Tab = 'cash' | 'tenders' | 'detail'

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
  const [tab, setTab] = useState<Tab>('cash')

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

  /* Loaded on open rather than held: a shift's takings move with every sale,
     so a view cached from the last time this was opened would be counting
     against a stale target. */
  useEffect(() => {
    if (!open || shiftId === null) return
    setTab('cash')
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

  const everyTenderDeclared =
    view !== null && view.tenders.every((t) => declared[t.tenderTypeId] !== undefined)

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
  function commitTender(tenderTypeId: number, value: number | undefined) {
    if (shiftId === null || value === undefined || revealed[tenderTypeId]) return
    startTransition(async () => {
      const result = await tillRevealTenderAction(shiftId, tenderTypeId, value, qty)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      setRevealed((r) => ({
        ...r,
        [tenderTypeId]: { expected: result.expected, floatIncluded: result.floatIncluded },
      }))
    })
  }

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
  const notes = (view?.denominations ?? []).filter((d) => d.isNote)
  const coins = (view?.denominations ?? []).filter((d) => !d.isNote)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Cash up — declare the drawer"
      description={
        view
          ? `${view.ownerLabel} · trading since ${new Date(view.openedAt).toLocaleString('en-ZA')}`
          : undefined
      }
      /* Half-counted work behind a stray click is exactly what this must not
         lose — the draft is saved per tender, but the grid is not. */
      closeOnBackdrop={false}
      subheader={
        view && !signed ? (
          <Tabs
            items={[
              { value: 'cash', label: 'Count cash' },
              { value: 'tenders', label: 'Declare tenders' },
              { value: 'detail', label: 'Shift detail' },
            ]}
            value={tab}
            onChange={setTab}
            aria-label="Cash-up"
          />
        ) : undefined
      }
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
        <div className="flex flex-col gap-4">
          {pendingSales > 0 && (
            <Callout
              tone="warning"
              title={`${pendingSales} sale${pendingSales === 1 ? '' : 's'} still to send`}
            >
              The expected figures exclude them — send the outbox before signing off, or the
              drawer will read over by their whole value.
            </Callout>
          )}

          {tab === 'cash' ? (
            /* ── The auditable half: notes and coin, counted by pile ──────── */
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted">
                Count what is physically in the drawer, one pile at a time. The total is
                worked out for you — &ldquo;eleven R50s&rdquo; can be recounted, &ldquo;R693&rdquo;
                cannot.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <DenominationGrid
                  title="Notes"
                  rows={notes}
                  qty={qty}
                  disabled={pending}
                  onChange={(id, n) => setQty((q) => ({ ...q, [id]: n }))}
                />
                <DenominationGrid
                  title="Coin"
                  rows={coins}
                  qty={qty}
                  disabled={pending}
                  onChange={(id, n) => setQty((q) => ({ ...q, [id]: n }))}
                />
              </div>
              <div className="flex items-baseline justify-between rounded-card bg-warning-soft px-4 py-3">
                <span className="text-sm font-medium text-ink">Total cash counted</span>
                <span className="numeric text-xl font-bold text-ink">
                  {formatMoney(declaredCash)}
                </span>
              </div>
            </div>
          ) : tab === 'tenders' ? (
            /* ── Every tender, declared then revealed ─────────────────────── */
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted">
                Declare each one — the drawer for cash, the machine&rsquo;s own slip for card.
                What was expected appears once you have committed your figure.
              </p>
              {view.tenders.length === 0 && (
                <p className="text-sm text-muted">
                  Nothing was taken on this shift. Signing off records the float only.
                </p>
              )}
              {view.tenders.map((tender) => {
                const value = declared[tender.tenderTypeId]
                const shown = revealed[tender.tenderTypeId]
                const variance =
                  value !== undefined && shown ? round(value - shown.expected, 2) : null
                return (
                  <div key={tender.tenderTypeId} className="flex flex-col gap-1">
                    <Field
                      label={tender.tenderName}
                      hint={
                        tender.countsAsDrawerCash
                          ? 'The drawer, including the float.'
                          : 'What the machine or bank reports.'
                      }
                    >
                      <CurrencyInput
                        value={value ?? ''}
                        /* "Not counted", never "0.00" — a blank box must not
                           look declared before anybody has counted it. */
                        placeholder="Not counted"
                        disabled={pending}
                        onChange={(e) =>
                          setDeclared((d) => ({
                            ...d,
                            [tender.tenderTypeId]:
                              e.target.value === ''
                                ? undefined
                                : Number(String(e.target.value).replace(',', '.')) || 0,
                          }))
                        }
                        onBlur={() => commitTender(tender.tenderTypeId, value)}
                      />
                    </Field>
                    {shown && (
                      <p className="text-xs text-muted">
                        Expected {formatMoney(shown.expected)}
                        {shown.floatIncluded
                          ? ` (float ${formatMoney(shown.floatIncluded)})`
                          : ''}
                        {variance !== null && (
                          <>
                            {' · '}
                            {variance === 0 ? (
                              <span className="text-success">exact</span>
                            ) : (
                              <span className={variance < 0 ? 'text-danger' : 'text-warning'}>
                                {variance < 0 ? 'short' : 'over'}{' '}
                                {formatMoney(Math.abs(variance))}
                              </span>
                            )}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                )
              })}

              {/* Cash counted on the other tab, restated here so the two
                  figures can be compared without switching back and forth. */}
              {declaredCash > 0 && (
                <p className="text-xs text-muted">
                  The denomination grid totals {formatMoney(declaredCash)}.
                </p>
              )}
            </div>
          ) : (
            /* ── What the shift actually did ─────────────────────────────── */
            <div className="flex flex-col gap-4">
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Tender</th>
                      {/* "Txns", not "Sales": a split sale puts a row under each
                          tender, so these sum to more than the sale count. */}
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

              <div>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                  Other transactions
                </h3>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
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
              </div>

              <div>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">
                  Counters
                </h3>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
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
              </div>

              {/* Banking is its own question: a drawer can reconcile perfectly
                  and still have the wrong amount put in the bag. */}
              <div className="flex flex-wrap items-end gap-4">
                <Field label="To bank" className="w-40">
                  <CurrencyInput
                    value={bankDeclared}
                    disabled={pending}
                    onChange={(e) =>
                      setBankDeclared(Number(String(e.target.value).replace(',', '.')) || 0)
                    }
                  />
                </Field>
                <Field label="Bag / reference" className="w-48">
                  <Input
                    value={bankReference}
                    disabled={pending}
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
            </div>
          )}

          {/* ── The bottom line, on every tab ──────────────────────────────
              Kept out of the tabs deliberately: it is the answer the whole
              dialog exists to produce, and hiding it behind a tab would mean
              counting without ever seeing whether it balanced. */}
          <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-2 px-4 py-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Field label="Supervisor" className="w-56">
                <Select
                  value={supervisorId}
                  disabled={pending}
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
                  className={`numeric text-2xl font-bold ${
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
              <Field
                label="Explain the difference"
                hint={`Outside the ${formatMoney(view.tolerance)} tolerance, so this is required.`}
              >
                <Input
                  value={varianceNote}
                  disabled={pending}
                  onChange={(e) => setVarianceNote(e.target.value)}
                  placeholder="e.g. Two R20 notes could not be found. Reported."
                />
              </Field>
            )}

            <Field label="Note" hint="Anything the manager should read with this cash-up.">
              <Input value={note} disabled={pending} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        </div>
      )}
    </Modal>
  )
}

/**
 * One block of the count.
 *
 * Notes and coin are separated because that is how a person physically counts a
 * drawer — one pile at a time — and a single interleaved list invites reading
 * the R20 row while holding the 20c pile.
 */
function DenominationGrid({
  title,
  rows,
  qty,
  disabled,
  onChange,
}: {
  title: string
  rows: { id: number; label: string; value: number }[]
  qty: Record<number, number>
  disabled: boolean
  onChange: (id: number, qty: number) => void
}) {
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</span>
      <table className={TABLE}>
        <thead>
          <tr className={TABLE_HEAD_ROW}>
            <th className={TABLE_TH}>Denomination</th>
            <th className={`${TABLE_TH} text-right`}>Qty</th>
            <th className={`${TABLE_TH} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const n = qty[row.id] ?? 0
            return (
              <tr key={row.id}>
                <td className={TABLE_TD}>{row.label}</td>
                <td className={`${TABLE_TD} text-right`}>
                  <NumberInput
                    className="w-20 text-right"
                    value={n === 0 ? '' : n}
                    min={0}
                    step={1}
                    disabled={disabled}
                    onChange={(e) => onChange(row.id, Math.max(0, Number(e.target.value) || 0))}
                  />
                </td>
                {/* Zero stays faint: a column of 0.00 competes with the three
                    rows that actually hold money. */}
                <td className={`${TABLE_TD} ${TABLE_NUMERIC} ${n === 0 ? 'text-faint' : ''}`}>
                  {formatMoney(round(row.value * n, 2))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
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
