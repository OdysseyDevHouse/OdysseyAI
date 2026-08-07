'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  Button,
  Card,
  CardHeader,
  CardBody,
  Callout,
  Badge,
  DataTable,
  EmptyState,
  StatTile,
  Modal,
  Field,
  Input,
  Select,
  Textarea,
  CurrencyInput,
  SummaryList,
  SummaryRow,
  useToast,
  type Column,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { RISK_LABELS, PROMISE_LABELS, type RiskBand, type PromiseState } from '@/lib/creditModel'
import {
  createPromiseAction,
  logContactAction,
  pauseChasingAction,
  resumeChasingAction,
  holdAccountAction,
  releaseAccountAction,
} from '../../credit/actions'

export type CreditTabData = {
  customerId: number
  balance: number
  creditLimit: number
  overdueAmount: number
  oldestDays: number
  dunningLevel: number
  lastDunnedAt: string | null
  pausedUntil: string | null
  pauseReason: string | null
  isHeld: boolean
  holdReason: string | null
  risk: RiskBand
  riskReason: string
  promisesKept: number
  promisesBroken: number
  reliabilityRate: number | null
  reliabilityDecided: number
  promises: {
    id: number
    promisedDate: string
    promisedAmount: number
    receivedAmount: number
    state: PromiseState
    promisedBy: string | null
  }[]
  contacts: {
    id: number
    contactDate: string
    kind: string
    outcome: string
    summary: string
    detail: string | null
    userName: string
  }[]
  documents: {
    id: number
    docNumber: string | null
    docDate: string
    dueDate: string | null
    daysOverdue: number
    outstanding: number
  }[]
}

const OUTCOME_LABEL: Record<string, string> = {
  promised: 'Promised to pay',
  disputed: 'Disputed',
  no_answer: 'No answer',
  paid: 'Paid',
  refused: 'Refused',
  none: 'Logged',
}

/**
 * One account's credit picture, for the person on the phone.
 *
 * ── WHAT A COLLECTOR NEEDS IN THE FIRST FIVE SECONDS ─────────────────────
 *
 * Whether this customer keeps their word, what was already said to them, and
 * what is actually overdue. In that order — the reliability record changes how
 * the call opens, and the contact history stops the same debt being chased
 * twice by two people who each think they are first.
 *
 * Everything actionable is here rather than on the collections list, because
 * this is the screen someone has open while the customer is talking.
 */
export function CreditTab({ data, canManage }: { data: CreditTabData; canManage: boolean }) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [promising, setPromising] = useState(false)
  const [logging, setLogging] = useState(false)
  const [pausing, setPausing] = useState(false)

  const [promiseDate, setPromiseDate] = useState('')
  const [promiseAmount, setPromiseAmount] = useState(String(data.overdueAmount || ''))
  const [promiseBy, setPromiseBy] = useState('')

  const [kind, setKind] = useState('call')
  const [outcome, setOutcome] = useState('none')
  const [summary, setSummary] = useState('')
  const [detail, setDetail] = useState('')

  const [pauseUntil, setPauseUntil] = useState('')
  const [pauseReason, setPauseReason] = useState('')

  const openPromise = data.promises.find((p) => p.state === 'open' || p.state === 'due-today')

  function run(fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    start(async () => {
      const result = await fn()
      if (result.ok) toast.success(result.message)
      else toast.error(result.error)
      setPromising(false)
      setLogging(false)
      setPausing(false)
      setSummary('')
      setDetail('')
      router.refresh()
    })
  }

  const docColumns: Column<CreditTabData['documents'][number]>[] = [
    {
      key: 'doc',
      header: 'Document',
      cell: (d) => <span className="text-ink">{d.docNumber ?? `#${d.id}`}</span>,
      sortValue: (d) => d.docNumber ?? '',
    },
    {
      key: 'date',
      header: 'Dated',
      cell: (d) => <span className="text-ink-2">{d.docDate}</span>,
      sortValue: (d) => d.docDate,
    },
    {
      key: 'due',
      header: 'Due',
      cell: (d) =>
        d.dueDate === null ? (
          <span className="text-faint">—</span>
        ) : (
          <>
            <span className={d.daysOverdue > 0 ? 'text-danger' : 'text-ink-2'}>{d.dueDate}</span>
            {d.daysOverdue > 0 && (
              <span className="mt-0.5 block text-xs text-danger">
                {d.daysOverdue} days overdue
              </span>
            )}
          </>
        ),
      sortValue: (d) => d.dueDate ?? '',
    },
    {
      key: 'amount',
      header: 'Outstanding',
      numeric: true,
      cell: (d) => <span className="text-ink">{formatMoney(d.outstanding)}</span>,
      sortValue: (d) => d.outstanding,
    },
  ]

  return (
    <>
      {data.isHeld && (
        <Callout tone="danger" title="Credit is suspended on this account">
          {data.holdReason ?? 'No reason was recorded.'}
          {canManage && (
            <>
              {' '}
              <button
                type="button"
                className="underline hover:text-danger-ink"
                onClick={() =>
                  run(() => releaseAccountAction(data.customerId, 'Released from the account'))
                }
                disabled={pending}
              >
                Restore credit
              </button>
            </>
          )}
        </Callout>
      )}

      {data.pausedUntil && (
        <Callout tone="brand" title={`Chasing is paused until ${data.pausedUntil}`}>
          {data.pauseReason ?? 'No reason was recorded.'}
          {canManage && (
            <>
              {' '}
              <button
                type="button"
                className="underline hover:text-brand-ink"
                onClick={() => run(() => resumeChasingAction(data.customerId))}
                disabled={pending}
              >
                Resume chasing
              </button>
            </>
          )}
        </Callout>
      )}

      {openPromise && (
        <Callout tone="success" title={`Promised ${formatMoney(openPromise.promisedAmount)}`}>
          Due {openPromise.promisedDate}
          {openPromise.promisedBy ? `, via ${openPromise.promisedBy}` : ''}. Reminders are paused
          until then.
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Overdue"
          value={formatMoney(data.overdueAmount)}
          tone={data.overdueAmount > 0 ? 'warning' : 'default'}
          hint={data.oldestDays > 0 ? `oldest is ${data.oldestDays} days` : 'nothing past due'}
        />
        <StatTile
          label="Risk"
          value={RISK_LABELS[data.risk]}
          tone={
            data.risk === 'bad'
              ? 'danger'
              : data.risk === 'poor'
                ? 'warning'
                : data.risk === 'watch'
                  ? 'default'
                  : 'positive'
          }
          hint={data.riskReason}
        />
        {/* The number that changes how the call opens. */}
        <StatTile
          label="Promises kept"
          value={data.reliabilityRate === null ? '—' : `${data.reliabilityRate}%`}
          tone={
            data.reliabilityRate === null
              ? 'default'
              : data.reliabilityRate >= 80
                ? 'positive'
                : 'danger'
          }
          hint={
            data.reliabilityDecided === 0
              ? 'never promised before'
              : `${data.promisesKept} of ${data.reliabilityDecided} kept`
          }
        />
        <StatTile
          label="Chased to"
          value={data.dunningLevel === 0 ? 'Never' : `Level ${data.dunningLevel}`}
          hint={data.lastDunnedAt ? `last on ${data.lastDunnedAt}` : 'no reminders sent'}
        />
      </div>

      <Card>
        <CardHeader
          title="Credit position"
          action={
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" size="sm" onClick={() => setLogging(true)}>
                Log a call
              </Button>
              {!openPromise && (
                <Button size="sm" onClick={() => setPromising(true)}>
                  Record a promise
                </Button>
              )}
              {canManage && !data.pausedUntil && (
                <Button variant="ghost" size="sm" onClick={() => setPausing(true)}>
                  Pause chasing
                </Button>
              )}
              {canManage && !data.isHeld && (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() =>
                    run(() =>
                      holdAccountAction(data.customerId, 'Held from the account screen'),
                    )
                  }
                  disabled={pending}
                >
                  Hold account
                </Button>
              )}
            </div>
          }
        />
        <CardBody>
          <SummaryList>
            <SummaryRow label="Balance" value={formatMoney(data.balance)} />
            <SummaryRow
              label="Credit limit"
              value={data.creditLimit > 0 ? formatMoney(data.creditLimit) : 'No limit set'}
            />
            <SummaryRow
              label="Available"
              value={
                data.creditLimit > 0
                  ? formatMoney(data.creditLimit - data.balance)
                  : '—'
              }
            />
          </SummaryList>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="What is overdue"
          description="The documents behind the figure, oldest first."
        />
        {data.documents.length === 0 ? (
          <CardBody>
            <EmptyState title="Nothing outstanding" hint="This account is fully paid up." />
          </CardBody>
        ) : (
          <DataTable
            columns={docColumns}
            rows={data.documents}
            getRowKey={(d) => d.id}
            empty={{ title: 'Nothing outstanding', hint: '' }}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Contact history"
          description="Everything said to this customer, whether the system sent it or a person made the call."
        />
        {data.contacts.length === 0 ? (
          <CardBody>
            <EmptyState
              title="Nobody has contacted this account"
              hint="Logging calls here stops the same debt being chased twice by two people."
            />
          </CardBody>
        ) : (
          <CardBody>
            <ul className="divide-y divide-border">
              {data.contacts.map((c) => (
                <li key={c.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-ink">{c.summary}</span>
                    <Badge
                      tone={
                        c.outcome === 'disputed' || c.outcome === 'refused'
                          ? 'danger'
                          : c.outcome === 'promised' || c.outcome === 'paid'
                            ? 'success'
                            : 'default'
                      }
                    >
                      {OUTCOME_LABEL[c.outcome] ?? c.outcome}
                    </Badge>
                  </div>
                  {c.detail && <p className="mt-1 text-sm text-muted">{c.detail}</p>}
                  <p className="mt-1 text-xs text-muted">
                    {c.contactDate} · {c.kind} · {c.userName || 'system'}
                  </p>
                </li>
              ))}
            </ul>
          </CardBody>
        )}
      </Card>

      {data.promises.length > 0 && (
        <Card>
          <CardHeader title="Promises" description="What was committed, and whether it held." />
          <CardBody>
            <ul className="divide-y divide-border">
              {data.promises.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-ink-2">
                    {formatMoney(p.promisedAmount)} by {p.promisedDate}
                    {p.promisedBy ? ` · ${p.promisedBy}` : ''}
                  </span>
                  <Badge
                    tone={
                      p.state === 'broken'
                        ? 'danger'
                        : p.state === 'kept'
                          ? 'success'
                          : p.state === 'due-today'
                            ? 'warning'
                            : 'brand'
                    }
                  >
                    {p.state === 'due-today'
                      ? 'Due now'
                      : (PROMISE_LABELS[p.state as keyof typeof PROMISE_LABELS] ?? p.state)}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {/* ── Record a promise ── */}
      <Modal
        open={promising}
        onClose={() => setPromising(false)}
        title="Record a promise to pay"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPromising(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                run(() =>
                  createPromiseAction({
                    customerId: data.customerId,
                    promisedDate: promiseDate,
                    promisedAmount: Number(promiseAmount) || 0,
                    promisedBy: promiseBy,
                  }),
                )
              }
              disabled={pending}
            >
              Record it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Promised for" hint="Reminders are paused until this date.">
            <Input
              type="date"
              value={promiseDate}
              onChange={(e) => setPromiseDate(e.target.value)}
            />
          </Field>
          <Field label="Amount">
            <CurrencyInput
              value={promiseAmount}
              onChange={(e) => setPromiseAmount(e.target.value)}
            />
          </Field>
          <Field
            label="Who promised"
            hint="&ldquo;Accounts said Friday&rdquo; and &ldquo;the owner said Friday&rdquo; are not the same commitment."
          >
            <Input
              value={promiseBy}
              onChange={(e) => setPromiseBy(e.target.value)}
              placeholder="Accounts department"
            />
          </Field>
        </div>
      </Modal>

      {/* ── Log a contact ── */}
      <Modal
        open={logging}
        onClose={() => setLogging(false)}
        title="Log a contact"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLogging(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                run(() =>
                  logContactAction({
                    customerId: data.customerId,
                    kind: kind as 'email' | 'call' | 'note' | 'meeting' | 'letter',
                    outcome: outcome as
                      | 'promised'
                      | 'disputed'
                      | 'no_answer'
                      | 'paid'
                      | 'refused'
                      | 'none',
                    summary,
                    detail,
                  }),
                )
              }
              disabled={pending}
            >
              Log it
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="How">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="meeting">Meeting</option>
              <option value="letter">Letter</option>
              <option value="note">Note</option>
            </Select>
          </Field>
          <Field
            label="Outcome"
            hint="A disputed account stops being chased automatically until something later is logged."
          >
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="none">Just logging it</option>
              <option value="promised">Promised to pay</option>
              <option value="no_answer">No answer</option>
              <option value="disputed">Disputed</option>
              <option value="paid">Paid</option>
              <option value="refused">Refused to pay</option>
            </Select>
          </Field>
          <Field label="What happened">
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Spoke to Sarah, says the invoice is with their accountant"
            />
          </Field>
          <Field label="Detail">
            <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} />
          </Field>
        </div>
      </Modal>

      {/* ── Pause chasing ── */}
      <Modal
        open={pausing}
        onClose={() => setPausing(false)}
        title="Pause chasing"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPausing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                run(() => pauseChasingAction(data.customerId, pauseUntil, pauseReason))
              }
              disabled={pending}
            >
              Pause
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-muted">
          The debt still stands and still shows as overdue. Only the automated reminders stop.
        </p>
        <div className="space-y-4">
          <Field label="Until">
            <Input
              type="date"
              value={pauseUntil}
              onChange={(e) => setPauseUntil(e.target.value)}
            />
          </Field>
          <Field label="Why">
            <Input
              value={pauseReason}
              onChange={(e) => setPauseReason(e.target.value)}
              placeholder="Payment plan agreed with the owner"
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
