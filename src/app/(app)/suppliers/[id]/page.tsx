import { notFound } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getSupplier } from '@/lib/site/suppliers'
import { listSupplierCategories } from '@/lib/site/customerLookups'
import { listActivity } from '@/lib/site/activityLog'
import {
  listSupplierLedger,
  supplierAgingFor,
  openSupplierDebits,
  unappliedSupplierCredits,
} from '@/lib/site/supplierLedger'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  Card,
  Button,
  LinkTabs,
  StatTile,
  EmptyState,
  Badge,
  Icons,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import SupplierForm from '../SupplierForm'
import TransactionsTab from './TransactionsTab'
import { deleteSupplierAction } from '../actions'

export const dynamic = 'force-dynamic'

type Tab = 'details' | 'transactions' | 'activity'

export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; saved?: string; error?: string }>
}) {
  const siteId = await requireSiteId()
  const { id } = await params
  const { tab, saved, error } = await searchParams

  const supplierId = Number(id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) notFound()

  const active: Tab =
    tab === 'activity' ? 'activity' : tab === 'transactions' ? 'transactions' : 'details'

  const [supplier, categories, activity, ledger, aging, debits, credits] = await Promise.all([
    getSupplier(siteId, supplierId),
    listSupplierCategories(siteId),
    listActivity(siteId, 'supplier', supplierId),
    listSupplierLedger(siteId, supplierId),
    supplierAgingFor(siteId, supplierId),
    openSupplierDebits(siteId, supplierId),
    unappliedSupplierCredits(siteId, supplierId),
  ])

  if (!supplier) notFound()

  return (
    <>
      <PageHeader
        title={supplier.name}
        subtitle={supplier.code}
        backHref="/suppliers"
        backLabel="Suppliers"
      />

      {saved === '1' && (
        <div className="px-6 pt-4">
          <p className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-sm text-success">
            <Icons.StatusSuccess size={15} />
            Saved.
          </p>
        </div>
      )}
      {error && (
        <div className="px-6 pt-4">
          <p
            role="alert"
            className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <Icons.StatusError size={15} />
            {error}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Balance"
          value={formatMoney(supplier.balance)}
          hint={supplier.balance === 0 ? 'Nothing outstanding' : 'Owed to them'}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Terms"
          value={supplier.paymentTermsDays === 0 ? 'COD' : `${supplier.paymentTermsDays} days`}
          icon={<Icons.Clock size={16} />}
        />
        <StatTile
          label="Lead time"
          value={supplier.leadTimeDays > 0 ? `${supplier.leadTimeDays} days` : '—'}
          hint="Order to delivery"
          icon={<Icons.Truck size={16} />}
        />
        <StatTile
          label="Products"
          value={String(supplier.productCount)}
          hint={supplier.canOrder ? 'Accepting orders' : 'New orders blocked'}
          tone={supplier.canOrder ? 'default' : 'warning'}
          icon={<Icons.Boxes size={16} />}
        />
      </div>

      {aging.total !== 0 && (
        <div className="px-6 pt-4">
          <AgeingStrip aging={aging} />
        </div>
      )}

      <div className="px-6 pt-5">
        <LinkTabs
          items={[
            {
              value: 'details',
              label: 'Details',
              icon: <Icons.Truck size={15} />,
              href: `/suppliers/${supplierId}`,
            },
            {
              value: 'transactions',
              label: 'Transactions',
              icon: <Icons.Receipt size={15} />,
              count: ledger.length,
              href: `/suppliers/${supplierId}?tab=transactions`,
            },
            {
              value: 'activity',
              label: 'Activity',
              icon: <Icons.History size={15} />,
              count: activity.length,
              href: `/suppliers/${supplierId}?tab=activity`,
            },
          ]}
          value={active}
          aria-label="Supplier sections"
        />
      </div>

      {active === 'transactions' ? (
        <TransactionsTab
          supplierId={supplierId}
          lines={ledger}
          openDebits={debits.map((d) => ({
            id: d.id,
            docLabel: d.docLabel,
            docNumber: d.docNumber,
            docDate: d.docDate,
            outstanding: d.amountOutstanding,
          }))}
          unappliedCredits={credits.map((c) => ({
            id: c.id,
            docLabel: c.docLabel,
            docNumber: c.docNumber,
            docDate: c.docDate,
            outstanding: c.amountOutstanding,
          }))}
        />
      ) : active === 'details' ? (
        <SupplierForm
          supplier={supplier}
          categories={categories}
          rowActions={
            <form action={deleteSupplierAction}>
              <input type="hidden" name="id" value={supplier.id} />
              <Button type="submit" variant="danger-ghost">
                <Icons.Trash size={15} />
                Delete
              </Button>
            </form>
          }
        />
      ) : (
        <div className="px-6 pt-4 pb-10">
          <Card>
            {activity.length === 0 ? (
              <EmptyState
                title="Nothing recorded yet"
                hint="Edits, status changes and orders raised will appear here."
              />
            ) : (
              <ul className="divide-y divide-border">
                {activity.map((event) => (
                  <li key={event.id} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-0.5 text-faint">
                      <Icons.History size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={event.action === 'status' ? 'warning' : 'neutral'}>
                          {event.action}
                        </Badge>
                        <span className="text-sm text-ink">{event.detail ?? '—'}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted">
                        {event.userName || 'Unknown user'} ·{' '}
                        {event.createdAt.toLocaleString('en-ZA')}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  )
}
