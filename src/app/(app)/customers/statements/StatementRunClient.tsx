'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Field,
  Icons,
  Select,
  Switch,
  useToast,
  type Column,
} from '@/components/ui'
import { DateRangeField } from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { startRunAction } from './actions'

/**
 * Choosing who gets a statement.
 *
 * Selection uses the DataTable's controlled API — the same one the customers
 * list uses — so the behaviour is identical: shift-click ranges, a live count,
 * and accounts that cannot be sent to greyed rather than hidden.
 *
 * Hiding them would answer "who is getting one" while quietly leaving out the
 * accounts someone most needs to notice.
 */

type Candidate = {
  id: number
  code: string
  name: string
  email: string | null
  balance: number
}

export default function StatementRunClient({
  candidates,
  mailReady,
}: {
  candidates: Candidate[]
  mailReady: boolean
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [owingOnly, setOwingOnly] = useState(true)
  const [format, setFormat] = useState<'open-item' | 'activity'>('open-item')
  const [period, setPeriod] = useState(defaultPeriod())
  const [pending, startTransition] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const rows = useMemo(
    () => (owingOnly ? candidates.filter((c) => c.balance !== 0) : candidates),
    [candidates, owingOnly],
  )

  const chosen = rows.filter((r) => selected.has(String(r.id)))
  const sendable = chosen.filter((c) => c.email && c.balance !== 0)
  const skipped = chosen.length - sendable.length

  function selectAllSendable() {
    setSelected(new Set(rows.filter((r) => r.email && r.balance !== 0).map((r) => String(r.id))))
  }

  function send() {
    startTransition(async () => {
      const result = await startRunAction({
        customerIds: chosen.map((c) => c.id),
        periodFrom: period.from,
        periodTo: period.to,
        format,
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      setSelected(new Set())
      router.push(`/customers/statements/${result.runId}`)
    })
  }

  return (
    <Card>
      <CardHeader
        title="Send statements"
        description="Queued and sent in the background — you can leave this screen."
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={selectAllSendable} disabled={pending}>
              <Icons.Check size={15} />
              Select all sendable
            </Button>
            <Button
              variant="primary"
              disabled={sendable.length === 0 || pending || !mailReady}
              onClick={send}
            >
              <Icons.Send size={15} />
              {pending
                ? 'Queueing…'
                : `Send ${sendable.length || ''} statement${sendable.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        }
      />

      <CardBody className="flex flex-wrap items-end gap-4 border-b border-border">
        <DateRangeField value={period} onChange={setPeriod} label="Period" />
        <Field label="Format" hint="Open items is what a customer needs in order to pay.">
          <Select
            value={format}
            onChange={(e) => setFormat(e.target.value as typeof format)}
            className="w-48"
          >
            <option value="open-item">Open items</option>
            <option value="activity">Full activity</option>
          </Select>
        </Field>
        <div className="pb-2">
          <Switch
            checked={owingOnly}
            onChange={setOwingOnly}
            label="Only accounts with a balance"
            hint="A statement saying nothing is owed is inbox noise."
          />
        </div>
      </CardBody>

      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-brand-soft px-4 py-2.5 text-sm">
          <Badge tone="brand">{chosen.length}</Badge>
          <span className="text-ink-2">selected</span>
          {skipped > 0 && (
            /* Named up front rather than discovered afterwards in the run. */
            <span className="text-muted">
              · {skipped} will be skipped (no email, or nothing owed)
            </span>
          )}
          <Button
            variant="bare"
            size="sm"
            className="ml-auto"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      <DataTable
        columns={COLUMNS}
        rows={rows}
        getRowKey={(row) => row.id}
        selectedKeys={selected}
        onSelectionChange={setSelected}
        // Greyed rather than hidden: an account nobody can send to is exactly
        // the one someone needs to notice.
        isRowSelectable={(row) => Boolean(row.email) && row.balance !== 0}
        empty={{
          title: owingOnly ? 'No account has a balance' : 'No accounts',
          hint: owingOnly ? 'Turn off the filter to see everyone.' : undefined,
        }}
      />
    </Card>
  )
}

const COLUMNS: readonly Column<Candidate>[] = [
  { key: 'code', header: 'Code', sortable: true, cell: (row) => row.code },
  { key: 'name', header: 'Account', sortable: true, cell: (row) => row.name },
  {
    key: 'email',
    header: 'Email',
    sortable: true,
    sortValue: (row) => row.email ?? '',
    cell: (row) =>
      row.email ? (
        <span className="text-ink-2">{row.email}</span>
      ) : (
        <Badge tone="warning">No email</Badge>
      ),
  },
  {
    key: 'balance',
    header: 'Balance',
    numeric: true,
    sortable: true,
    sortValue: (row) => row.balance,
    cell: (row) =>
      row.balance === 0 ? (
        <span className="text-faint">{formatMoney(0)}</span>
      ) : (
        <span className="text-ink">{formatMoney(row.balance)}</span>
      ),
  },
]

/** Last month to date — the period a month-end statement run covers. */
function defaultPeriod() {
  const now = new Date()
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(now) }
}
