'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CurrencyInput,
  Field,
  Icons,
  Input,
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
  saveDeclarationAction,
  prePrintAction,
  finalizeDeclarationAction,
  revealTenderAction,
} from '../../declarationActions'
import type { VisibleDeclaration } from './visible'

/**
 * The detailed cash declaration.
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 *
 * Counting a drawer properly. The quick count on the till answers "does it
 * balance"; this answers the question a supervisor signs their name under: what
 * notes and coins were physically there, what each card machine's own slip
 * reported, and what is going to the bank.
 *
 * ── BLIND, THEN REVEALED ────────────────────────────────────────────────────
 *
 * Expected figures are not merely hidden here — the SERVER withholds them until
 * a tender has been declared (see declarationActions.ts). So a column reading
 * "—" is a figure this browser has genuinely never been told, not one styled
 * out of view. The moment a number is committed the whole row appears: expected,
 * declared, difference.
 *
 * That is the resolution of a real tension. A blind count stops a cashier
 * counting toward a target; the legacy screen's difference columns are what
 * make the count worth doing. Committing per tender gets both.
 *
 * ── DENOMINATIONS ARE THE AUDITABLE HALF ────────────────────────────────────
 *
 * "The drawer held R693" is a conclusion. "Eleven R50s, six R20s and R23 in
 * coin" is a COUNT, and only the second can be checked by recounting. The grid
 * totals into the cash declaration rather than the cashier typing a total.
 */

type Tab = 'general' | 'payments'

export default function DeclarationClient({
  view,
  supervisors,
  canFinalize,
}: {
  view: VisibleDeclaration
  supervisors: { id: number; name: string }[]
  /** False once signed — the screen becomes a record rather than a form. */
  canFinalize: boolean
}) {
  const toast = useToast()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [tab, setTab] = useState<Tab>('general')

  const signed = view.finalizedAt !== null

  const [supervisorId, setSupervisorId] = useState<string>(
    supervisors.find((s) => s.name === view.supervisorName)?.id?.toString() ?? '',
  )
  /* Seeded from what was counted before, so re-opening a draft shows the work
     rather than an empty grid somebody has to redo. */
  const [qty, setQty] = useState<Record<number, number>>(() =>
    Object.fromEntries(view.counted.map((c) => [c.denominationId, c.qty])),
  )
  const [declared, setDeclared] = useState<Record<number, number | undefined>>(() =>
    Object.fromEntries(
      view.tenders.filter((t) => t.declared !== null).map((t) => [t.tenderTypeId, t.declared!]),
    ),
  )
  /**
   * Expected figures this browser has EARNED, by committing a count for them.
   *
   * Seeded from whatever the server already revealed (a returning draft), then
   * added to one tender at a time as each is committed. Held here rather than
   * re-fetching the page so the reveal is immediate — see revealTenderAction.
   */
  const [revealed, setRevealed] = useState<
    Record<number, { expected: number; floatIncluded: number }>
  >(() =>
    Object.fromEntries(
      view.tenders
        .filter((t) => t.expected !== null)
        .map((t) => [
          t.tenderTypeId,
          { expected: t.expected!, floatIncluded: t.floatIncluded ?? 0 },
        ]),
    ),
  )

  const [bankDeclared, setBankDeclared] = useState(view.bankDeclared)
  const [bankReference, setBankReference] = useState(view.bankReference ?? '')
  const [varianceNote, setVarianceNote] = useState(view.varianceNote ?? '')
  const [note, setNote] = useState(view.note ?? '')

  /* The grid's own total. Derived on every keystroke rather than stored: a
     "total" the cashier can edit independently of the counts under it is a
     figure that can silently disagree with them. */
  const declaredCash = useMemo(
    () =>
      view.denominations.reduce(
        (sum, d) => round(sum + d.value * (qty[d.id] ?? 0), 2),
        0,
      ),
    [qty, view.denominations],
  )

  const notes = view.denominations.filter((d) => d.isNote)
  const coins = view.denominations.filter((d) => !d.isNote)

  const input = () => ({
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
  })

  function run(
    work: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>,
    after?: () => void,
  ) {
    startTransition(async () => {
      const result = await work()
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      after?.()
      router.refresh()
    })
  }

  /**
   * Commits one tender and asks for its expected figure in exchange.
   *
   * On BLUR rather than per keystroke: revealing while somebody is still typing
   * would hand them the target half way through entering their own number,
   * which is precisely the copying the blind count exists to prevent.
   */
  function commitTender(tenderTypeId: number, value: number | undefined) {
    if (signed || value === undefined || revealed[tenderTypeId]) return
    startTransition(async () => {
      /* `qty` goes with it: committing a tender saves the whole declaration,
         so the grid as typed must travel or it is silently discarded. */
      const result = await revealTenderAction(view.shiftId, tenderTypeId, value, qty)
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

  const everyTenderDeclared = view.tenders.every(
    (t) => declared[t.tenderTypeId] !== undefined,
  )

  /* Recomputed from what is on screen rather than from the server's snapshot:
     the server figure is one save behind whatever is being typed now. Only
     available once every expected figure has been revealed. */
  const liveVariance = useMemo(() => {
    if (!everyTenderDeclared) return null
    if (view.tenders.some((t) => revealed[t.tenderTypeId] === undefined)) return null
    return view.tenders.reduce(
      (sum, t) =>
        round(sum + ((declared[t.tenderTypeId] ?? 0) - revealed[t.tenderTypeId].expected), 2),
      0,
    )
  }, [declared, revealed, view.tenders, everyTenderDeclared])

  const outside = liveVariance !== null && Math.abs(liveVariance) > view.tolerance

  return (
    <div className="flex flex-col gap-5">
      {/* ── The header: who, and the four actions ───────────────────────── */}
      <Card>
        <CardBody className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Supervisor" className="w-56">
              <Select
                value={supervisorId}
                disabled={signed || pending}
                onChange={(e) => setSupervisorId(e.target.value)}
              >
                <option value="">— Choose —</option>
                {supervisors.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            {/* The site's mode decides what this names — a person in user mode,
                the till in terminal mode. Read-only either way: it is whose
                cash-up this IS, not a choice being made now. */}
            <Field label={view.mode === 'user' ? 'User' : 'Till'} className="w-56">
              <Input value={view.ownerLabel} readOnly disabled />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {signed ? (
              <Badge tone="success">
                Signed off {new Date(view.finalizedAt!).toLocaleString('en-ZA')}
              </Badge>
            ) : (
              <>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => saveDeclarationAction(view.shiftId, input()))}
                >
                  <Icons.Save size={15} />
                  Save count
                </Button>
                {/* Pre-print SAVES first, so the sheet in somebody's hand and the
                    stored draft cannot disagree — see the action. */}
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(() => prePrintAction(view.shiftId, input()), () => window.print())
                  }
                >
                  <Icons.Printer size={15} />
                  Pre-print
                </Button>
                <Button
                  variant="success"
                  disabled={pending || !canFinalize || !everyTenderDeclared || !supervisorId}
                  onClick={() => run(() => finalizeDeclarationAction(view.shiftId, input()))}
                >
                  <Icons.Check size={15} />
                  {pending ? 'Signing off…' : 'Finalize'}
                </Button>
              </>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {/* ── LEFT: the count itself ───────────────────────────────────── */}
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader
              title="Declare cash by denomination"
              description="Count what is physically in the drawer. The total is worked out for you."
            />
            <CardBody className="flex flex-col gap-4">
              <DenominationGrid
                title="Notes"
                rows={notes}
                qty={qty}
                disabled={signed || pending}
                onChange={(id, n) => setQty((q) => ({ ...q, [id]: n }))}
              />
              <DenominationGrid
                title="Coin"
                rows={coins}
                qty={qty}
                disabled={signed || pending}
                onChange={(id, n) => setQty((q) => ({ ...q, [id]: n }))}
              />

              {/* The one figure on this card that is not typed. Loud, because it
                  is what the whole grid exists to produce. */}
              <div className="flex items-baseline justify-between rounded-card bg-warning-soft px-4 py-3">
                <span className="text-sm font-medium text-ink">Total cash (declared)</span>
                <span className="numeric text-xl font-bold text-ink">
                  {formatMoney(declaredCash)}
                </span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Declare every tender"
              description="What the card machine's own slip says, and the rest."
            />
            <CardBody className="flex flex-col gap-3">
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
                        /* "Not counted", never "0.00" — the box must not look
                           declared before anybody has counted it. */
                        placeholder="Not counted"
                        disabled={signed || pending}
                        onChange={(e) =>
                          setDeclared((d) => ({
                            ...d,
                            [tender.tenderTypeId]:
                              e.target.value === ''
                                ? undefined
                                : Number(String(e.target.value).replace(',', '.')) || 0,
                          }))
                        }
                        /* The exchange: hand over the count, get the target. */
                        onBlur={() => commitTender(tender.tenderTypeId, value)}
                      />
                    </Field>
                    {/* Appears only once a figure is committed — the reveal the
                        whole blind-count design turns on. */}
                    {shown && (
                      <p className="text-xs text-muted">
                        Expected {formatMoney(shown.expected)}
                        {shown.floatIncluded ? ` (float ${formatMoney(shown.floatIncluded)})` : ''}
                        {variance !== null && (
                          <>
                            {' · '}
                            {variance === 0 ? (
                              <span className="text-success">exact</span>
                            ) : (
                              <span className={variance < 0 ? 'text-danger' : 'text-warning'}>
                                {variance < 0 ? 'short' : 'over'} {formatMoney(Math.abs(variance))}
                              </span>
                            )}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                )
              })}
            </CardBody>
          </Card>
        </div>

        {/* ── RIGHT: what the shift actually did ───────────────────────── */}
        <div className="flex flex-col gap-5">
          <Tabs
            items={[
              { value: 'general', label: 'General sales info' },
              { value: 'payments', label: 'Payments & deposits' },
            ]}
            value={tab}
            onChange={setTab}
            aria-label="Cash-up detail"
          />

          {tab === 'general' ? (
            <>
              <Card>
                <CardHeader
                  title="Actual sales values"
                  description="What was rung up on this shift, by tender."
                />
                <div className="overflow-x-auto">
                  <table className={TABLE}>
                    <thead>
                      <tr className={TABLE_HEAD_ROW}>
                        <th className={TABLE_TH}>Tender</th>
                        {/* "Txns", not "Sales": a split sale puts a row under
                            each tender, so these sum to more than the sale count
                            in the panel below. Naming them the same thing made
                            two correct figures look like a contradiction. */}
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
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              {t.transactionCount}
                            </td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              {/* An em dash, because the browser has not been
                                  told this figure yet. */}
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
              </Card>

              <Card>
                <CardHeader title="Other transactions" description="Everything that moved money without being a sale." />
                <CardBody>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                    <Figure label="Opening float" value={view.openingFloat} />
                    <Figure label="Payouts" value={-view.payoutsTotal} />
                    <Figure label="Pay-ins" value={view.payinsTotal} />
                    <Figure label="Drops to safe" value={-view.dropsTotal} />
                    <Figure label="Refunds" value={-view.refundsTotal} />
                    {/* The 5c the drawer legitimately does not hold. Without it a
                        shop rounding all day looks short with nothing to blame. */}
                    <Figure label="Rounding" value={view.roundingTotal} />
                    <Figure label="Tips" value={view.tipsTotal} />
                  </dl>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Counters" description="How many, rather than how much." />
                <CardBody>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
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
                    {view.printCount > 0 && (
                      <Count label="Times pre-printed" value={view.printCount} />
                    )}
                  </dl>
                </CardBody>
              </Card>
            </>
          ) : (
            <>
              <Card>
                <CardHeader
                  title="Deposits & instalments"
                  description="Money taken against something that is not a sale today."
                />
                <CardBody>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                    <Figure label="Lay-buy deposits" value={view.laybyDeposits} />
                    <Figure label="Lay-buy instalments" value={view.laybyPayments} />
                    {/* Deposits on a sale, quote or invoice (172). Shown beside
                        the lay-by figures because a cashier counting the drawer
                        does not care which module took the money — only that
                        every note in front of them is accounted for. */}
                    <Figure label="Sale deposits" value={view.saleDepositsTaken} />
                    {view.saleDepositsRefunded > 0 ? (
                      <Figure label="Deposits refunded" value={-view.saleDepositsRefunded} />
                    ) : null}
                    <Figure label="Loyalty top-ups" value={view.loyaltyWallet} />
                  </dl>
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Gift cards" description="Sold on this shift, and redeemed against it." />
                <CardBody>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
                    <Figure label="Sold / reloaded" value={view.giftCardSold} />
                    <Figure label="Redeemed" value={-view.giftCardRedeemed} />
                  </dl>
                </CardBody>
              </Card>
            </>
          )}

          {/* ── Banking ─────────────────────────────────────────────────
              Its own question. A drawer can reconcile perfectly and still have
              the wrong amount put in the bag. */}
          <Card>
            <CardHeader
              title="Banking"
              description="What is leaving for the bank. The float stays behind for tomorrow."
            />
            <CardBody className="flex flex-wrap items-end gap-4">
              <Field label="To bank" className="w-44">
                <CurrencyInput
                  value={bankDeclared}
                  disabled={signed || pending}
                  onChange={(e) =>
                    setBankDeclared(Number(String(e.target.value).replace(',', '.')) || 0)
                  }
                />
              </Field>
              <Field label="Bag / reference" className="w-52">
                <Input
                  value={bankReference}
                  disabled={signed || pending}
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
            </CardBody>
          </Card>

          {/* ── The bottom line ─────────────────────────────────────────── */}
          <Card>
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-2">
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

              {outside && (
                <Field
                  label="Explain the difference"
                  hint={`Outside the ${formatMoney(view.tolerance)} tolerance, so this is required.`}
                >
                  <Input
                    value={varianceNote}
                    disabled={signed || pending}
                    onChange={(e) => setVarianceNote(e.target.value)}
                    placeholder="e.g. Two R20 notes could not be found. Reported."
                  />
                </Field>
              )}

              <Field label="Note" hint="Anything the manager should read with this cash-up.">
                <Input
                  value={note}
                  disabled={signed || pending}
                  onChange={(e) => setNote(e.target.value)}
                />
              </Field>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  )
}

/**
 * One block of the count.
 *
 * Notes and coins are separated because that is how a person physically counts
 * a drawer — one pile at a time — and a single interleaved list invites reading
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
