import { requireModuleCapability } from '@/lib/auth'
import { listBatches } from '@/lib/site/journals'
import { listAccounts } from '@/lib/site/chartOfAccounts'
import { today } from '@/lib/site/ledger'
import { addDays } from '@/lib/site/interestRules'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Field,
  Input,
  TableToolbar,
  LinkSegmentedControl,
  Icons,
} from '@/components/ui'
import { JournalClient } from './JournalClient'
import { JournalsTable, type BatchRow } from './JournalsTable'

export const dynamic = 'force-dynamic'

/**
 * The slices an auditor actually asks for — manual first among them.
 *
 * The glyphs name each entry's ORIGIN rather than a status: a journal somebody
 * typed carries different weight from one a sale mirrored, and that difference
 * is the whole reason this filter exists.
 */
const SOURCES = [
  { value: 'all', label: 'All', source: null, icon: <Icons.LayoutGrid size={15} /> },
  { value: 'manual', label: 'Manual', source: 'manual', icon: <Icons.Pencil size={15} /> },
  { value: 'sale', label: 'Sales', source: 'sale', icon: <Icons.Receipt size={15} /> },
  { value: 'grv', label: 'Purchases', source: 'grv', icon: <Icons.Truck size={15} /> },
  { value: 'recurring', label: 'Recurring', source: 'recurring', icon: <Icons.Repeat size={15} /> },
] as const

/**
 * Journals — every entry in the ledger, and where a manual one is captured.
 *
 * Most journals here were raised automatically by a sale, a GRV or an expense.
 * The source is shown on every row because a journal somebody wrote by hand
 * carries different weight from one the system mirrored, and an auditor looks
 * at the manual ones first.
 */
export default async function JournalsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; source?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'reports.financial')
  const params = await searchParams

  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : today()
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : addDays(to, -60)

  const [batches, accounts] = await Promise.all([
    listBatches(siteId, { from, to, source: params.source, limit: 300 }),
    listAccounts(siteId, { postableOnly: true }),
  ])

  const href = hrefBuilder('/accounting/journals', params)
  const activeSource =
    SOURCES.find((s) => s.source === (params.source ?? null))?.value ?? 'all'

  // Plain serializable rows — DataTable's columns are functions, so they live
  // in the client component and only data crosses the boundary.
  const rows: BatchRow[] = batches.map((b) => ({
    id: b.id,
    journalDate: b.journalDate,
    journalNumber: b.journalNumber,
    description: b.description,
    isReversal: b.reversesId !== null,
    source: b.source,
    status: b.status,
    totalDebit: b.totalDebit,
  }))

  return (
    <>
      <PageHeader
        title="Journals"
        icon={<Icons.ClipboardList size={18} />}
        subtitle={`${from} to ${to}`}
        action={
          <div className="flex items-center gap-2">
            <ButtonLink variant="secondary" href="/accounting/journals/recurring">
              <Icons.Repeat size={15} />
              Recurring
            </ButtonLink>
            <JournalClient
              accounts={accounts.map((a) => ({
                id: a.id,
                accountCode: a.accountCode,
                name: a.name,
                accountTypeLabel: a.accountTypeLabel,
              }))}
            />
          </div>
        }
      />

      <PageBody>
        <TableToolbar
          actions={
            /* A plain GET form: the range lives in the URL, so it survives a
               reload and can be linked to — no client state needed. */
            <form action="/accounting/journals" className="flex items-end gap-2">
              {params.source && <input type="hidden" name="source" value={params.source} />}
              <div className="w-40">
                <Field label="From">
                  <Input type="date" name="from" defaultValue={from} />
                </Field>
              </div>
              <div className="w-40">
                <Field label="To">
                  <Input type="date" name="to" defaultValue={to} />
                </Field>
              </div>
              <Button type="submit" variant="secondary">
                Apply
              </Button>
            </form>
          }
        >
          <LinkSegmentedControl
            aria-label="Journal source"
            value={activeSource}
            options={SOURCES.map((s) => ({
              value: s.value,
              label: s.label,
              icon: s.icon,
              href: href({ source: s.source }),
            }))}
          />
        </TableToolbar>

        <Card>
          <CardHeader
            title="Ledger entries"
            description="Most are raised automatically by the documents that caused them."
          />
          <JournalsTable rows={rows} />
        </Card>
      </PageBody>
    </>
  )
}
