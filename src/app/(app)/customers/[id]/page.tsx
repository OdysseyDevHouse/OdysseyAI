import { notFound } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getCustomer } from '@/lib/site/customers'
import { listCustomerGroups, listSalesReps, listCustomerCategories } from '@/lib/site/customerLookups'
import { listActivity } from '@/lib/site/activityLog'
import { listContacts } from '@/lib/site/partyContacts'
import { listDocuments } from '@/lib/site/partyDocuments'
import { listComments } from '@/lib/site/partyComments'
import { listLedger, agingFor, openDebits, unappliedCredits } from '@/lib/site/customerLedger'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  Card,
  Button,
  ButtonLink,
  LinkTabs,
  StatTile,
  EmptyState,
  Badge,
  Icons,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import CustomerForm from '../CustomerForm'
import { autoAllocates } from '@/lib/accountTypes'
import TransactionsTab from './TransactionsTab'
import ContactsPanel from '@/components/party/ContactsPanel'
import DocumentsPanel from '@/components/party/DocumentsPanel'
import CommentsPanel from '@/components/party/CommentsPanel'
import { deleteCustomerAction } from '../actions'

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

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; saved?: string; error?: string }>
}) {
  const siteId = await requireSiteId()
  const { id } = await params
  const { tab, saved, error } = await searchParams

  const customerId = Number(id)
  if (!Number.isFinite(customerId) || customerId <= 0) notFound()

  const active: Tab = toTab(tab)

  const [
    customer,
    groups,
    reps,
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
    getCustomer(siteId, customerId),
    listCustomerGroups(siteId),
    listSalesReps(siteId),
    listCustomerCategories(siteId),
    listActivity(siteId, 'customer', customerId),
    listLedger(siteId, customerId),
    agingFor(siteId, customerId),
    openDebits(siteId, customerId),
    unappliedCredits(siteId, customerId),
    listContacts(siteId, 'customer', customerId),
    listDocuments(siteId, 'customer', customerId),
    listComments(siteId, 'customer', customerId),
  ])

  if (!customer) notFound()

  return (
    <>
      <PageHeader
        title={customer.name}
        subtitle={customer.code}
        backHref="/customers"
        backLabel="Customers"
        action={
          ledger.length > 0 ? (
            <ButtonLink href={`/customers/${customerId}/statement`} variant="secondary">
              <Icons.Mail size={15} />
              Statement
            </ButtonLink>
          ) : undefined
        }
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
          value={formatMoney(customer.balance)}
          tone={customer.overLimit ? 'danger' : 'default'}
          hint={customer.balance === 0 ? 'Nothing outstanding' : 'Owed to us'}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Credit limit"
          value={customer.creditLimit > 0 ? formatMoney(customer.creditLimit) : 'None'}
          hint={customer.creditLimit === 0 ? 'No credit granted' : undefined}
          icon={<Icons.CreditCard size={16} />}
        />
        <StatTile
          label="Available credit"
          value={formatMoney(customer.availableCredit)}
          tone={customer.availableCredit === 0 && customer.creditLimit > 0 ? 'warning' : 'default'}
          icon={<Icons.Wallet size={16} />}
        />
        <StatTile
          label="Terms"
          value={customer.paymentTermsDays === 0 ? 'COD' : `${customer.paymentTermsDays} days`}
          hint={customer.canBuyOnAccount ? 'May buy on account' : 'Account sales blocked'}
          tone={customer.canBuyOnAccount ? 'default' : 'warning'}
          icon={<Icons.Clock size={16} />}
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
              icon: <Icons.Info size={15} />,
              href: `/customers/${customerId}`,
            },
            {
              value: 'contacts',
              label: 'Contacts',
              icon: <Icons.Contact size={15} />,
              count: contacts.length,
              href: `/customers/${customerId}?tab=contacts`,
            },
            {
              value: 'documents',
              label: 'Documents',
              icon: <Icons.Paperclip size={15} />,
              count: documents.length,
              href: `/customers/${customerId}?tab=documents`,
            },
            {
              value: 'comments',
              label: 'Comments',
              icon: <Icons.MessageSquare size={15} />,
              count: comments.length,
              href: `/customers/${customerId}?tab=comments`,
            },
            {
              value: 'transactions',
              label: 'Transactions',
              icon: <Icons.Receipt size={15} />,
              count: ledger.length,
              href: `/customers/${customerId}?tab=transactions`,
            },
            {
              value: 'activity',
              label: 'Activity',
              icon: <Icons.History size={15} />,
              count: activity.length,
              href: `/customers/${customerId}?tab=activity`,
            },
          ]}
          value={active}
          aria-label="Customer sections"
        />
      </div>

      {active === 'contacts' ? (
        <div className="px-6 pt-4 pb-10">
          <Card>
            <ContactsPanel party="customer" partyId={customerId} contacts={contacts} />
          </Card>
        </div>
      ) : active === 'documents' ? (
        <div className="px-6 pt-4 pb-10">
          <Card>
            <DocumentsPanel party="customer" partyId={customerId} documents={documents} />
          </Card>
        </div>
      ) : active === 'comments' ? (
        <div className="px-6 pt-4 pb-10">
          <Card>
            <CommentsPanel party="customer" partyId={customerId} comments={comments} />
          </Card>
        </div>
      ) : active === 'transactions' ? (
        <TransactionsTab
          customerId={customerId}
          autoAllocatesByDefault={autoAllocates(customer.accountType)}
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
        <CustomerForm
          customer={customer}
          groups={groups}
          reps={reps}
          categories={categories}
          rowActions={
            /* Its own form, rendered outside the edit form — HTML forms cannot
               nest, and Save reaches its own via form={FORM_ID}. */
            <form action={deleteCustomerAction}>
              <input type="hidden" name="id" value={customer.id} />
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
                hint="Edits, status changes and statements sent will appear here."
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
