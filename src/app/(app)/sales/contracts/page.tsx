import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listContracts, contractSummary } from '@/lib/site/contracts'
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  EmptyState,
  Icons,
  PageBody,
  PageHeader,
  StatStrip,
  StatTile,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { ContractsTable } from './ContractsTable'

export const dynamic = 'force-dynamic'

/**
 * Contracts — agreements that bill a customer the same thing every month.
 *
 * The list answers three questions, in this order: what is this book worth a
 * month, what needs attention today, and what is on it. Everything else — the
 * lines, the billing history, the escalation trail — belongs on the contract's
 * own screen rather than in a column here.
 *
 * The table is a Client Component because Column arrays carry cell functions,
 * which cannot cross the server boundary.
 */
export default async function ContractsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('contracts.view')

  const [contracts, summary] = await Promise.all([
    listContracts(siteId, { includeInactive: true }),
    contractSummary(siteId),
  ])

  const due = contracts.filter((c) => c.due)

  return (
    <>
      <PageHeader
        title="Contracts"
        subtitle={
          summary.active === 0
            ? 'Recurring billing agreements'
            : `${summary.active} active · ${formatMoney(summary.monthlyValue)} a month`
        }
        action={
          <ButtonLink href="/sales/contracts/new">
            <Icons.Plus size={15} />
            New contract
          </ButtonLink>
        }
      />

      <PageBody>
        {contracts.length > 0 ? (
          <StatStrip>
            <StatTile label="Active contracts" value={String(summary.active)} />
            <StatTile label="Monthly value" value={formatMoney(summary.monthlyValue)} />
            <StatTile label="Annual value" value={formatMoney(summary.annualValue)} />
            {/* Colour marks the exception. A book with nothing due and nothing
                expiring shows three plain tiles and one quiet one — which is
                the correct reading of "there is nothing to do here". */}
            <StatTile
              label="Due to bill"
              value={String(summary.dueNow)}
              tone={summary.dueNow > 0 ? 'warning' : 'default'}
            />
            <StatTile
              label="Ending in 60 days"
              value={String(summary.endingSoon)}
              tone={summary.endingSoon > 0 ? 'warning' : 'default'}
            />
          </StatStrip>
        ) : null}

        {due.length > 0 ? (
          <Card>
            <CardBody>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-ink">
                    {due.length} contract{due.length === 1 ? '' : 's'} ready to bill
                  </p>
                  <p className="mt-0.5 text-sm text-muted">
                    {formatMoney(due.reduce((sum, c) => sum + c.totalIncl, 0))} in total.
                    Contracts set to send themselves will go out on the next run;
                    the rest are waiting for someone to release them.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {due.slice(0, 4).map((c) => (
                    <Link key={c.id} href={`/sales/contracts/${c.id}`}>
                      <Badge tone="warning">{c.name}</Badge>
                    </Link>
                  ))}
                  {due.length > 4 ? (
                    <Badge tone="default">+{due.length - 4} more</Badge>
                  ) : null}
                </div>
              </div>
            </CardBody>
          </Card>
        ) : null}

        {contracts.length === 0 ? (
          <EmptyState
            icon={<Icons.Repeat size={20} />}
            title="No contracts yet"
            hint="A contract bills a customer the same products every month, raises the invoice on the day you choose, and can raise its own price each year."
            action={
              <ButtonLink href="/sales/contracts/new">
                <Icons.Plus size={15} />
                New contract
              </ButtonLink>
            }
          />
        ) : (
          <ContractsTable
            contracts={contracts.map((c) => ({
              id: c.id,
              contractNumber: c.contractNumber,
              name: c.name,
              customerId: c.customerId,
              customerName: c.customerName,
              frequencyLabel: c.frequencyLabel,
              billingDay: c.billingDay,
              state: c.state,
              nextDue: c.nextDue,
              due: c.due,
              totalIncl: c.totalIncl,
              endsOn: c.endsOn,
              autoSend: c.autoSend,
              escalationPct: c.escalationPct,
            }))}
          />
        )}
      </PageBody>
    </>
  )
}
