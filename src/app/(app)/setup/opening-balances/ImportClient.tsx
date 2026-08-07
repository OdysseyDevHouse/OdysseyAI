'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  ConfirmModal,
  DataTable,
  Field,
  Icons,
  SegmentedControl,
  StatStrip,
  StatTile,
  Textarea,
  useToast,
  type Column,
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

type ProblemRow = { key: number; row: number; code: string; docNumber: string; reason: string }
type ReadyRow = {
  key: number
  accountId: number
  accountName: string
  code: string
  docNumber: string
  docDate: string
  amount: number
}
type FailedRow = { key: number; code: string; docNumber: string; reason: string }

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

  // "Why" cells stay neutral ink on purpose — the card's own title carries the
  // alarm, and a column that is entirely coloured stops marking anything.
  const problemColumns: Column<ProblemRow>[] = [
    { key: 'row', header: 'Row', numeric: true, cell: (p) => p.row },
    { key: 'code', header: 'Code', cell: (p) => p.code || '—' },
    { key: 'doc', header: 'Document', cell: (p) => p.docNumber || '—' },
    { key: 'why', header: 'Why', cell: (p) => p.reason },
  ]

  const readyColumns: Column<ReadyRow>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (r) => (
        <div>
          <div className="text-ink">{r.accountName}</div>
          <div className="text-xs text-muted">{r.code}</div>
        </div>
      ),
    },
    { key: 'doc', header: 'Document', cell: (r) => r.docNumber },
    { key: 'date', header: 'Date', cell: (r) => r.docDate },
    { key: 'amount', header: 'Amount', numeric: true, cell: (r) => formatMoney(r.amount) },
  ]

  const failedColumns: Column<FailedRow>[] = [
    { key: 'code', header: 'Code', cell: (f) => f.code },
    { key: 'doc', header: 'Document', cell: (f) => f.docNumber },
    { key: 'why', header: 'Why', cell: (f) => f.reason },
  ]

  return (
    <>
      <StatStrip columns={3}>
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
          label="Ready to post"
          value={plan ? String(plan.ready.length) : '—'}
          hint={plan ? formatMoney(plan.total) : 'Preview first'}
          tone={plan && plan.ready.length > 0 ? 'success' : 'default'}
          icon={<Icons.Check size={16} />}
        />
      </StatStrip>

      <Callout
        tone="warning"
        title="One row per outstanding invoice — not one per account."
      >
        Each row keeps its original date and document number, so the age analysis is right on day
        one and a customer paying &ldquo;the March invoice&rdquo; has a March invoice to pay. A
        single lump per account would age every debt as current and settle against nothing. VAT is
        not re-declared: these invoices were taxed under the old system.
      </Callout>

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
              {/* Demoted once a plan exists — from there "Import R…" below is
                  the screen's one primary, and re-previewing is the side path. */}
              <Button
                variant={plan ? 'secondary' : 'primary'}
                onClick={preview}
                disabled={pending || csv.trim().length === 0}
              >
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
            {/* Mono, small on purpose: this is raw CSV entry, and columns only
                line up in a fixed-width face. */}
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
            <Callout
              tone="danger"
              title={`${plan.alreadyImported.length} account${plan.alreadyImported.length === 1 ? '' : 's'} already carry an opening balance.`}
            >
              <p>
                Importing again will post the debt a second time. Remove the earlier rows first
                unless that is what you intend.
              </p>
              <p className="mt-1">
                {plan.alreadyImported
                  .slice(0, 6)
                  .map((a) => `${a.code} (${a.count})`)
                  .join(' · ')}
                {plan.alreadyImported.length > 6 && ` · +${plan.alreadyImported.length - 6} more`}
              </p>
            </Callout>
          )}

          {plan.problems.length > 0 && (
            <Card>
              <CardHeader
                title={`${plan.problems.length} row${plan.problems.length === 1 ? '' : 's'} will not import`}
                description="Fix these in the file and preview again. They are skipped, never guessed at."
              />
              <DataTable
                columns={problemColumns}
                rows={plan.problems.slice(0, 100).map((p, key) => ({ ...p, key }))}
                getRowKey={(p) => p.key}
              />
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
              <>
                <DataTable
                  columns={readyColumns}
                  rows={plan.ready.slice(0, 200).map((r, key) => ({ ...r, key }))}
                  getRowKey={(r) => r.key}
                />
                {plan.ready.length > 200 && (
                  // Outside the table's horizontal scroll container, so the
                  // note never scrolls out of view with the columns.
                  <p className="border-t border-border px-6 py-3 text-sm text-muted">
                    Showing the first 200 of {plan.ready.length}. All of them will import.
                  </p>
                )}
              </>
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
            <DataTable
              columns={failedColumns}
              rows={result.failed.map((f, key) => ({ ...f, key }))}
              getRowKey={(f) => f.key}
            />
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
