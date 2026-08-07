import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getCustomer } from '@/lib/site/customers'
import { listCustomerGroups, listSalesReps, listCustomerCategories } from '@/lib/site/customerLookups'
import { listActivity } from '@/lib/site/activityLog'
import { getCustomerLogin } from '@/lib/site/customerAuth'
import OnlineAccess from '../OnlineAccess'
import { listContacts } from '@/lib/site/partyContacts'
import { listDocuments } from '@/lib/site/partyDocuments'
import { listComments } from '@/lib/site/partyComments'
import { listLedger, agingFor, openDebits, unappliedCredits } from '@/lib/site/customerLedger'
import { accountCredit } from '@/lib/site/creditControl'
import { can } from '@/lib/site/permissions'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  Callout,
  Button,
  ButtonLink,
  LinkTabs,
  StatTile,
  StatStrip,
  Icons,
} from '@/components/ui'
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import CustomerForm from '../CustomerForm'
import { autoAllocates } from '@/lib/accountTypes'
import TransactionsTab from './TransactionsTab'
import ActivityTable from './ActivityTable'
import { CreditTab } from './CreditTab'
import { LoyaltyTab } from './LoyaltyTab'
import { getLoyaltySettings, getMember, listLedger as listLoyaltyLedger } from '@/lib/site/loyalty'
import { listVouchers, getCardProgress } from '@/lib/site/loyaltyCards'
import { listWallet } from '@/lib/site/loyaltyWallet'
import ContactsPanel from '@/components/party/ContactsPanel'
import DocumentsPanel from '@/components/party/DocumentsPanel'
import CommentsPanel from '@/components/party/CommentsPanel'
import { deleteCustomerAction } from '../actions'

export const dynamic = 'force-dynamic'

type Tab =
  | 'details'
  | 'contacts'
  | 'documents'
  | 'comments'
  | 'transactions'
  | 'credit'
  | 'loyalty'
  | 'online'
  | 'activity'

const TABS: readonly Tab[] = [
  'details',
  'contacts',
  'documents',
  'comments',
  'transactions',
  'credit',
  'loyalty',
  'online',
  'activity',
]

function toTab(value: string | undefined): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'details'
}

function when(date: Date | null): string {
  if (!date) return ''
  return new Date(date).toLocaleString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Everything the loyalty tab shows, shaped for the client component. */
async function loadLoyalty(siteId: number, customerId: number) {
  const settings = await getLoyaltySettings(siteId)

  const [member, ledger, vouchers, cards, wallet] = await Promise.all([
    getMember(siteId, customerId, settings),
    listLoyaltyLedger(siteId, customerId),
    listVouchers(siteId, { customerId }),
    getCardProgress(siteId, customerId),
    listWallet(siteId, customerId),
  ])
  if (!member) return null

  return {
    enabled: settings.enabled,
    member,
    ledger: ledger.map((e) => ({
      id: e.id,
      when: when(e.createdAt),
      entryType: e.entryType,
      points: e.points,
      documentNumber: e.documentNumber,
      note: e.note,
      userName: e.userName,
    })),
    vouchers: vouchers.map((v) => ({
      id: v.id,
      code: v.code,
      description: v.description,
      rewardLabel:
        v.rewardType === 'free_item'
          ? (v.rewardProductName ?? 'A free product')
          : formatMoney(v.rewardValue),
      status: v.status,
      expiresOn: v.expiresOn,
      redeemedDocNumber: v.redeemedDocNumber,
    })),
    cards: cards.map((c) => ({
      cardId: c.cardId,
      name: c.name,
      stamps: c.stamps,
      requiredStamps: c.requiredStamps,
      rewardLabel: c.rewardLabel,
    })),
    wallet: wallet.map((w) => ({
      id: w.id,
      when: when(w.createdAt),
      entryType: w.entryType,
      amount: w.amount,
      tenderName: w.tenderName,
      documentNumber: w.documentNumber,
      note: w.note,
    })),
  }
}

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; saved?: string; error?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('customers.view')
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
    onlineLogin,
    ledger,
    aging,
    debits,
    credits,
    contacts,
    documents,
    comments,
    credit,
  ] = await Promise.all([
    getCustomer(siteId, customerId),
    listCustomerGroups(siteId),
    listSalesReps(siteId),
    listCustomerCategories(siteId),
    listActivity(siteId, 'customer', customerId),
    getCustomerLogin(siteId, customerId),
    listLedger(siteId, customerId),
    agingFor(siteId, customerId),
    openDebits(siteId, customerId),
    unappliedCredits(siteId, customerId),
    listContacts(siteId, 'customer', customerId),
    listDocuments(siteId, 'customer', customerId),
    listComments(siteId, 'customer', customerId),
    accountCredit(siteId, customerId),
  ])

  // Loyalty is loaded separately and defensively: a site that has never run the
  // migration has no loyalty tables, and a customer screen must still open.
  const loyalty = can(capabilities, 'loyalty.view')
    ? await loadLoyalty(siteId, customerId).catch(() => null)
    : null

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

      {/* One PageBody carries the gutters; the transactions tab renders after
          it because the shared LedgerTab brings its own. */}
      <PageBody className={active === 'transactions' ? 'pb-0' : ''}>
        {saved === '1' && <Callout tone="success" title="Saved." />}
        {error && <Callout tone="danger">{error}</Callout>}

        <StatStrip columns={4}>
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
            hint={customer.creditLimit === 0 ? 'No credit granted' : 'Maximum on account'}
            icon={<Icons.CreditCard size={16} />}
          />
          <StatTile
            label="Available credit"
            value={formatMoney(customer.availableCredit)}
            tone={customer.availableCredit === 0 && customer.creditLimit > 0 ? 'warning' : 'default'}
            hint={customer.creditLimit === 0 ? 'No limit set' : 'Left before the limit'}
            icon={<Icons.Wallet size={16} />}
          />
          <StatTile
            label="Terms"
            value={customer.paymentTermsDays === 0 ? 'COD' : `${customer.paymentTermsDays} days`}
            hint={customer.canBuyOnAccount ? 'May buy on account' : 'Account sales blocked'}
            tone={customer.canBuyOnAccount ? 'default' : 'warning'}
            icon={<Icons.Clock size={16} />}
          />
        </StatStrip>

        {aging.total !== 0 && (
          <AgeingStrip
            aging={aging}
            hrefFor={() => `/customers/${customerId}?tab=transactions`}
          />
        )}

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
              value: 'credit',
              label: 'Credit',
              icon: <Icons.Bell size={15} />,
              /* The count is contacts, not promises: the history is what a
                 collector opens this tab for. */
              count: credit?.contacts.length ?? 0,
              href: `/customers/${customerId}?tab=credit`,
            },
            {
              value: 'loyalty',
              label: 'Loyalty',
              icon: <Icons.Gem size={15} />,
              count: loyalty ? Math.floor(loyalty.member.points) : 0,
              href: `/customers/${customerId}?tab=loyalty`,
            },
            {
              value: 'online',
              label: 'Online access',
              icon: <Icons.Globe size={15} />,
              href: `/customers/${customerId}?tab=online`,
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

        {active === 'contacts' ? (
          <Card>
            <ContactsPanel party="customer" partyId={customerId} contacts={contacts} />
          </Card>
        ) : active === 'documents' ? (
          <Card>
            <DocumentsPanel party="customer" partyId={customerId} documents={documents} />
          </Card>
        ) : active === 'comments' ? (
          <Card>
            <CommentsPanel party="customer" partyId={customerId} comments={comments} />
          </Card>
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
        ) : active === 'credit' && credit ? (
          <CreditTab
            canManage={can(capabilities, 'customers.credit')}
            data={{
              customerId,
              balance: credit.position.balance,
              creditLimit: credit.position.creditLimit,
              overdueAmount: credit.position.overdueAmount,
              oldestDays: credit.position.oldestDays,
              dunningLevel: credit.position.dunningLevel,
              lastDunnedAt: credit.position.lastDunnedAt,
              pausedUntil: credit.position.pausedUntil,
              pauseReason: credit.position.pauseReason,
              isHeld: credit.position.heldAt !== null,
              holdReason: credit.position.holdReason,
              risk: credit.position.risk,
              riskReason: credit.position.riskReason,
              promisesKept: credit.position.promisesKept,
              promisesBroken: credit.position.promisesBroken,
              reliabilityRate: credit.reliability.rate,
              reliabilityDecided: credit.reliability.decided,
              promises: credit.promises.map((p) => ({
                id: p.id,
                promisedDate: p.promisedDate,
                promisedAmount: p.promisedAmount,
                receivedAmount: p.receivedAmount,
                state: p.state,
                promisedBy: p.promisedBy,
              })),
              contacts: credit.contacts.map((c) => ({
                id: c.id,
                contactDate: c.contactDate,
                kind: c.kind,
                outcome: c.outcome,
                summary: c.summary,
                detail: c.detail,
                userName: c.userName,
              })),
              documents: credit.documents.map((d) => ({
                id: d.id,
                docNumber: d.docNumber,
                docDate: d.docDate,
                dueDate: d.dueDate,
                daysOverdue: d.daysOverdue,
                outstanding: d.outstanding,
              })),
            }}
          />
        ) : active === 'loyalty' ? (
          loyalty ? (
            <LoyaltyTab
              customerId={customerId}
              enabled={loyalty.enabled}
              points={loyalty.member.points}
              pointsValue={loyalty.member.pointsValue}
              walletBalance={loyalty.member.walletBalance}
              tierName={loyalty.member.tier?.name ?? ''}
              tierColor={loyalty.member.tier?.color ?? ''}
              qualifyingSpend={loyalty.member.qualifyingSpend}
              nextTierName={loyalty.member.next?.tier.name ?? null}
              nextTierShortfall={loyalty.member.next?.shortfall ?? 0}
              ledger={loyalty.ledger}
              vouchers={loyalty.vouchers}
              cards={loyalty.cards}
              wallet={loyalty.wallet}
              canAdjust={can(capabilities, 'loyalty.adjust')}
            />
          ) : (
            <Card>
              <Callout tone="warning">
                Loyalty could not be loaded for this customer.
              </Callout>
            </Card>
          )
        ) : active === 'online' ? (
          <OnlineAccess
            customerId={customerId}
            customerEmail={customer.email ?? ''}
            login={onlineLogin}
          />
        ) : active === 'activity' ? (
          <Card>
            <ActivityTable
              rows={activity.map((event) => ({
                id: event.id,
                when: event.createdAt.toLocaleString('en-ZA'),
                whenSort: event.createdAt.getTime(),
                who: event.userName || 'Unknown user',
                action: event.action,
                detail: event.detail,
              }))}
            />
          </Card>
        ) : null}
      </PageBody>

      {active === 'transactions' && (
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
      )}
    </>
  )
}
