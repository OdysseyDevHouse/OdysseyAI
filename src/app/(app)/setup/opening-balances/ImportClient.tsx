'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  Field,
  Icons,
  SegmentedControl,
  StatTile,
  Textarea,
  useToast,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import type { OpeningPlan, OpeningSide, ImportResult } from '@/lib/site/openingBalances'
import { previewAction, importAction } from './actions'

/**
 * Importing a book of debt.
 *
 * Preview first, always. This is the least reversible thing a new store does,
 * and the preview exists so nobody discovers a mis-mapped column after two
 * hundred accounts have been posted.
 *
 * Problems are shown as prominently as successes. An import screen that leads
 * with "180 ready" and buries "20 skipped" is how twenty customers end up
 * owing nothing and nobody notices until they stop paying.
 */

const SAMPLE = `code,invoice,date,amount,reference
ACC001,INV-4471,2026-03-14,1150.00,March delivery
ACC001,INV-4488,2026-05-02,2300.00,
ACC002,INV-4490,2026-06-11,575.00,`

export default function ImportClient({
  customerCount,
  supplierCount,
  customerOwing,
  supplierOwing,
}: {
  customerCount: number
  supplierCount: number
  customerOwing: number
  supplierOwing: number
}) {
  const [side, setSide] = useState<OpeningSide>('customer')
  const [csv, setCsv] = useState('')
  const [plan, setPlan] = useState<OpeningPlan | null>(null)
  const [skipped, setSkipped] = useState(0)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()

  const toast = useToast()
  const router = useRouter()

  function preview() {
    startTransition(async () => {
      const outcome = await previewAction(side, csv)
      if (!outcome.ok) {
        toast.error(outcome.error)
        return
      }
      setPlan(outcome.plan)
      setSkipped(outcome.skipped)
      setResult(null)
    })
  }

  function commit() {
    if (!plan) return
    startTransition(async () => {
      const outcome = await importAction(plan)
      if (!outcome.ok) {
        toast.error(outcome.error)
        setConfirming(false)
        return
      }
      setResult(outcome.result)
      setPlan(null)
      setConfirming(false)
      toast.success(
        outcome.result.failed.length === 0
          ? `${outcome.result.posted} balances imported.`
          : `${outcome.result.posted} imported, ${outcome.result.failed.length} failed.`,
      )
      router.refresh()
    })
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Customers"
          value={String(customerCount)}
          hint={`${formatMoney(customerOwing)} on the books`}
          icon={<Icons.Users size={16} />}
        />
        <StatTile
          label="Suppliers"
          value={String(supplierCount)}
          hint={`${formatMoney(supplierOwing)} owed`}
          icon={<Icons.Truck size={16} />}
        />
        <StatTile
          label="Importing"
          value={side === 'customer' ? 'Debtors' : 'Creditors'}
          hint="Switch below"
          icon={<Icons.FileText size={16} />}
        />
        <StatTile
          label="Ready to post"
          value={plan ? String(plan.ready.length) : '—'}
          hint={plan ? formatMoney(plan.total) : 'Preview first'}
          tone={plan && plan.ready.length > 0 ? 'positive' : 'default'}
          icon={<Icons.Check size={16} />}
        />
      </div>

      <Card>
        <div className="flex items-start gap-3 px-6 py-4">
          <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium text-ink">One row per outstanding invoice — not one per account.</p>
            <p className="text-muted">
              Each row keeps its original date and document number, so the age analysis is right on
              day one and a customer paying &ldquo;the March invoice&rdquo; has a March invoice to
              pay. A single lump per account would age every debt as current and settle against
              nothing. VAT is not re-declared: these invoices were taxed under the old system.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="The file"
          description="Paste CSV, or export it from the old system. Columns are matched by name."
          action={
            <div className="flex items-center gap-2">
              <SegmentedControl
                value={side}
                onChange={(next) => {
                  setSide(next as OpeningSide)
                  setPlan(null)
                  setResult(null)
                }}
                options={[
                  { value: 'customer', label: 'Customers' },
                  { value: 'supplier', label: 'Suppliers' },
                ]}
              />
              <Button variant="ghost" size="sm" onClick={() => setCsv(SAMPLE)} disabled={pending}>
                Use a sample
              </Button>
              <Button variant="primary" onClick={preview} disabled={pending || csv.trim().length === 0}>
                <Icons.Search size={15} />
                {pending ? 'Checking…' : 'Preview'}
              </Button>
            </div>
          }
        />
        <CardBody>
          <Field
            label="CSV"
            hint="code, invoice number, date, amount, reference — a header row is optional. Dates are read day-first (05/08/2026 is 5 August)."
          >
            <Textarea
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value)
                setPlan(null)
              }}
              rows={8}
              placeholder={SAMPLE}
              className="font-mono text-xs"
            />
          </Field>
        </CardBody>
      </Card>

      {plan && (
        <>
          {plan.alreadyImported.length > 0 && (
            <Card>
              <div className="flex items-start gap-3 px-6 py-4">
                <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-danger" />
                <div className="text-sm">
                  <p className="font-medium text-ink">
                    {plan.alreadyImported.length} account
                    {plan.alreadyImported.length === 1 ? '' : 's'} already carry an opening balance.
                  </p>
                  <p className="text-muted">
                    Importing again will post the debt a second time. Remove the earlier rows first
                    unless that is what you intend.
                  </p>
                  <p className="mt-1 text-muted">
                    {plan.alreadyImported
                      .slice(0, 6)
                      .map((a) => `${a.code} (${a.count})`)
                      .join(' · ')}
                    {plan.alreadyImported.length > 6 && ` · +${plan.alreadyImported.length - 6} more`}
                  </p>
                </div>
              </div>
            </Card>
          )}

          {plan.problems.length > 0 && (
            <Card>
              <CardHeader
                title={`${plan.problems.length} row${plan.problems.length === 1 ? '' : 's'} will not import`}
                description="Fix these in the file and preview again. They are skipped, never guessed at."
              />
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Row</th>
                      <th className={TABLE_TH}>Code</th>
                      <th className={TABLE_TH}>Document</th>
                      <th className={TABLE_TH}>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.problems.slice(0, 100).map((problem) => (
                      <tr key={`${problem.row}-${problem.docNumber}`} className={TABLE_ROW}>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{problem.row}</td>
                        <td className={TABLE_TD}>{problem.code || '—'}</td>
                        <td className={TABLE_TD}>{problem.docNumber || '—'}</td>
                        <td className={`${TABLE_TD} text-warning`}>{problem.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title={`${plan.ready.length} ready to import`}
              description={
                skipped > 0
                  ? `${formatMoney(plan.total)} across ${plan.accountCount} account${plan.accountCount === 1 ? '' : 's'} · ${skipped} blank line${skipped === 1 ? '' : 's'} ignored`
                  : `${formatMoney(plan.total)} across ${plan.accountCount} account${plan.accountCount === 1 ? '' : 's'}`
              }
              action={
                <Button
                  variant="primary"
                  onClick={() => setConfirming(true)}
                  disabled={pending || plan.ready.length === 0}
                >
                  <Icons.Check size={15} />
                  Import {formatMoney(plan.total)}
                </Button>
              }
            />
            {plan.ready.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted">Nothing here will post. Fix the rows above.</p>
              </CardBody>
            ) : (
              <div className="overflow-x-auto">
                <table className={TABLE}>
                  <thead>
                    <tr className={TABLE_HEAD_ROW}>
                      <th className={TABLE_TH}>Account</th>
                      <th className={TABLE_TH}>Document</th>
                      <th className={TABLE_TH}>Date</th>
                      <th className={`${TABLE_TH} text-right`}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.ready.slice(0, 200).map((row, index) => (
                      <tr key={`${row.accountId}-${row.docNumber}-${index}`} className={TABLE_ROW}>
                        <td className={TABLE_TD}>
                          <div className="text-ink">{row.accountName}</div>
                          <div className="text-xs text-muted">{row.code}</div>
                        </td>
                        <td className={TABLE_TD}>{row.docNumber}</td>
                        <td className={TABLE_TD}>{row.docDate}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatMoney(row.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.ready.length > 200 && (
                  <CardBody>
                    <p className="text-sm text-muted">
                      Showing the first 200 of {plan.ready.length}. All of them will import.
                    </p>
                  </CardBody>
                )}
              </div>
            )}
          </Card>
        </>
      )}

      {result && (
        <Card>
          <CardHeader
            title={`${result.posted} imported`}
            description={`${formatMoney(result.total)} carried in.`}
            action={
              result.failed.length === 0 ? (
                <Badge tone="success">Clean</Badge>
              ) : (
                <Badge tone="danger">{result.failed.length} failed</Badge>
              )
            }
          />
          {result.failed.length > 0 && (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Code</th>
                    <th className={TABLE_TH}>Document</th>
                    <th className={TABLE_TH}>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failed.map((problem) => (
                    <tr key={`${problem.code}-${problem.docNumber}`} className={TABLE_ROW}>
                      <td className={TABLE_TD}>{problem.code}</td>
                      <td className={TABLE_TD}>{problem.docNumber}</td>
                      <td className={`${TABLE_TD} text-danger`}>{problem.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={commit}
        title={`Import ${plan ? formatMoney(plan.total) : ''}?`}
        confirmLabel="Import the balances"
        tone="primary"
        busy={pending}
        message={`${plan?.ready.length ?? 0} transactions are posted to ${plan?.accountCount ?? 0} account${plan?.accountCount === 1 ? '' : 's'}, dated as they were originally issued. They will appear on statements and age analyses immediately. There is no undo — reversing means removing the transactions by hand.`}
      />
    </>
  )
}
