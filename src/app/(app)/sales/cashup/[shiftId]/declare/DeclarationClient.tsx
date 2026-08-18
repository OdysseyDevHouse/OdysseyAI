'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Accordion,
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
  saveTenderAction,
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
 * ── EXPECTED FIGURES DEPEND ON WHO IS COUNTING ──────────────────────────────
 *
 * With `sales.cashup_expected`, every tender arrives with what it took already
 * on it and the difference resolves live as each box is filled in — nothing has
 * to be committed to see what you are counting against.
 *
 * Without it the count is BLIND: the server sends no expected figure until a
 * tender has been declared, so a column reading "—" is one this browser has
 * genuinely never been told rather than one styled out of view. Committing a
 * tender earns its figure, which is why `saveTender` refreshes in that mode.
 *
 * The screen therefore has to render both, and the rule is that a withheld
 * figure is ABSENT, never zero — see `expectedByTender`. visible.ts owns the
 * decision; this file only reflects it.
 *
 * ── ONE CARD, CASH FIRST ────────────────────────────────────────────────────
 *
 * Every tender is declared in one place, cash at the top because it is the one
 * that needs counting. The denomination grid folds away underneath it.
 *
 * ── THE TOTAL AND THE GRID ARE EITHER/OR ────────────────────────────────────
 *
 * "The drawer held R693" is a conclusion. "Eleven R50s, six R20s and R23 in
 * coin" is a COUNT, and only the second can be checked by recounting. Both are
 * legitimate — a shop in a hurry types the total, a shop that wants the audit
 * trail counts it out — so the screen offers both and insists on ONE.
 *
 * That insistence is the point. Before it, the typed total and the grid were
 * separate fields saved to separate columns, so a drawer could be signed off
 * declaring R1 000 with a grid adding to R950 and nothing on screen would
 * disagree with itself. Now expanding the grid takes the total over: the box
 * goes read-only and shows what the counts add to.
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
   * What each tender was expected to take, straight off the payload.
   *
   * Derived rather than held in state: a second copy in `useState` could only
   * go stale against a router.refresh() that brought back a different one.
   *
   * A tender the server WITHHELD is absent from this map rather than present as
   * zero. Those are different claims — "nobody may tell you yet" against "it
   * took nothing" — and collapsing them would print "Expected R0.00" over a
   * blind count, along with a variance measured against a number that is not
   * the target. Absent means the row renders an em dash.
   */
  const expectedByTender = useMemo(
    () =>
      new Map(
        view.tenders
          .filter((t) => t.expected !== null)
          .map((t) => [
            t.tenderTypeId,
            { expected: t.expected!, floatIncluded: t.floatIncluded ?? 0 },
          ]),
      ),
    [view.tenders],
  )

  /* Whether this person may see the targets at all. The server decides it by
     permission and says so by sending the figures or not; an undeclared tender
     with an expected figure means they may. */
  const blind = view.tenders.some((t) => t.declared === null && t.expected === null)

  /**
   * Whether the denomination grid is the source of the cash figure.
   *
   * Open by default, because counting the drawer out note by note is what this
   * screen is FOR — the quick count on the list is where a total gets typed.
   * Starting folded hid the grid behind a click on the one screen whose whole
   * purpose is the breakdown.
   *
   * Fold it away to type a total instead; the two are either/or, and collapsing
   * hands the figure back to the box. A signed declaration follows the record
   * rather than the default: no counts means it was totalled, and showing an
   * empty grid over a signed cash-up would invent a count nobody made.
   */
  const [countingCash, setCountingCash] = useState(
    signed ? view.counted.length > 0 : true,
  )

  /* Coppers, declared as one amount rather than counted by pile — see
     sql/site/184_cashup_small_change.sql. */
  const [smallChange, setSmallChange] = useState(view.smallChange)

  const [bankDeclared, setBankDeclared] = useState(view.bankDeclared)
  const [bankReference, setBankReference] = useState(view.bankReference ?? '')
  const [varianceNote, setVarianceNote] = useState(view.varianceNote ?? '')
  const [note, setNote] = useState(view.note ?? '')

  /* The grid's own total. Derived on every keystroke rather than stored: a
     "total" the cashier can edit independently of the counts under it is a
     figure that can silently disagree with them. */
  const declaredCash = useMemo(
    () =>
      /* The piles PLUS the sweepings — see smallChange. */
      round(
        view.denominations.reduce(
          (sum, d) => round(sum + d.value * (qty[d.id] ?? 0), 2),
          0,
        ) + smallChange,
        2,
      ),
    [qty, view.denominations, smallChange],
  )

  const notes = view.denominations.filter((d) => d.isNote)
  const coins = view.denominations.filter((d) => !d.isNote)

  /* The drawer tender — the one the grid counts. Usually "Cash"; found by the
     flag rather than by name so a site that renamed it still works. */
  const cashTender = view.tenders.find((t) => t.countsAsDrawerCash) ?? null
  const otherTenders = view.tenders.filter((t) => !t.countsAsDrawerCash)

  /**
   * What cash is being declared as, whichever way it was entered.
   *
   * This is the single figure the rest of the screen reads — the variance, the
   * finalize guard and the save all go through it, so the grid and the typed
   * total cannot reach the record as two different numbers.
   */
  const cashDeclared = cashTender
    ? countingCash
      ? declaredCash
      : declared[cashTender.tenderTypeId]
    : undefined

  const input = () => ({
    supervisorId: supervisorId ? Number(supervisorId) : null,
    supervisorName: supervisors.find((s) => s.id.toString() === supervisorId)?.name ?? '',
    /* Only when the grid IS the count. A typed total with a stale grid behind
       it would store a breakdown that contradicts the figure being signed. */
    denominations: countingCash ? qty : {},
    smallChange,
    tenders: Object.fromEntries(
      Object.entries({
        ...declared,
        /* The grid wins while it is open — see cashDeclared. */
        ...(cashTender && cashDeclared !== undefined
          ? { [cashTender.tenderTypeId]: cashDeclared }
          : {}),
      })
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
   * Persists one tender's count on blur.
   *
   * The difference on screen is worked out locally as you type, so this is
   * about DURABILITY rather than display: a drawer count takes real minutes and
   * a browser that dies half way through should not lose the tenders already
   * counted. Saved per tender rather than on one submit at the end for exactly
   * that reason.
   *
   * On blur rather than per keystroke — a save per digit would write "4",
   * "42", "420" on the way to R4 200.
   */
  function saveTender(tenderTypeId: number, value: number | undefined) {
    if (signed || value === undefined) return
    startTransition(async () => {
      /* `qty` goes with it: saving a tender writes the whole declaration, so
         the grid as typed must travel or it is silently discarded. */
      const result = await saveTenderAction(view.shiftId, tenderTypeId, value, qty)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      /* Blind: the figure this tender was measured against only becomes
         publishable once a count exists for it, so go and fetch it. Committing
         is what earns the reveal — which is why this refreshes rather than
         reading the number out of the result: the server decides, per tender,
         what may now be seen.

         Not blind: everything is already on screen and a refresh would only
         re-render the same figures mid-count. */
      if (blind) router.refresh()
    })
  }

  /**
   * Persists the drawer count as the cash tender's declared figure.
   *
   * Reads `declaredCash` rather than `cashDeclared` deliberately: this only
   * ever runs from the grid, and going through the same derived value would
   * make it depend on the accordion still being open at the moment the blur
   * lands — which it is not, if the blur was caused by collapsing it.
   */
  function commitCountedCash() {
    if (!cashTender || signed) return
    saveTender(cashTender.tenderTypeId, declaredCash)
  }

  const everyTenderDeclared = view.tenders.every((t) =>
    t.countsAsDrawerCash ? cashDeclared !== undefined : declared[t.tenderTypeId] !== undefined,
  )

  /* Recomputed from what is on screen rather than from the server's snapshot:
     the server figure is one save behind whatever is being typed now.

     Still gated on a COMPLETE count. A running total over the tenders done so
     far reads as "the shift is R40 short" when the truth is "two of four
     tenders are counted", and that is the figure somebody signs under. */
  const liveVariance = useMemo(() => {
    if (!everyTenderDeclared) return null
    return view.tenders.reduce(
      (sum, t) =>
        round(
          sum +
            ((t.countsAsDrawerCash ? (cashDeclared ?? 0) : (declared[t.tenderTypeId] ?? 0)) -
              (expectedByTender.get(t.tenderTypeId)?.expected ?? 0)),
          2,
        ),
      0,
    )
  }, [declared, cashDeclared, expectedByTender, view.tenders, everyTenderDeclared])

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
              title="Declare every tender"
              description="What was in the drawer, what the card machine's slip says, and the rest."
            />
            <CardBody className="flex flex-col gap-4">
              {/*
                "Nothing was taken" is only true if nothing was taken.

                `view.tenders` is built from sales tenders alone, so a shift that
                took a lay-by deposit and rang up no sale showed this sentence
                beside a drawer holding the deposit — telling a cashier to expect
                the float when the right answer was the float plus R500. The
                off-ledger figure is exactly that money, so it decides which
                sentence is honest.
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

              {/* ── Cash, first, with its breakdown folded underneath ───── */}
              {cashTender && (
                <div className="flex flex-col gap-2">
                  <TenderRow
                    tender={cashTender}
                    value={cashDeclared}
                    expected={expectedByTender.get(cashTender.tenderTypeId)}
                    /* Read-only while the grid drives it: two editable fields
                       for one figure is how they come to disagree. */
                    readOnly={countingCash}
                    hint={
                      countingCash
                        ? 'Added up from the denominations below.'
                        : 'The drawer, including the float.'
                    }
                    disabled={signed || pending}
                    onChange={(v) =>
                      setDeclared((d) => ({ ...d, [cashTender.tenderTypeId]: v }))
                    }
                    onBlur={() => saveTender(cashTender.tenderTypeId, cashDeclared)}
                  />

                  <Accordion
                    title="Count it out by denomination"
                    description={
                      countingCash
                        ? 'This count decides the cash figure.'
                        : 'Optional — count the drawer out instead.'
                    }
                    badge={
                      countingCash ? (
                        <Badge tone="brand">{formatMoney(declaredCash)}</Badge>
                      ) : undefined
                    }
                    open={countingCash}
                    /* Folding it away hands the figure back to the typed box,
                       seeded with what the grid last added to so the number on
                       screen does not jump when somebody collapses it. */
                    onToggle={() => {
                      if (signed) return
                      setCountingCash((open) => {
                        if (open) {
                          setDeclared((d) => ({
                            ...d,
                            [cashTender.tenderTypeId]: declaredCash,
                          }))
                        }
                        return !open
                      })
                    }}
                  >
                    <div className="flex flex-col gap-4">
                      {/* Each grid commits the CASH tender on blur: the box
                          above is read-only while counting, so it never blurs
                          and would otherwise leave the count unsaved until
                          somebody pressed Save. */}
                      <DenominationGrid
                        title="Notes"
                        rows={notes}
                        qty={qty}
                        disabled={signed || pending}
                        onChange={(id, n) => setQty((q) => ({ ...q, [id]: n }))}
                        onCommit={commitCountedCash}
                      />
                      <DenominationGrid
                        title="Coin"
                        rows={coins}
                        qty={qty}
                        disabled={signed || pending}
                        onChange={(id, n) => setQty((q) => ({ ...q, [id]: n }))}
                        onCommit={commitCountedCash}
                      />

                      {/* SMALL CHANGE, at the bottom. Every row above counts a
                          PILE — a quantity times what the coin is worth — and
                          the coppers in a drawer are not counted that way: 1c,
                          2c and 5c are swept together and declared as one
                          amount. See sql/site/184_cashup_small_change.sql. */}
                      <div className="border-t border-border pt-3">
                        <Field
                          label="Small change"
                          hint="1c, 2c, 5c — as one amount rather than a count."
                        >
                          <CurrencyInput
                            value={smallChange}
                            disabled={signed || pending}
                            onChange={(e) =>
                              setSmallChange(
                                Number(String(e.target.value).replace(',', '.')) || 0,
                              )
                            }
                            onBlur={commitCountedCash}
                          />
                        </Field>
                      </div>

                      {/* The one figure here that is not typed. Loud, because it
                          is what the whole grid exists to produce. */}
                      <div className="flex items-baseline justify-between rounded-card bg-warning-soft px-4 py-3">
                        <span className="text-sm font-medium text-ink">Total cash (declared)</span>
                        <span className="numeric text-xl font-bold text-ink">
                          {formatMoney(declaredCash)}
                        </span>
                      </div>
                    </div>
                  </Accordion>
                </div>
              )}

              {/* ── Then the machines and the bank ──────────────────────── */}
              {otherTenders.map((tender) => (
                <TenderRow
                  key={tender.tenderTypeId}
                  tender={tender}
                  value={declared[tender.tenderTypeId]}
                  expected={expectedByTender.get(tender.tenderTypeId)}
                  hint="What the machine or bank reports."
                  disabled={signed || pending}
                  onChange={(v) => setDeclared((d) => ({ ...d, [tender.tenderTypeId]: v }))}
                  onBlur={() => saveTender(tender.tenderTypeId, declared[tender.tenderTypeId])}
                />
              ))}
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
                        {/* No transaction count here any more — it moved to the
                            Counters panel. This table compares MONEY, expected
                            against declared, and a count never took part in
                            that comparison. */}
                        <th className={`${TABLE_TH} text-right`}>Expected</th>
                        <th className={`${TABLE_TH} text-right`}>Declared</th>
                        <th className={`${TABLE_TH} text-right`}>Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.tenders.map((t) => {
                        const value = declared[t.tenderTypeId]
                        const shown = expectedByTender.get(t.tenderTypeId)
                        const variance =
                          value !== undefined && shown ? round(value - shown.expected, 2) : null
                        return (
                          <tr key={t.tenderTypeId}>
                            <td className={TABLE_TD}>{t.tenderName}</td>
                            <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                              {/* An em dash, because the browser has not been
                                  told this figure — see expectedByTender. */}
                              {shown ? (
                                formatMoney(shown.expected)
                              ) : (
                                <span className="text-faint">—</span>
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
                    {/* Three void figures, not one. A mis-scanned item, a line
                        a customer changed their mind about, and a whole basket
                        abandoned are three different events; the old single
                        "Voided sales" rolled them together with finalised sales
                        reversed afterwards and answered none of them. */}
                    <Count label="Void items" value={view.counters.voidItems} />
                    <Count label="Void lines" value={view.counters.voidLines} />
                    <Count
                      label="Void sales"
                      value={view.counters.voidSales}
                      tone={view.counters.voidSales > 0 ? 'warning' : undefined}
                    />
                    <Count
                      label="Cancelled sales"
                      value={view.counters.cancelledSales}
                      tone={view.counters.cancelledSales > 0 ? 'warning' : undefined}
                    />
                    <Count label="Payouts" value={view.counters.payoutCount} />
                    {view.printCount > 0 && (
                      <Count label="Times pre-printed" value={view.printCount} />
                    )}
                  </dl>

                  {/* Transactions per tender, moved off the money table.

                      A split sale puts a row under each tender it used, so
                      these sum to MORE than the sale count above — their own
                      group under a rule is what stops the two being read as
                      the same kind of number. */}
                  {view.counters.tenderTxns.length > 0 && (
                    <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-border pt-4 sm:grid-cols-3">
                      {view.counters.tenderTxns.map((t) => (
                        <Count
                          key={t.tenderName}
                          label={`${t.tenderName} txns`}
                          value={t.count}
                        />
                      ))}
                    </dl>
                  )}
                </CardBody>
              </Card>
            </>
          ) : (
            <>
              <Card>
                <CardHeader
                  title="Deposits & instalments"
                  description="Money taken against something that is not a sale today. The cash among it is part of what the drawer is counted against."
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
                  {/*
                    HOW MUCH OF THIS IS IN THE DRAWER, stated rather than left to
                    be worked out. The figures above are every one of these
                    events; only the ones paid in CASH are money a cashier is
                    counting, and a lay-by settled by card sits in the same list
                    while belonging on the bank statement instead.

                    Rendered only when there is some, so an ordinary shift that
                    took none is not given a line reading R0.00 to think about.
                  */}
                  {view.offLedgerCash !== 0 && (
                    <p className="mt-3 border-t border-border pt-3 text-[13px] text-muted">
                      <span className="numeric font-semibold text-ink">
                        {formatMoney(view.offLedgerCash)}
                      </span>{' '}
                      of this was cash, and is counted in the expected drawer above.
                    </p>
                  )}
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
/**
 * One tender's declaration: the box, and what it is being measured against.
 *
 * Extracted because cash and the machines render identically and only DIFFER in
 * where their figure comes from — cash may be driven by the grid, the rest are
 * always typed. Two copies of this markup is how the cash row quietly drifts
 * into looking like a different control from the ones under it.
 */
function TenderRow({
  tender,
  value,
  expected,
  hint,
  readOnly = false,
  disabled,
  onChange,
  onBlur,
}: {
  tender: VisibleDeclaration['tenders'][number]
  value: number | undefined
  expected: { expected: number; floatIncluded: number } | undefined
  hint: string
  readOnly?: boolean
  disabled: boolean
  onChange: (v: number | undefined) => void
  onBlur: () => void
}) {
  const variance = value !== undefined && expected ? round(value - expected.expected, 2) : null

  return (
    <div className="flex flex-col gap-1">
      <Field label={tender.tenderName} hint={hint}>
        <CurrencyInput
          value={value ?? ''}
          /* "Not counted", never "0.00" — the box must not look declared
             before anybody has counted it. */
          placeholder="Not counted"
          readOnly={readOnly}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value === ''
                ? undefined
                : Number(String(e.target.value).replace(',', '.')) || 0,
            )
          }
          onBlur={onBlur}
        />
      </Field>
      {expected && (
        <p className="text-xs text-muted">
          Expected {formatMoney(expected.expected)}
          {expected.floatIncluded ? ` (float ${formatMoney(expected.floatIncluded)})` : ''}
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
}

function DenominationGrid({
  title,
  rows,
  qty,
  disabled,
  onChange,
  onCommit,
}: {
  title: string
  rows: { id: number; label: string; value: number }[]
  qty: Record<number, number>
  disabled: boolean
  onChange: (id: number, qty: number) => void
  /** Fired on blur, so a counted drawer persists without waiting for Save. */
  onCommit: () => void
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
                    onBlur={onCommit}
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
