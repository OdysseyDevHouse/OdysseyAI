import type { Metadata } from 'next'
import { requireSection } from '../guard'
import { customerStatement } from '@/lib/site/customerAuth'
import { portalProfile } from '@/lib/site/portalData'
import { letterheadFor } from '../letterhead'
import PortalShell, { PortalNav } from '../PortalShell'
import SignOutButton from '../SignOutButton'
import LedgerTable from '../LedgerTable'
import PayAccountButton from '../PayAccountButton'
import { ButtonLink, Card, Icons, LinkTabs, Pagination, StatStrip, StatTile } from '@/components/ui'
import { pageCountFor } from '@/lib/searchParams'
import { formatMoney } from '@/lib/decimals'
import { documentHref } from '../documents'

export const dynamic = 'force-dynamic'

/** Matches the back office's list default, so both paginate the same way. */
const PAGE_SIZE = 25

export const metadata: Metadata = {
  title: 'Statement',
  robots: { index: false, follow: false },
}

/**
 * What the customer owes, document by document, with a way to settle it.
 *
 * ── OPEN ITEMS FIRST, EVERYTHING BEHIND A TAB ──────────────────────────────
 *
 * The question this page answers is "what do I still owe you", so it opens on
 * the lines that are still open. The full history is one click away and is also
 * the Transactions tab — kept here as well because somebody who came looking
 * for a statement should not have to know we file the two separately.
 *
 * ── TWO PAY BUTTONS, AT TWO DIFFERENT SCOPES ───────────────────────────────
 *
 * The row buttons are the Invoices tab's, settling one document each. The one
 * in the header settles the ACCOUNT — the balance, across every open item —
 * which is what somebody looking at eleven overdue invoices actually wants,
 * and what doing it row by row would charge eleven gateway fees for.
 *
 * Both mint an intent and hand off to /pay; neither is a second payment path.
 * The difference is the intent's purpose, and everything downstream of that
 * already existed — see paidLinks.settleAccountPayment.
 */
export default async function PortalStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ all?: string; page?: string }>
}) {
  const { token } = await params
  const { all, page: pageRaw } = await searchParams
  const ctx = await requireSection(token, 'statement')

  const showAll = all === '1'

  const [lines, profile, head] = await Promise.all([
    customerStatement(ctx.siteId, ctx.customerId, { openOnly: !showAll, limit: 500 }),
    portalProfile(ctx.siteId, ctx.customerId),
    letterheadFor(ctx.siteId),
  ])

  const balance = profile?.balance ?? 0
  const owing = lines.filter((line) => line.amountOutstanding > 0.005)
  const owed = owing.reduce((sum, line) => sum + line.amountOutstanding, 0)
  // Local midnight, matching LedgerTable: a customer reads "overdue" against
  // their own calendar rather than UTC.
  const today = new Date().toLocaleDateString('en-CA')
  const overdue = owing.filter((line) => line.dueDate && line.dueDate < today)
  const overdueTotal = overdue.reduce((sum, line) => sum + line.amountOutstanding, 0)
  /* Whether a separate Overdue tile would repeat the Still-owing figure. */
  const allOwedIsOverdue = owed > 0.005 && Math.abs(overdueTotal - owed) < 0.005

  const allRows = lines.map((line) => ({
    transactionId: line.transactionId,
    docType: line.docType,
    docNumber: line.docNumber,
    docDate: line.docDate,
    dueDate: line.dueDate,
    amountSigned: line.amountSigned,
    amountOutstanding: line.amountOutstanding,
    runningBalance: line.runningBalance,
    href: documentHref(token, line),
    sourceDocId: line.sourceDocId,
  }))

  const pageCount = pageCountFor(allRows.length, PAGE_SIZE)
  const page = Math.min(Math.max(Number(pageRaw) || 1, 1), Math.max(pageCount, 1))
  const rows = allRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  /* The filter lives in the URL, so paging has to carry it — and changing the
     filter has to drop the page, or "Everything" would open on page 3 of a
     list it has never shown. */
  const hrefFor = (next: number) => {
    const qs = new URLSearchParams()
    if (showAll) qs.set('all', '1')
    if (next > 1) qs.set('page', String(next))
    const q = qs.toString()
    return `/portal/${token}/statement${q ? `?${q}` : ''}`
  }

  return (
    <PortalShell
      name={head.name ?? undefined}
      hasLogo={head.hasLogo}
      token={token}
      onSignOut={<SignOutButton token={token} />}
      nav={<PortalNav token={token} active="statement" settings={ctx.settings} />}
      title="Statement"
      subtitle="What is owed on your account, document by document."
      /* The one action on this screen. Secondary, not primary — the primary
         act here is paying, and those buttons live on the rows. */
      /*
       * ── THE ACCOUNT-LEVEL PAY BUTTON LIVES HERE ─────────────────────────
       *
       * The row buttons settle ONE invoice each; this settles the account. On
       * a statement with eleven open items "pay the lot" is the action most
       * people came for, and doing it row by row is eleven card payments and
       * eleven gateway fees against one debt.
       *
       * It is the primary action and the PDF is now secondary — downloading a
       * statement is what you do when you cannot settle it here.
       */
      action={
        <div className="flex items-center gap-2">
          <ButtonLink href={`/portal/${token}/statement/pdf`} variant="secondary">
            <Icons.Download size={15} />
            Download PDF
          </ButtonLink>
          {ctx.settings.allowPay && <PayAccountButton token={token} balance={balance} />}
        </div>
      }
      card={false}
    >
      {/*
       * ── THE OVERDUE TILE ONLY APPEARS WHEN IT SAYS SOMETHING NEW ─────────
       *
       * On an account where every open invoice is past due — the common case
       * for anyone who opens this page — "Still owing" and "Overdue" print the
       * identical figure, and a third tile repeating the second in red is the
       * danger token spent on nothing. It is shown only when the two differ,
       * and then it is the loudest thing on the screen, which is what that
       * colour is for.
       *
       * When they are equal the "Still owing" tile takes the tone instead, so
       * the fact is stated once, in the right colour, in one place.
       */}
      <StatStrip columns={allOwedIsOverdue ? 2 : 3}>
        <StatTile
          label="Balance"
          value={formatMoney(Math.abs(balance))}
          hint={balance < -0.005 ? 'In credit' : balance > 0.005 ? 'On your account' : 'Settled'}
          tone={balance < -0.005 ? 'success' : 'default'}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="Still owing"
          value={formatMoney(owed)}
          tone={allOwedIsOverdue && owed > 0.005 ? 'danger' : 'default'}
          hint={
            allOwedIsOverdue && owed > 0.005
              ? `All ${owing.length} past the due date`
              : `${owing.length} open ${owing.length === 1 ? 'item' : 'items'}`
          }
          icon={<Icons.Receipt size={16} />}
        />
        {!allOwedIsOverdue && (
          <StatTile
            label="Overdue"
            value={formatMoney(overdueTotal)}
            tone={overdueTotal > 0.005 ? 'danger' : 'default'}
            hint={overdueTotal > 0.005 ? 'Past the due date' : 'Nothing past due'}
            icon={<Icons.Clock size={16} />}
          />
        )}
      </StatStrip>

      <Card>
        {/* Filters one list into slices, so it is a tab bar rather than the
            record-section Tabs — and href-driven, because the filter lives in
            the URL and this page is server-rendered. */}
        <LinkTabs
          className="px-4 pt-1"
          aria-label="Which lines to show"
          value={showAll ? 'all' : 'open'}
          items={[
            {
              value: 'open',
              label: 'Still owing',
              href: `/portal/${token}/statement`,
              count: owing.length,
            },
            { value: 'all', label: 'Everything', href: `/portal/${token}/statement?all=1` },
          ]}
        />
        <LedgerTable
          rows={rows}
          token={token}
          allowPay={ctx.settings.allowPay}
          emptyTitle={showAll ? 'Nothing on the account yet' : 'Nothing owing'}
          emptyHint={
            showAll
              ? 'Invoices and payments will show up here.'
              : 'Every invoice on your account is settled.'
          }
        />
        <Pagination
          page={page}
          pageCount={pageCount}
          total={allRows.length}
          pageSize={PAGE_SIZE}
          hrefFor={hrefFor}
        />
      </Card>
    </PortalShell>
  )
}
