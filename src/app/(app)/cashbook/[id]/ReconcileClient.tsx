'use client'

import { Fragment, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Field,
  Input,
  CurrencyInput,
  Textarea,
  Badge,
  Icons,
  Modal,
  MiniStat,
  SegmentedControl,
  EmptyState,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import {
  suggestAction,
  linkAction,
  autoMatchAction,
  completeReconciliationAction,
  captureAction,
  voidAction,
} from '../actions'

/**
 * The reconciliation workbench.
 *
 * ── WHAT THIS SCREEN IS FOR ──────────────────────────────────────────────
 *
 * A person sits here with a bank statement and works down the unmatched list
 * until the difference reaches zero. Everything is arranged around that loop:
 * the difference is always visible, matching is one click from the row, and the
 * sign-off button refuses while the difference is non-zero.
 *
 * The suggestions load PER ROW rather than for the whole list, because scoring
 * 200 lines against 400 candidates on page load is slow and most rows never get
 * looked at — the user works down from the top and stops when it balances.
 */

type UnmatchedLine = {
  id: number
  txnDate: string
  amountSigned: number
  unlinkedAmount: number
  description: string | null
  reference: string | null
  source: string
}

type Suggestion = {
  ledgerTxnId: number
  side: 'customer' | 'supplier'
  partyName: string
  docNumber: string | null
  docDate: string
  amount: number
  confidence: number
  reasons: string[]
}

/* Same hover-reveal DataTable uses: row actions stay out of the way until the
   row is hovered or an action holds focus. TABLE_ROW carries the `group`. */
const HOVER_REVEAL =
  'pointer-fine:opacity-0 pointer-fine:transition-opacity pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100'

export function ReconcileClient({
  accountId,
  accountName,
  bookBalance,
  unmatched,
  initialUnreconciledTotal,
}: {
  accountId: number
  accountName: string
  bookBalance: number
  unmatched: UnmatchedLine[]
  initialUnreconciledTotal: number
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()

  const [statementBalance, setStatementBalance] = useState<number>(
    Number((bookBalance - initialUnreconciledTotal).toFixed(2)),
  )
  const [statementDate, setStatementDate] = useState(todayIso())
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<Record<number, Suggestion[]>>({})
  const [loadingRow, setLoadingRow] = useState<number | null>(null)
  const [captureOpen, setCaptureOpen] = useState(false)
  const [signOffOpen, setSignOffOpen] = useState(false)
  const [notes, setNotes] = useState('')
  const [voidingLine, setVoidingLine] = useState<UnmatchedLine | null>(null)
  const [voidReason, setVoidReason] = useState('')

  // The live difference. Recomputed here rather than fetched so it responds as
  // the statement balance is typed — that immediacy is what makes the screen
  // feel like a worksheet rather than a form.
  const unreconciledTotal = unmatched.reduce((sum, l) => sum + l.unlinkedAmount, 0)
  const difference = Number((bookBalance - unreconciledTotal - statementBalance).toFixed(2))
  const balanced = difference === 0

  function run(action: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(result.message ?? 'Done.')
        router.refresh()
      } else {
        toast.error(result.error ?? 'That did not work.')
      }
    })
  }

  async function loadSuggestions(bankTxnId: number) {
    if (suggestions[bankTxnId]) {
      setOpenRow(openRow === bankTxnId ? null : bankTxnId)
      return
    }
    setLoadingRow(bankTxnId)
    try {
      const found = await suggestAction(bankTxnId)
      setSuggestions((prev) => ({ ...prev, [bankTxnId]: found as Suggestion[] }))
      setOpenRow(bankTxnId)
    } catch {
      toast.error('Could not look for matches.')
    } finally {
      setLoadingRow(null)
    }
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Reconcile"
          description={`Match what the bank says against what ${accountName} says.`}
          action={
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pending || unmatched.length === 0}
                onClick={() => run(() => autoMatchAction(accountId))}
              >
                <Icons.Check size={15} />
                Match what is obvious
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setCaptureOpen(true)}>
                <Icons.Plus size={15} />
                Capture
              </Button>
            </div>
          }
        />

        <CardBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Statement date">
              <Input
                type="date"
                value={statementDate}
                onChange={(e) => setStatementDate(e.target.value)}
              />
            </Field>
            <Field label="Closing balance per statement">
              <CurrencyInput
                value={statementBalance}
                onChange={(e) =>
                  setStatementBalance(Number(String(e.target.value).replace(',', '.')) || 0)
                }
              />
            </Field>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MiniStat label="Our books say" value={formatMoney(bookBalance)} />
            <MiniStat label="Not yet on the statement" value={formatMoney(unreconciledTotal)} />
            <MiniStat label="Bank says" value={formatMoney(statementBalance)} />
            {/* The one number that matters on this screen, so it is the one
                figure given a tone. */}
            <MiniStat
              label="Difference"
              value={formatMoney(difference)}
              tone={balanced ? 'success' : 'danger'}
            />
          </div>
        </CardBody>

        {unmatched.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nothing left to match"
              hint="Every movement on this account is tied to a customer or supplier transaction. Sign off the statement below when the difference reads zero."
            />
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Date</th>
                  <th className={TABLE_TH}>Description</th>
                  <th className={TABLE_TH}>Reference</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Amount</th>
                  <th className={`${TABLE_TH} w-px`} />
                </tr>
              </thead>
              <tbody>
                {unmatched.map((line) => {
                  const rowSuggestions = suggestions[line.id] ?? []
                  const isOpen = openRow === line.id
                  const isLoading = loadingRow === line.id
                  return (
                    <Fragment key={line.id}>
                      <tr className={TABLE_ROW}>
                        <td className={TABLE_TD}>{line.txnDate}</td>
                        <td className={TABLE_TD}>
                          <span className="text-ink">{line.description ?? '—'}</span>
                          {line.source !== 'manual' && (
                            <span className="ml-2 text-xs text-muted">{line.source}</span>
                          )}
                        </td>
                        <td className={TABLE_TD}>
                          <span className="text-muted">{line.reference ?? '—'}</span>
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          <span className={line.amountSigned < 0 ? 'text-danger' : 'text-success'}>
                            {formatMoney(line.amountSigned)}
                          </span>
                        </td>
                        <td className={`${TABLE_TD} text-right`}>
                          <div
                            className={`flex items-center justify-end gap-1.5 ${
                              isOpen || isLoading ? '' : HOVER_REVEAL
                            }`}
                          >
                            <Button
                              variant="ghost"
                              size="sm"
                              iconOnly
                              aria-label={isOpen ? 'Hide suggestions' : 'Find a match'}
                              disabled={isLoading}
                              onClick={() => loadSuggestions(line.id)}
                            >
                              {isLoading ? (
                                <Icons.Spinner size={15} className="animate-spin" />
                              ) : isOpen ? (
                                <Icons.ChevronUp size={15} />
                              ) : (
                                <Icons.Search size={15} />
                              )}
                            </Button>
                            <Button
                              variant="danger-ghost"
                              size="sm"
                              iconOnly
                              aria-label="Void this line"
                              disabled={pending}
                              onClick={() => {
                                setVoidReason('')
                                setVoidingLine(line)
                              }}
                            >
                              <Icons.Trash size={15} />
                            </Button>
                          </div>
                        </td>
                      </tr>

                      {isOpen && (
                        <tr>
                          <td colSpan={5} className="bg-surface-2 px-4 py-3">
                            {rowSuggestions.length === 0 ? (
                              <p className="text-sm text-muted">
                                Nothing on the ledgers matches this amount. It may be a bank
                                charge or a payment that was never captured — use Capture to
                                record it, or post the customer payment first.
                              </p>
                            ) : (
                              <ul className="space-y-2">
                                {rowSuggestions.map((s) => (
                                  <li
                                    key={s.ledgerTxnId}
                                    className="flex items-center justify-between gap-4 rounded-control bg-surface px-3 py-2"
                                  >
                                    <div className="min-w-0">
                                      <span className="text-sm text-ink">{s.partyName}</span>
                                      <span className="ml-2 text-xs text-muted">
                                        {s.docNumber ?? `#${s.ledgerTxnId}`} · {s.docDate}
                                      </span>
                                      <span className="mt-0.5 block text-xs text-muted">
                                        {s.reasons.join(' · ')}
                                      </span>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-3">
                                      {/* Confidence is shown, not hidden: an 62%
                                          guess must look different from a certainty. */}
                                      <Badge
                                        tone={
                                          s.confidence >= 85
                                            ? 'success'
                                            : s.confidence >= 60
                                              ? 'warning'
                                              : 'default'
                                        }
                                      >
                                        {s.confidence}%
                                      </Badge>
                                      <span className="numeric text-sm text-ink">
                                        {formatMoney(s.amount)}
                                      </span>
                                      {/* A positive go, not the screen's primary
                                          — that stays with the sign-off. */}
                                      <Button
                                        variant="success"
                                        size="sm"
                                        disabled={pending}
                                        onClick={() =>
                                          run(() =>
                                            linkAction({
                                              bankAccountId: accountId,
                                              bankTxnId: line.id,
                                              side: s.side,
                                              ledgerTxnId: s.ledgerTxnId,
                                              amount: Math.min(
                                                Math.abs(line.unlinkedAmount),
                                                Math.abs(s.amount),
                                              ),
                                            }),
                                          )
                                        }
                                      >
                                        Match
                                      </Button>
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <CardFooter>
          <div className="flex w-full items-center justify-between">
            <span className="text-sm text-muted">
              {unmatched.length === 0
                ? 'All matched.'
                : `${unmatched.length} line${unmatched.length === 1 ? '' : 's'} still to explain.`}
            </span>
            <Button disabled={pending} onClick={() => setSignOffOpen(true)}>
              <Icons.Check size={15} />
              Sign off statement
            </Button>
          </div>
        </CardFooter>
      </Card>

      <CaptureModal
        open={captureOpen}
        onClose={() => setCaptureOpen(false)}
        accountId={accountId}
        pending={pending}
        onSubmit={(input) => {
          run(() => captureAction(input))
          setCaptureOpen(false)
        }}
      />

      <Modal
        open={voidingLine !== null}
        onClose={() => setVoidingLine(null)}
        title="Void this movement"
      >
        <div className="space-y-4">
          <p className="text-sm text-muted">
            {voidingLine
              ? `${formatMoney(voidingLine.amountSigned)} on ${voidingLine.txnDate} will be
                 marked void and kept, with your reason.`
              : ''}
          </p>
          <Field label="Why is it being voided?">
            <Input
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="e.g. Duplicate import"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setVoidingLine(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || !voidReason.trim()}
              onClick={() => {
                const line = voidingLine
                if (!line) return
                run(() => voidAction(accountId, line.id, voidReason.trim()))
                setVoidingLine(null)
              }}
            >
              Void
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={signOffOpen}
        onClose={() => setSignOffOpen(false)}
        title="Sign off this statement"
      >
        <div className="space-y-4">
          <div className="rounded-control bg-surface-2 px-3 py-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted">Statement date</span>
              <span className="text-ink">{statementDate}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">Statement balance</span>
              <span className="numeric text-ink">{formatMoney(statementBalance)}</span>
            </div>
            <div className="mt-1 flex justify-between">
              <span className="text-muted">Difference</span>
              <span className={`numeric ${balanced ? 'text-success' : 'text-danger'}`}>
                {formatMoney(difference)}
              </span>
            </div>
          </div>

          {!balanced && (
            <>
              <p className="text-sm text-danger">
                This does not balance. Signing off now records the difference as unexplained,
                and it will still be there next month — explain it here so the next person
                knows what happened.
              </p>
              <Field
                label="What is the difference?"
                error={
                  notes.trim()
                    ? undefined
                    : 'Required — an out-of-balance sign-off must say what the difference is.'
                }
              >
                <Textarea
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Bank charged a fee that has not been captured yet"
                />
              </Field>
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSignOffOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={balanced ? 'primary' : 'danger'}
              disabled={pending || (!balanced && !notes.trim())}
              onClick={() => {
                run(() =>
                  completeReconciliationAction({
                    bankAccountId: accountId,
                    statementDate,
                    statementBalance,
                    notes: notes.trim() || undefined,
                    force: !balanced,
                  }),
                )
                setSignOffOpen(false)
                setNotes('')
              }}
            >
              {balanced ? 'Sign off' : 'Sign off with a difference'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

/** Capturing a movement with no sub-ledger side: a bank charge, interest received. */
function CaptureModal({
  open,
  onClose,
  accountId,
  pending,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  accountId: number
  pending: boolean
  onSubmit: (input: {
    bankAccountId: number
    amount: number
    txnDate: string
    description: string
    reference: string
  }) => void
}) {
  const [amount, setAmount] = useState<number>(0)
  const [direction, setDirection] = useState<'in' | 'out'>('out')
  const [date, setDate] = useState(todayIso())
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')

  return (
    <Modal open={open} onClose={onClose} title="Capture a movement">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          For money that has no customer or supplier behind it — bank charges, interest
          received, an owner&apos;s drawing. A customer payment should be captured on their
          account so it settles their invoices.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Direction">
            <SegmentedControl
              aria-label="Direction"
              options={[
                { value: 'out', label: 'Money out' },
                { value: 'in', label: 'Money in' },
              ]}
              value={direction}
              onChange={setDirection}
            />
          </Field>
        </div>

        <Field label="Amount">
          <CurrencyInput
            value={amount}
            onChange={(e) => setAmount(Number(String(e.target.value).replace(',', '.')) || 0)}
          />
        </Field>

        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Monthly service fee"
          />
        </Field>

        <Field label="Reference" hint="Optional">
          <Input value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={pending || amount <= 0 || !description.trim()}
            onClick={() =>
              onSubmit({
                bankAccountId: accountId,
                amount: direction === 'out' ? -amount : amount,
                txnDate: date,
                description: description.trim(),
                reference: reference.trim(),
              })
            }
          >
            Capture
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
