'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Icons,
  Input,
  Modal,
  Select,
  SummaryList,
  SummaryRow,
  SummaryTotal,
  useToast,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { DepositSummary } from '@/lib/site/jobDeposits'
import { takeDepositAction } from '../actions'

/**
 * Money taken up front on a job.
 *
 * ── THE FIGURE THAT MATTERS IS WHAT IS LEFT ────────────────────────────────
 *
 * A deposit on its own is a number nobody can act on. The panel leads with the
 * quoted total, the deposits against it and the difference, because "R8 000
 * still to pay" is the sentence somebody repeats to a customer on the phone.
 *
 * Where the job carries no accepted quote there is nothing to measure against,
 * so the balance line is simply absent rather than showing a made-up figure.
 *
 * ── ASKING WHICH ACCOUNT IS NOT A NICETY ───────────────────────────────────
 *
 * A deposit is money RECEIVED, and received money has to land somewhere. The
 * account picker is required because the alternative — defaulting to the first
 * account — is this screen inventing an accounting fact on somebody's behalf.
 */
export default function JobDepositsPanel({
  jobId,
  jobClosed,
  summary,
  accounts,
  canTake,
}: {
  jobId: number
  jobClosed: boolean
  summary: DepositSummary
  /** Open bank accounts. Empty when the reader may not see the cashbook. */
  accounts: { id: number; name: string }[]
  canTake: boolean
}) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [taking, setTaking] = useState(false)
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState('')
  const [reference, setReference] = useState('')

  function save() {
    start(async () => {
      const result = await takeDepositAction(jobId, {
        amount: Number(amount),
        bankAccountId: Number(accountId),
        reference: reference.trim() || null,
      })
      if (result.ok) {
        toast.success('Deposit recorded.')
        setTaking(false)
        setAmount('')
        setReference('')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const nothing = summary.deposits.length === 0

  return (
    <>
      <Card>
        <CardHeader
          title="Deposits"
          description="Money taken before the work is billed. It sits on the customer account until an invoice is raised."
          action={
            canTake && !jobClosed && accounts.length > 0 ? (
              <Button variant="secondary" onClick={() => setTaking(true)} disabled={pending}>
                <Icons.Plus size={15} />
                Take a deposit
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          {nothing ? (
            <p className="text-sm text-muted">
              No deposit has been taken on this job.
              {summary.quoted !== null && ` The accepted quote is ${formatMoney(summary.quoted)}.`}
            </p>
          ) : (
            <SummaryList>
              {summary.deposits.map((d) => (
                <SummaryRow
                  key={d.transactionId}
                  label={`${d.docDate}${d.reference ? ` · ${d.reference}` : ''}`}
                  value={formatMoney(d.amount)}
                />
              ))}
              {/* Only when there is a quote to measure against. Without one, a
                  "balance" would be invented. */}
              {summary.quoted !== null && (
                <>
                  <SummaryRow label="Quoted" value={formatMoney(summary.quoted)} />
                  <SummaryTotal
                    label="Still to pay"
                    value={formatMoney(summary.stillToPay ?? 0)}
                  />
                </>
              )}
              {summary.quoted === null && (
                <SummaryTotal label="Taken so far" value={formatMoney(summary.taken)} />
              )}
            </SummaryList>
          )}

          {/* A deposit that has been spent against an invoice is no longer money
              in hand, and somebody reading "R2 000 deposit" needs to know which
              it is. */}
          {!nothing && summary.unallocated < summary.taken && (
            <p className="mt-3 text-xs text-muted">
              {formatMoney(summary.unallocated)} of this is still unallocated; the rest has been
              settled against invoices.
            </p>
          )}

          {canTake && !jobClosed && accounts.length === 0 && (
            <Callout tone="warning" title="No account to receive it into">
              A deposit is money received, so it has to go into a bank account. Add one on the
              cashbook first.
            </Callout>
          )}
        </CardBody>
      </Card>

      <Modal
        open={taking}
        onClose={() => setTaking(false)}
        title="Take a deposit"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTaking(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={pending || !amount.trim() || !accountId || Number(amount) <= 0}
            >
              {pending ? 'Recording…' : 'Record it'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            This records a receipt on the customer account and in the bank account. It is not
            allocated to an invoice — the debtors screen decides which invoice it settles.
          </p>
          <Field label="Amount">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
          </Field>
          <Field label="Into which account" hint="Where the money actually went.">
            <Select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reference" hint="An EFT number or receipt number, if there is one.">
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={60}
            />
          </Field>
        </div>
      </Modal>
    </>
  )
}
