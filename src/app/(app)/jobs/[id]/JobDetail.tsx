'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  Checkbox,
  Field,
  Input,
  NumberInput,
  Select,
  Textarea,
  Modal,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  EmptyState,
  Icons,
  TextLink,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_TD_INPUT,
  TABLE_NUMERIC,
  type BadgeTone,
} from '@/components/ui'
import { formatMoney, formatQty } from '@/lib/decimals'
import type { JobCardDetail, JobCardLine, JobLineInput } from '@/lib/site/jobCards'
import type { JobStatus } from '@/lib/site/jobStatuses'
import type { BillableLine } from '@/lib/site/jobInvoicing'
import type { ActivityEvent } from '@/lib/site/activityLog'
import type { JobQuote, QuoteVariance } from '@/lib/site/jobQuotes'
import {
  ACCEPT_METHODS,
  ACCEPT_METHOD_LABEL,
  BILLING_STATE_HINT,
  BILLING_STATE_LABEL,
  BILLING_STATE_TONE,
  BILLING_TRANSITIONS,
  LINE_KINDS,
  LINE_KIND_LABEL,
  LINE_KIND_UNIT,
  methodNeedsReference,
  reclassifyNeedsReason,
  type AcceptMethod,
  type BillingState,
  type JobLineKind,
} from '@/lib/jobStatusModel'
import {
  saveLinesAction,
  setStatusAction,
  assignOwnerAction,
  reclassifyLineAction,
  closeJobAction,
  cancelJobAction,
  reopenJobAction,
  invoiceJobAction,
  quoteJobAction,
  acceptQuoteAction,
  declineQuoteAction,
} from '../actions'

const TONE: Record<string, BadgeTone> = {
  neutral: 'neutral',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
}

type Draft = JobLineInput & { key: string; invoicedQty: number; locked: boolean }

function toDraft(line: JobCardLine): Draft {
  return {
    key: `l${line.id}`,
    id: line.id,
    lineKind: line.lineKind,
    billingState: line.billingState,
    productId: line.productId,
    productCode: line.productCode,
    description: line.description,
    qty: line.qty,
    unitCostExcl: line.unitCostExcl,
    unitPriceIncl: line.unitPriceIncl,
    vatRatePct: line.vatRatePct,
    discountPct: line.discountPct,
    note: line.note,
    invoicedQty: line.invoicedQty,
    // An invoiced line is evidence of something a customer was charged for.
    // Editing its quantity would make the invoice and the job disagree.
    locked: line.invoicedQty > 0,
  }
}

/**
 * The working surface of a job card.
 *
 * ── WHY THE COST LINES ARE A HAND-BUILT TABLE ──────────────────────────────
 *
 * DataTable renders values; these cells hold live inputs, which it cannot
 * express. So the table is built by hand but wears the shared skin — TABLE,
 * TABLE_TH, TABLE_TD, TABLE_NUMERIC — which is exactly what those constants are
 * exported for. DataTable itself uses them, so the two cannot drift.
 *
 * ── WHAT MONEY IS SHOWN, AND TO WHOM ───────────────────────────────────────
 *
 * The cost and price columns render only with `can.cost`. This is not a hidden
 * div: the server did not send the figures. The PRD requires a technician to be
 * able to record what they used without seeing what it cost or what it sells for,
 * and the only way to honour that is to not have the numbers in the page.
 */
export default function JobDetail({
  job,
  tab,
  statuses,
  billable,
  activity,
  quotes,
  variance,
  can,
}: {
  job: JobCardDetail
  /**
   * Which section to draw. `files` never reaches here — the page renders the
   * shared AttachmentsPanel for that one directly, because there is nothing
   * job-specific about it.
   *
   * One component rather than three, because the dialogs and the mutation
   * handlers are shared: splitting it would put the billing decision dialog in
   * the Costs file and the close dialog in the Overview file, and the two would
   * drift apart on the next change.
   */
  tab: 'overview' | 'costs' | 'quotes' | 'history'
  statuses: JobStatus[]
  billable: BillableLine[]
  activity: ActivityEvent[]
  quotes: JobQuote[]
  variance: QuoteVariance
  can: {
    edit: boolean
    assign: boolean
    close: boolean
    invoice: boolean
    decide: boolean
    cost: boolean
  }
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()

  const [lines, setLines] = useState<Draft[]>(job.lines.map(toDraft))
  const [dirty, setDirty] = useState(false)

  const [owner, setOwner] = useState(job.ownerName)
  const [statusId, setStatusId] = useState(job.statusId)

  const [decide, setDecide] = useState<{ line: JobCardLine; to: BillingState | '' } | null>(null)
  const [decideReason, setDecideReason] = useState('')
  const [closing, setClosing] = useState<'close' | 'cancel' | 'reopen' | null>(null)
  const [closeReason, setCloseReason] = useState('')
  const [billing, setBilling] = useState(false)
  const [picked, setPicked] = useState<Record<number, boolean>>({})

  const [accepting, setAccepting] = useState<JobQuote | null>(null)
  const [method, setMethod] = useState<AcceptMethod>('verbal')
  const [acceptedBy, setAcceptedBy] = useState('')
  const [acceptRef, setAcceptRef] = useState('')
  const [declining, setDeclining] = useState<JobQuote | null>(null)
  const [declineReason, setDeclineReason] = useState('')

  function patch(key: string, change: Partial<Draft>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...change } : l)))
    setDirty(true)
  }

  function addLine(kind: JobLineKind) {
    setLines((current) => [
      ...current,
      {
        key: `n${current.length}-${kind}`,
        id: null,
        lineKind: kind,
        billingState: 'pending',
        productId: null,
        productCode: null,
        description: '',
        qty: kind === 'part' ? 1 : 0,
        unitCostExcl: 0,
        unitPriceIncl: 0,
        vatRatePct: 15,
        discountPct: 0,
        note: null,
        invoicedQty: 0,
        locked: false,
      },
    ])
    setDirty(true)
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key))
    setDirty(true)
  }

  function saveLines() {
    start(async () => {
      const payload: JobLineInput[] = lines.map((l) => ({
        id: l.id,
        lineKind: l.lineKind,
        billingState: l.billingState,
        productId: l.productId,
        productCode: l.productCode,
        description: l.description,
        qty: l.qty,
        unitCostExcl: l.unitCostExcl,
        unitPriceIncl: l.unitPriceIncl,
        vatRatePct: l.vatRatePct,
        discountPct: l.discountPct,
        note: l.note,
      }))
      const result = await saveLinesAction(job.id, payload)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Lines saved.')
      setDirty(false)
      router.refresh()
    })
  }

  function moveStatus(next: number) {
    setStatusId(next)
    start(async () => {
      const result = await setStatusAction(job.id, next)
      if (!result.ok) {
        toast.error(result.error)
        setStatusId(job.statusId)
        return
      }
      toast.success('Status updated.')
      router.refresh()
    })
  }

  function saveOwner() {
    start(async () => {
      const result = await assignOwnerAction(job.id, job.ownerUserId, owner)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(owner ? `Assigned to ${owner}.` : 'Assignment cleared.')
      router.refresh()
    })
  }

  function applyDecision() {
    if (!decide || !decide.to) return
    start(async () => {
      const result = await reclassifyLineAction(job.id, decide.line.id, decide.to as BillingState, decideReason || null)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Recorded.')
      setDecide(null)
      setDecideReason('')
      router.refresh()
    })
  }

  function applyClosing() {
    if (!closing) return
    start(async () => {
      const result =
        closing === 'close'
          ? await closeJobAction(job.id, closeReason || undefined)
          : closing === 'cancel'
            ? await cancelJobAction(job.id, closeReason)
            : await reopenJobAction(job.id, closeReason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        closing === 'close' ? 'Job closed.' : closing === 'cancel' ? 'Job cancelled.' : 'Job reopened.',
      )
      setClosing(null)
      setCloseReason('')
      router.refresh()
    })
  }

  function raiseInvoice() {
    const selections = billable
      .filter((line) => picked[line.id])
      .map((line) => ({ lineId: line.id, qty: line.outstandingQty }))

    if (selections.length === 0) {
      toast.error('Choose at least one line to invoice.')
      return
    }

    start(async () => {
      const result = await invoiceJobAction(job.id, selections)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(`Draft invoice raised for ${formatMoney(result.totalIncl)}.`)
      setBilling(false)
      setPicked({})
      router.push(`/sales/invoicing/${result.invoiceId}`)
    })
  }

  const pickedTotal = billable
    .filter((line) => picked[line.id])
    .reduce((sum, line) => sum + line.outstandingValue, 0)

  function raiseQuote() {
    start(async () => {
      const result = await quoteJobAction(job.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(
        result.revision === 1
          ? `Quote ${result.documentNumber ?? ''} raised.`
          : `Quote ${result.documentNumber ?? ''} (v${result.revision}) raised — it needs accepting again.`,
      )
      router.refresh()
    })
  }

  function acceptIt() {
    if (!accepting) return
    start(async () => {
      const result = await acceptQuoteAction(job.id, accepting.id, {
        method,
        acceptedBy,
        reference: acceptRef || null,
      })
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Acceptance recorded.')
      setAccepting(null)
      setAcceptedBy('')
      setAcceptRef('')
      router.refresh()
    })
  }

  function declineIt() {
    if (!declining) return
    start(async () => {
      const result = await declineQuoteAction(job.id, declining.id, declineReason)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success('Recorded.')
      setDeclining(null)
      setDeclineReason('')
      router.refresh()
    })
  }

  return (
    <>
      {/* ── The job, and what to do with it ───────────────────────────── */}
      {tab === 'overview' && (
      <Card>
        <CardHeader
          title="The job"
          description={job.description ?? 'No detail was recorded.'}
          action={
            <TextLink href={job.customerId ? `/customers/${job.customerId}` : '/jobs'}>
              {job.customerName ?? 'Walk-in'}
            </TextLink>
          }
        />
        <CardBody>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Status" hint={can.edit ? 'Moving it here records who and when.' : undefined}>
              <Select
                value={String(statusId)}
                disabled={!can.edit || pending}
                onChange={(e) => moveStatus(Number(e.target.value))}
              >
                {statuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Assigned to" hint={can.assign ? 'A name, for now.' : undefined}>
              <div className="flex gap-2">
                <Input
                  value={owner}
                  disabled={!can.assign || pending}
                  onChange={(e) => setOwner(e.target.value)}
                  placeholder="Nobody"
                />
                {can.assign && owner !== job.ownerName && (
                  <Button variant="secondary" size="sm" onClick={saveOwner} disabled={pending}>
                    Save
                  </Button>
                )}
              </div>
            </Field>

            <Field label="Reported">
              <Input value={job.reportedAt.slice(0, 16).replace('T', ' ')} readOnly disabled />
            </Field>
          </div>
        </CardBody>
        <CardFooter>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-muted">
              Logged by {job.userName || 'somebody'}
              {job.reference ? ` · their ref ${job.reference}` : ''}
            </div>
            <div className="flex gap-2">
              {can.edit && !job.isClosed && (
                <Button variant="secondary" size="sm" onClick={() => router.push(`/jobs/${job.id}/edit`)}>
                  <Icons.Pencil size={14} />
                  Edit details
                </Button>
              )}
              {can.close && !job.isClosed && (
                <>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    onClick={() => setClosing('cancel')}
                    disabled={pending}
                  >
                    Cancel job
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => setClosing('close')} disabled={pending}>
                    <Icons.Check size={14} />
                    Mark complete
                  </Button>
                </>
              )}
              {can.close && job.isClosed && job.status !== 'cancelled' && (
                <Button variant="secondary" size="sm" onClick={() => setClosing('reopen')} disabled={pending}>
                  <Icons.Refresh size={14} />
                  Reopen
                </Button>
              )}
            </div>
          </div>
        </CardFooter>
      </Card>
      )}

      {/* ── What was used ─────────────────────────────────────────────── */}
      {tab === 'costs' && (
      <Card>
        <CardHeader
          title="What was used"
          description={
            can.cost
              ? 'Parts, hours, travel and charges. Each line records who pays for it.'
              : 'Parts, hours, travel and charges. Somebody in the office decides what is charged.'
          }
          action={
            can.edit && !job.isClosed ? (
              <div className="flex gap-1.5">
                {LINE_KINDS.map((kind) => (
                  <Button key={kind} variant="ghost" size="sm" onClick={() => addLine(kind)}>
                    <Icons.Plus size={13} />
                    {LINE_KIND_LABEL[kind]}
                  </Button>
                ))}
              </div>
            ) : undefined
          }
        />
        <CardBody className="p-0">
          {lines.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              hint="Add the parts fitted, the hours worked and the kilometres travelled. Every line is a cost, and each one gets a decision about who pays."
              icon={<Icons.Wrench size={22} />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Kind</th>
                    <th className={TABLE_TH}>Description</th>
                    {/* pr-10 clears the unit label beside the input, so the
                        heading sits over the figures rather than over the "km". */}
                    <th className={`${TABLE_TH} ${TABLE_NUMERIC} pr-10`}>Qty</th>
                    {can.cost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Cost</th>}
                    {can.cost && <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Price</th>}
                    <th className={TABLE_TH}>Who pays</th>
                    <th className={TABLE_TH} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const stored = job.lines.find((l) => l.id === line.id)
                    const editable = can.edit && !job.isClosed && !line.locked
                    return (
                      <tr key={line.key}>
                        <td className={TABLE_TD_INPUT}>
                          <Select
                            value={line.lineKind}
                            disabled={!editable || pending}
                            onChange={(e) => patch(line.key, { lineKind: e.target.value as JobLineKind })}
                            className="w-28"
                          >
                            {LINE_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {LINE_KIND_LABEL[kind]}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className={TABLE_TD_INPUT}>
                          <Input
                            value={line.description}
                            disabled={!editable || pending}
                            onChange={(e) => patch(line.key, { description: e.target.value })}
                            placeholder="What it was"
                          />
                        </td>
                        <td className={TABLE_TD_INPUT}>
                          {/* The unit sits outside the input so the figures still
                              line up: hours and km have different label widths,
                              and putting them inside would stagger the column. */}
                          <div className="flex items-center justify-end gap-1.5">
                            <NumberInput
                              value={line.qty}
                              disabled={!editable || pending}
                              onChange={(e) => patch(line.key, { qty: Number(e.target.value) })}
                              className="numeric w-20 text-right"
                            />
                            <span className="w-8 text-xs text-muted">
                              {LINE_KIND_UNIT[line.lineKind]}
                            </span>
                          </div>
                        </td>
                        {can.cost && (
                          <td className={TABLE_TD_INPUT}>
                            <NumberInput
                              value={line.unitCostExcl}
                              disabled={!editable || pending}
                              onChange={(e) => patch(line.key, { unitCostExcl: Number(e.target.value) })}
                              className="numeric w-24 text-right"
                            />
                          </td>
                        )}
                        {can.cost && (
                          <td className={TABLE_TD_INPUT}>
                            <NumberInput
                              value={line.unitPriceIncl}
                              disabled={!editable || pending}
                              onChange={(e) => patch(line.key, { unitPriceIncl: Number(e.target.value) })}
                              className="numeric w-24 text-right"
                            />
                          </td>
                        )}
                        <td className={TABLE_TD}>
                          <div className="flex items-center gap-2">
                            <Badge tone={TONE[BILLING_STATE_TONE[line.billingState]] ?? 'neutral'}>
                              {BILLING_STATE_LABEL[line.billingState]}
                            </Badge>
                            {can.decide &&
                              stored &&
                              !line.locked &&
                              BILLING_TRANSITIONS[line.billingState].length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setDecide({ line: stored, to: '' })
                                    setDecideReason('')
                                  }}
                                >
                                  Decide
                                </Button>
                              )}
                          </div>
                        </td>
                        <td className={TABLE_TD}>
                          {line.locked ? (
                            <span className="text-xs text-muted">
                              Invoiced {formatQty(line.invoicedQty)}
                            </span>
                          ) : (
                            editable && (
                              <Button
                                variant="danger-ghost"
                                size="sm"
                                iconOnly
                                aria-label="Remove line"
                                onClick={() => removeLine(line.key)}
                              >
                                <Icons.Trash size={14} />
                              </Button>
                            )
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
        {can.edit && !job.isClosed && lines.length > 0 && (
          <CardFooter>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">
                {dirty ? 'Unsaved changes.' : 'Saved.'} New lines start as awaiting a decision.
              </span>
              <Button variant="primary" size="sm" onClick={saveLines} disabled={pending || !dirty}>
                <Icons.Save size={14} />
                Save lines
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>
      )}

      {/* ── The money ─────────────────────────────────────────────────── */}
      {tab === 'costs' && can.cost && (
        <Card>
          <CardHeader
            title="Cost and revenue"
            description="Cost counts everything, including what we chose not to charge for. Revenue is what the invoices actually say."
            action={
              can.invoice && billable.length > 0 && !job.isClosed ? (
                <Button variant="primary" size="sm" onClick={() => setBilling(true)} disabled={pending}>
                  <Icons.FileText size={14} />
                  Bill the job
                </Button>
              ) : undefined
            }
          />
          <CardBody>
            <div className="grid gap-6 sm:grid-cols-2">
              <SummaryList>
                <SummaryRow label="Quoted" value={formatMoney(job.totals.quoted)} />
                <SummaryRow label="Variations and extras" value={formatMoney(job.totals.extras)} />
                <SummaryRow
                  label="Awaiting a decision"
                  value={formatMoney(job.totals.pending)}
                  tone={job.totals.pending > 0 ? 'warning' : 'muted'}
                />
                <SummaryRow
                  label="Absorbed (internal or written off)"
                  value={formatMoney(job.totals.absorbed)}
                  tone={job.totals.absorbed > 0 ? 'warning' : 'muted'}
                />
                <SummaryRow
                  label="Billable, not yet invoiced"
                  value={formatMoney(job.totals.uninvoiced)}
                />
              </SummaryList>

              <SummaryList>
                <SummaryRow label="Total cost" value={formatMoney(job.totals.cost)} />
                <SummaryRow label="Invoiced" value={formatMoney(job.totals.invoiced)} />
                {job.totals.profit === null ? (
                  <SummaryRow label="Gross profit" value="—" tone="muted" />
                ) : (
                  <SummaryTotal
                    label={`Gross profit${job.totals.marginPct === null ? '' : ` · ${job.totals.marginPct}%`}`}
                    value={formatMoney(job.totals.profit)}
                    tone={job.totals.profit < 0 ? 'danger' : 'default'}
                  />
                )}
              </SummaryList>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ── Paper this job produced ───────────────────────────────────── */}
      {tab === 'costs' && job.documents.length > 0 && (
        <Card>
          <CardHeader title="Quotes and invoices" description="Every document raised from this job." />
          <CardBody className="p-0">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Document</th>
                  <th className={TABLE_TH}>Kind</th>
                  <th className={TABLE_TH}>Date</th>
                  <th className={TABLE_TH}>Status</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {job.documents.map((doc) => (
                  <tr key={doc.id}>
                    <td className={TABLE_TD}>
                      <TextLink href={`/sales/invoicing/${doc.id}`}>
                        {doc.documentNumber ?? 'Draft'}
                      </TextLink>
                    </td>
                    <td className={TABLE_TD}>{doc.docType === 'quote' ? 'Quote' : 'Invoice'}</td>
                    <td className={TABLE_TD}>{doc.documentDate}</td>
                    <td className={TABLE_TD}>
                      <Badge tone={doc.status === 'finalised' ? 'success' : 'neutral'}>{doc.status}</Badge>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(doc.totalIncl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      {/* ── Quotes ────────────────────────────────────────────────────── */}
      {tab === 'quotes' && (
        <>
          {variance.quotedTotal !== null && (
            <Card>
              <CardHeader
                title="Quoted versus actual"
                description={`Measured against ${variance.quotedNumber ?? 'the accepted quote'}${variance.quotedRevision && variance.quotedRevision > 1 ? ` (v${variance.quotedRevision})` : ''}.`}
              />
              <CardBody>
                <div className="grid gap-6 sm:grid-cols-2">
                  <SummaryList>
                    <SummaryRow label="Accepted quote" value={formatMoney(variance.quotedTotal)} />
                    <SummaryRow
                      label="Chargeable work now"
                      value={formatMoney(variance.chargeableTotal)}
                    />
                    {/* The sign IS the information: a bare figure cannot say
                        whether the job grew or came in under. */}
                    <SummaryTotal
                      label={
                        variance.variance === null || variance.variance === 0
                          ? 'On the quote'
                          : variance.variance > 0
                            ? `Over the quote${variance.variancePct === null ? '' : ` by ${variance.variancePct}%`}`
                            : 'Under the quote'
                      }
                      value={formatMoney(variance.variance ?? 0)}
                      tone={variance.variance !== null && variance.variance > 0 ? 'danger' : 'default'}
                    />
                  </SummaryList>

                  <div>
                    {variance.unquotedLines.length === 0 ? (
                      <p className="text-sm text-muted">
                        Everything chargeable on this job is on the accepted quote.
                      </p>
                    ) : (
                      <>
                        <p className="mb-2 text-sm text-warning-ink">
                          {variance.unquotedLines.length}{' '}
                          {variance.unquotedLines.length === 1 ? 'line was' : 'lines were'} added
                          after the quote and never went back to the customer:
                        </p>
                        <SummaryList>
                          {variance.unquotedLines.map((line) => (
                            <SummaryRow
                              key={line.id}
                              label={line.description}
                              value={formatMoney(line.value)}
                              tone="warning"
                            />
                          ))}
                        </SummaryList>
                      </>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Quotes"
              description="Every version offered, and what became of it. A new version never overwrites an old one — what the customer was quoted is what gets disputed."
              action={
                can.invoice && !job.isClosed ? (
                  <Button variant="secondary" size="sm" onClick={raiseQuote} disabled={pending}>
                    <Icons.Plus size={14} />
                    {quotes.length === 0 ? 'Raise a quote' : 'Raise a new version'}
                  </Button>
                ) : undefined
              }
            />
            <CardBody className="p-0">
              {quotes.length === 0 ? (
                <EmptyState
                  title="Nothing quoted yet"
                  hint="A quote is built from whatever is marked chargeable on the Costs tab. Decide who pays for the lines first, then raise it."
                  icon={<Icons.FileText size={22} />}
                />
              ) : (
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Quote</th>
                      <th className={TABLE_TH}>Outcome</th>
                      <th className={TABLE_TH}>How we know</th>
                      <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Total</th>
                      <th className={TABLE_TH} />
                    </tr>
                  </thead>
                  <tbody>
                    {quotes.map((quote) => (
                      <tr key={quote.id}>
                        <td className={TABLE_TD}>
                          <div className="flex items-center gap-2">
                            <TextLink href={`/sales/invoicing/${quote.id}`}>
                              {quote.documentNumber ?? 'Draft'}
                            </TextLink>
                            {quote.revision > 1 && (
                              <span className="text-xs text-muted">v{quote.revision}</span>
                            )}
                            {/* Which version is the live authorisation. The one
                                fact somebody scanning this table needs. */}
                            {quote.isLive && <Badge tone="success">Live</Badge>}
                            {quote.supersededById !== null && (
                              <span className="text-xs text-faint">Replaced</span>
                            )}
                          </div>
                        </td>
                        <td className={TABLE_TD}>
                          {quote.outcome === 'accepted' ? (
                            <Badge tone="success">Accepted</Badge>
                          ) : quote.outcome === 'declined' ? (
                            <Badge tone="danger">Declined</Badge>
                          ) : (
                            <Badge tone="neutral">Awaiting an answer</Badge>
                          )}
                        </td>
                        <td className={TABLE_TD}>
                          {quote.outcome === 'accepted' && quote.acceptMethod ? (
                            <span className="text-ink-2">
                              {ACCEPT_METHOD_LABEL[quote.acceptMethod]}
                              {quote.acceptedBy ? ` — ${quote.acceptedBy}` : ''}
                              {quote.acceptReference ? (
                                <span className="text-muted"> ({quote.acceptReference})</span>
                              ) : null}
                            </span>
                          ) : quote.outcome === 'declined' && quote.lostReason ? (
                            <span className="text-muted">{quote.lostReason}</span>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(quote.totalIncl)}
                        </td>
                        <td className={TABLE_TD}>
                          {/* Only the newest un-decided version can be answered:
                              an older one is history the moment it is replaced. */}
                          {can.invoice &&
                            quote.outcome === 'open' &&
                            quote.supersededById === null &&
                            !job.isClosed && (
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={pending}
                                  onClick={() => {
                                    setDeclining(quote)
                                    setDeclineReason('')
                                  }}
                                >
                                  Declined
                                </Button>
                                <Button
                                  variant="primary"
                                  size="sm"
                                  disabled={pending}
                                  onClick={() => {
                                    setAccepting(quote)
                                    setMethod('verbal')
                                    setAcceptedBy(job.customerName ?? '')
                                    setAcceptRef('')
                                  }}
                                >
                                  <Icons.Check size={14} />
                                  Accepted
                                </Button>
                              </div>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </>
      )}

      {/* ── History ───────────────────────────────────────────────────── */}
      {tab === 'history' && (
      <Card>
        <CardHeader title="History" description="What happened to this job, and who did it." />
        <CardBody>
          {activity.length === 0 ? (
            <span className="text-sm text-muted">Nothing recorded yet.</span>
          ) : (
            <ol className="flex flex-col gap-3">
              {activity.map((event) => (
                <li key={event.id} className="flex gap-3 text-sm">
                  <span className="w-32 shrink-0 text-xs text-muted">
                    {new Date(event.createdAt).toLocaleString('en-ZA', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-ink-2">
                    {event.detail ?? event.action.replace(/_/g, ' ')}
                    <span className="text-muted"> — {event.userName || 'system'}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
      )}

      {/* ── Dialogs ───────────────────────────────────────────────────── */}
      {/* Outside every tab gate: the decision dialog is opened from Costs and
          the close dialog from Overview, and both must survive whichever tab is
          on screen when the mutation resolves. */}
      <Modal
        open={decide !== null}
        onClose={() => setDecide(null)}
        title="Who pays for this?"
        size="sm"
      >
        {decide && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">{decide.line.description}</p>
            <Field label="Classify it as">
              <Select
                value={decide.to}
                onChange={(e) => setDecide({ ...decide, to: e.target.value as BillingState })}
              >
                <option value="">Choose…</option>
                {BILLING_TRANSITIONS[decide.line.billingState].map((state) => (
                  <option key={state} value={state}>
                    {BILLING_STATE_LABEL[state]}
                  </option>
                ))}
              </Select>
            </Field>
            {decide.to && <p className="text-xs text-muted">{BILLING_STATE_HINT[decide.to]}</p>}
            {decide.to && reclassifyNeedsReason(decide.to) && (
              <Field label="Why" hint="Recorded against the job, with your name.">
                <Textarea
                  value={decideReason}
                  onChange={(e) => setDecideReason(e.target.value)}
                  rows={2}
                  placeholder="Under warranty — compressor failed within 12 months."
                />
              </Field>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDecide(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={applyDecision}
                disabled={
                  pending ||
                  !decide.to ||
                  (reclassifyNeedsReason(decide.to as BillingState) && !decideReason.trim())
                }
              >
                Record it
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={
          closing === 'close' ? 'Mark the job complete' : closing === 'cancel' ? 'Cancel the job' : 'Reopen the job'
        }
        size="sm"
      >
        <div className="flex flex-col gap-4">
          {closing === 'close' && job.totals.pendingCount > 0 && (
            <p className="text-sm text-warning-ink">
              {job.totals.pendingCount === 1 ? 'One line is' : `${job.totals.pendingCount} lines are`}{' '}
              still awaiting a billing decision. The job cannot close until each is decided.
            </p>
          )}
          <Field
            label={closing === 'close' ? 'Note (optional)' : 'Reason'}
            hint="Recorded against the job."
          >
            <Textarea
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value)}
              rows={2}
              placeholder={
                closing === 'cancel' ? 'Customer went elsewhere.' : closing === 'reopen' ? 'Fault came back.' : ''
              }
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setClosing(null)} disabled={pending}>
              Back
            </Button>
            <Button
              variant={closing === 'cancel' ? 'danger' : 'primary'}
              onClick={applyClosing}
              disabled={pending || (closing !== 'close' && !closeReason.trim())}
            >
              {closing === 'close' ? 'Complete' : closing === 'cancel' ? 'Cancel the job' : 'Reopen'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={accepting !== null}
        onClose={() => setAccepting(null)}
        title="Record the acceptance"
        size="sm"
      >
        {accepting && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted">
              {accepting.documentNumber ?? 'This quote'} — {formatMoney(accepting.totalIncl)}
            </p>

            <Field
              label="How do we know?"
              hint="Recorded against the job. Which one it was is what a dispute turns on."
            >
              <Select value={method} onChange={(e) => setMethod(e.target.value as AcceptMethod)}>
                {ACCEPT_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {ACCEPT_METHOD_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Who accepted it"
              hint="A contact name, or whoever authorised the work. Often not the account holder."
            >
              <Input
                value={acceptedBy}
                onChange={(e) => setAcceptedBy(e.target.value)}
                placeholder="Mrs Naidoo"
              />
            </Field>

            {methodNeedsReference(method) && (
              <Field
                label={method === 'email' ? 'Where to find the email' : 'What was signed'}
                hint="Enough to go and find it again."
              >
                <Input
                  value={acceptRef}
                  onChange={(e) => setAcceptRef(e.target.value)}
                  placeholder={method === 'email' ? 'Re: Quote QUO000042, 11 Aug' : 'Worksheet signed on site'}
                />
              </Field>
            )}

            {method === 'internal' && (
              <p className="text-xs text-muted">
                Recorded as accepted on the customer&apos;s behalf, with your name against it.
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAccepting(null)} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={acceptIt}
                disabled={
                  pending ||
                  !acceptedBy.trim() ||
                  (methodNeedsReference(method) && !acceptRef.trim())
                }
              >
                Record it
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={declining !== null}
        onClose={() => setDeclining(null)}
        title="The customer said no"
        size="sm"
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Why was it turned down?"
            hint="One lost quote says nothing. A pattern in the reasons is worth having."
          >
            <Textarea
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              rows={2}
              placeholder="Went with a cheaper quote."
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeclining(null)} disabled={pending}>
              Back
            </Button>
            <Button variant="primary" onClick={declineIt} disabled={pending || !declineReason.trim()}>
              Record it
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={billing} onClose={() => setBilling(false)} title="Bill the job" size="lg">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            This raises a <strong className="text-ink">draft</strong> invoice. Nothing is posted and no
            stock moves until somebody finalises it on the invoicing screen.
          </p>
          <table className={TABLE}>
            <thead>
              <tr className={TABLE_HEAD_ROW}>
                <th className={TABLE_TH} />
                <th className={TABLE_TH}>Line</th>
                <th className={TABLE_TH}>Who pays</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>To invoice</th>
                <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Value</th>
              </tr>
            </thead>
            <tbody>
              {billable.map((line) => (
                <tr key={line.id}>
                  <td className={TABLE_TD}>
                    <Checkbox
                      checked={picked[line.id] ?? false}
                      onChange={(e) => setPicked({ ...picked, [line.id]: e.target.checked })}
                      aria-label={`Invoice ${line.description}`}
                    />
                  </td>
                  <td className={TABLE_TD}>{line.description}</td>
                  <td className={TABLE_TD}>
                    <Badge tone={TONE[BILLING_STATE_TONE[line.billingState]] ?? 'neutral'}>
                      {BILLING_STATE_LABEL[line.billingState]}
                    </Badge>
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.outstandingQty)}</td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(line.outstandingValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3">
            <span className="numeric text-sm text-ink">Selected: {formatMoney(pickedTotal)}</span>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setBilling(false)} disabled={pending}>
                Cancel
              </Button>
              <Button variant="primary" onClick={raiseInvoice} disabled={pending || pickedTotal === 0}>
                Raise draft invoice
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  )
}
