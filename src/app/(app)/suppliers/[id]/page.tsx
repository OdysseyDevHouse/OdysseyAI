import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getSupplier } from '@/lib/site/suppliers'
import { listSupplierCategories } from '@/lib/site/customerLookups'
import { listActivity } from '@/lib/site/activityLog'
import { listContacts } from '@/lib/site/partyContacts'
import { listDocuments } from '@/lib/site/partyDocuments'
import { listComments } from '@/lib/site/partyComments'
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
  Callout,
  Button,
  ButtonLink,
  LinkTabs,
  StatTile,
  EmptyState,
  Badge,
  Icons,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import SupplierForm from '../SupplierForm'
import TransactionsTab from './TransactionsTab'
import ContactsPanel from '@/components/party/ContactsPanel'
import DocumentsPanel from '@/components/party/DocumentsPanel'
import CommentsPanel from '@/components/party/CommentsPanel'
import { deleteSupplierAction } from '../actions'

export const dynamic = 'force-dynamic'

type Tab = 'details' | 'contacts' | 'documents' | 'comments' | 'transactions' | 'activity'

const TABS: readonly Tab[] = [
  'details',
  'contacts',
  'documents',
  'comments',
  'transactions',
  'activity',
]

function toTab(value: string | undefined): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'details'
}

export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; saved?: string; error?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('suppliers.view')
  const { id } = await params
  const { tab, saved, error } = await searchParams

  const supplierId = Number(id)
  if (!Number.isFinite(supplierId) || supplierId <= 0) notFound()

  const active: Tab = toTab(tab)

  const [
    supplier,
    categories,
    activity,
    ledger,
    aging,
    debits,
    credits,
    contacts,
    documents,
    comments,
  ] = await Promise.all([
    getSupplier(siteId, supplierId),
    listSupplierCategories(siteId),
    listActivity(siteId, 'supplier', supplierId),
    listSupplierLedger(siteId, supplierId),
    supplierAgingFor(siteId, supplierId),
    openSupplierDebits(siteId, supplierId),
    unappliedSupplierCredits(siteId, supplierId),
    listContacts(siteId, 'supplier', supplierId),
    listDocuments(siteId, 'supplier', supplierId),
    listComments(siteId, 'supplier', supplierId),
  ])

  if (!supplier) notFound()

  return (
    <>
      <PageHeader
        title={supplier.name}
        subtitle={supplier.code}
        backHref="/suppliers"
        backLabel="Suppliers"
        action={
          // Nothing posted yet means nothing to reconcile — matches how the
          // customer page gates its Statement button.
          ledger.length > 0 ? (
            <ButtonLink href={`/suppliers/${supplier.id}/statement`} variant="secondary">
              <Icons.Receipt size={15} />
              Statement
            </ButtonLink>
          ) : undefined
        }
      />

      {saved === '1' && (
        <div className="px-6 pt-4">
          <Callout tone="success" title="Saved." />
        </div>
      )}
      {error && (
        <div className="px-6 pt-4">
          <Callout tone="danger" title={error} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        {/* The blocked-orders warning lives here, not on the product count —
            being on hold is an account condition, and the balance tile is the
            account tile. */}
        <StatTile
          label="Balance"
          value={formatMoney(supplier.balance)}
          hint={
            supplier.canOrder
              ? supplier.balance === 0
                ? 'Nothing outstanding'
                : 'Owed to them'
              : 'New orders blocked'
          }
          tone={supplier.canOrder ? 'default' : 'warning'}
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
          hint="Stocked from them"
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
              value: 'contacts',
              label: 'Contacts',
              icon: <Icons.Contact size={15} />,
              count: contacts.length,
              href: `/suppliers/${supplierId}?tab=contacts`,
            },
            {
              value: 'documents',
              label: 'Documents',
              icon: <Icons.Paperclip size={15} />,
              count: documents.length,
              href: `/suppliers/${supplierId}?tab=documents`,
            },
            {
              value: 'comments',
              label: 'Comments',
              icon: <Icons.MessageSquare size={15} />,
              count: comments.length,
              href: `/suppliers/${supplierId}?tab=comments`,
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
        // Contacts, documents, comments and activity all share the same
        // card-in-gutter shell — one wrapper, not four copies of it.
        <div className="px-6 pt-4 pb-10">
          <Card>
            {active === 'contacts' ? (
              <ContactsPanel party="supplier" partyId={supplierId} contacts={contacts} />
            ) : active === 'documents' ? (
              <DocumentsPanel party="supplier" partyId={supplierId} documents={documents} />
            ) : active === 'comments' ? (
              <CommentsPanel party="supplier" partyId={supplierId} comments={comments} />
            ) : activity.length === 0 ? (
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
                      <div className="flex flex-wrap items-baseline gap-2">
                        {/* A badge on every row is a badge on no row — only a
                            status change is an exception worth marking. */}
                        {event.action === 'status' ? (
                          <Badge tone="warning">{ACTIVITY_LABELS.status}</Badge>
                        ) : (
                          <span className="text-xs font-medium text-muted">
                            {ACTIVITY_LABELS[event.action] ?? sentenceCase(event.action)}
                          </span>
                        )}
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

/** What each logged action reads as — sentence case, human words. */
const ACTIVITY_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Edited',
  status: 'Status changed',
  bulk: 'Bulk update',
  delete: 'Deleted',
  contact: 'Contact',
  document: 'Document',
  comment: 'Comment',
  payment_run: 'Payment run',
}

/** Fallback for an action the map does not know: "some_action" → "Some action". */
function sentenceCase(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
