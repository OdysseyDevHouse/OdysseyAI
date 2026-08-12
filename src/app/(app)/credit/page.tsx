import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listPositionsPage, creditSummary, listPromises, listRuns } from '@/lib/site/creditControl'
import { RISK_LABELS } from '@/lib/creditModel'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatStrip,
  StatTile,
  EmptyState,
  Callout,
  LinkSegmentedControl,
  TableToolbar,
  Pagination,
  ButtonLink,
  Icons,
} from '@/components/ui'
import { BuildRunButton } from './BuildRunButton'
import { PositionsTable, type PositionRow } from './PositionsTable'

export const dynamic = 'force-dynamic'

/**
 * Collections — the screen someone opens every morning.
 *
 * ── WHAT IT LEADS WITH ───────────────────────────────────────────────────
 *
 * Not "how much is owed" — the age analysis already answers that, and a total
 * is not a task. This leads with what a person should DO today: whose promise
 * lands now, which promises broke while nobody was looking, and how many
 * accounts are actually chaseable once promises, pauses and disputes are taken
 * out.
 *
 * The gap between "overdue accounts" and "chaseable" is the useful number. An
 * ageing report saying 60 accounts are overdue when 44 of them have live
 * promises is a report that produces 44 unnecessary phone calls.
 */
const PAGE_SIZE = 50

export default async function CreditPage({
  searchParams,
}: {
  searchParams: Promise<{ risk?: string; page?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.view')
  const params = await searchParams
  const page = pageFrom(params.page)

  const risk =
    params.risk === 'bad' || params.risk === 'poor' || params.risk === 'watch'
      ? params.risk
      : undefined

  const [summary, { items: positions, total }, promises, runs] = await Promise.all([
    creditSummary(siteId),
    // One page, not the whole book. A real debtors book is thousands of rows,
    // and pushing all of them into the client table is what broke this screen.
    listPositionsPage(siteId, {
      risk,
      limit: PAGE_SIZE,
      offset: offsetFor(page, PAGE_SIZE),
    }),
    listPromises(siteId, { status: 'open' }),
    listRuns(siteId, 5),
  ])

  const now = today()
  const href = hrefBuilder('/credit', params)
  const draft = runs.find((r) => r.status === 'draft')

  // Flattened before it crosses the boundary — see PositionsTable for why.
  const shown: PositionRow[] = positions.map((p) => ({
    customerId: p.customerId,
    code: p.code,
    name: p.name,
    overdueAmount: p.overdueAmount,
    oldestDays: p.oldestDays,
    dunningLevel: p.dunningLevel,
    lastDunnedAt: p.lastDunnedAt,
    pausedUntil: p.pausedUntil,
    hasOpenPromise: p.hasOpenPromise,
    openPromiseDate: p.openPromiseDate,
    isHeld: p.heldAt !== null,
    risk: p.risk,
    riskReason: p.riskReason,
  }))
  const brokenPromises = promises.filter((p) => p.state === 'broken')
  const dueToday = promises.filter((p) => p.state === 'due-today')

  return (
    <>
      <PageHeader
        title="Collections"
        icon={<Icons.HandCoins size={18} />}
        subtitle={`${summary.chaseable} account${summary.chaseable === 1 ? '' : 's'} worth chasing today`}
        action={<BuildRunButton hasDraft={draft !== undefined} draftId={draft?.id ?? null} />}
      />

      <PageBody>
        {/* Broken promises come first. They are the one thing here that has
            already gone wrong and that nothing else in the app will mention. */}
        {brokenPromises.length > 0 && (
          <Callout tone="danger" title={`${brokenPromises.length} broken promise${brokenPromises.length === 1 ? '' : 's'}`}>
            {brokenPromises
              .slice(0, 3)
              .map((p) => `${p.customerName} — ${formatMoney(p.promisedAmount)} due ${p.promisedDate}`)
              .join(' · ')}
            {brokenPromises.length > 3 && ` · and ${brokenPromises.length - 3} more`}
            {'. '}
            <Link href="/credit/promises" className="underline hover:text-danger-ink">
              Review promises
            </Link>
          </Callout>
        )}

        {dueToday.length > 0 && (
          <Callout tone="warning" title={`${dueToday.length} promise${dueToday.length === 1 ? '' : 's'} due now`}>
            {dueToday
              .slice(0, 3)
              .map((p) => `${p.customerName} — ${formatMoney(p.promisedAmount)}`)
              .join(' · ')}
            . Worth checking the bank before chasing.
          </Callout>
        )}

        {draft && (
          <Callout tone="brand" title="A run is waiting to be reviewed">
            {draft.totalCount} account{draft.totalCount === 1 ? '' : 's'} were assessed on{' '}
            {draft.asAt}. Nothing has been sent.{' '}
            <Link href={`/credit/runs/${draft.id}`} className="underline hover:text-brand-ink">
              Review it
            </Link>
          </Callout>
        )}

        {/* StatStrip rather than a hand-rolled grid, so this strip keeps the
            same gutters and breakpoints as every other one in the app. */}
        <StatStrip columns={4}>
          <StatTile
            label="Overdue"
            value={formatMoney(summary.overdueTotal)}
            tone={summary.overdueTotal > 0 ? 'warning' : 'default'}
            hint={`across ${summary.overdueAccounts} account${summary.overdueAccounts === 1 ? '' : 's'}`}
            icon={<Icons.Coins size={20} />}
          />
          {/* The number that turns a report into a morning's work. */}
          <StatTile
            label="Worth chasing"
            value={String(summary.chaseable)}
            hint={
              summary.overdueAccounts === summary.chaseable
                ? 'nothing is on hold or promised'
                : `${summary.overdueAccounts - summary.chaseable} promised, paused or held`
            }
            icon={<Icons.Phone size={20} />}
          />
          <StatTile
            label="Promised to us"
            value={formatMoney(summary.promisedTotal)}
            tone={summary.promisesBroken > 0 ? 'danger' : 'default'}
            hint={
              summary.promisesBroken > 0
                ? `${summary.promisesBroken} already broken`
                : `${summary.promisesDueThisWeek} due this week`
            }
            icon={<Icons.Wallet size={20} />}
          />
          <StatTile
            label="Oldest debt"
            value={summary.worstDays === 0 ? '—' : `${summary.worstDays} days`}
            tone={summary.worstDays >= 90 ? 'danger' : summary.worstDays >= 60 ? 'warning' : 'default'}
            hint={summary.onHold > 0 ? `${summary.onHold} account on hold` : 'nothing on hold'}
            icon={<Icons.Clock size={20} />}
          />
        </StatStrip>

        <Card>
          <CardHeader
            title="Overdue accounts"
            description="Sorted by what is owed. The status column says why an account will not be chased."
            action={
              <ButtonLink href="/credit/levels" variant="ghost" size="sm">
                Reminder levels
              </ButtonLink>
            }
          />

          {/* A segmented control, not LinkTabs: these slice ONE list by risk
              band, which is what the segmented bar means — tabs promise
              different sections of a record. The counts move into the count
              pills, which is what they are for.

              The glyphs escalate rather than pass/fail: risk here is a scale,
              so Bad takes the hard stop, Poor the warning, and Watch the clock
              — an account that is only being kept an eye on.

              Every segment drops back to page one: staying on page 7 while
              switching to a band with two accounts shows an empty table. */}
          <TableToolbar inCard>
            <LinkSegmentedControl
              value={risk ?? 'all'}
              aria-label="Risk band"
              options={[
                {
                  value: 'all',
                  label: 'All',
                  count: summary.overdueAccounts || undefined,
                  icon: <Icons.LayoutGrid size={15} />,
                  href: href({ risk: null, page: null }),
                },
                {
                  value: 'bad',
                  label: 'Bad',
                  count: summary.byRisk.bad.count || undefined,
                  icon: <Icons.Ban size={15} />,
                  href: href({ risk: 'bad', page: null }),
                },
                {
                  value: 'poor',
                  label: 'Poor',
                  count: summary.byRisk.poor.count || undefined,
                  icon: <Icons.StatusWarning size={15} />,
                  href: href({ risk: 'poor', page: null }),
                },
                {
                  value: 'watch',
                  label: 'Watch',
                  count: summary.byRisk.watch.count || undefined,
                  icon: <Icons.Clock size={15} />,
                  href: href({ risk: 'watch', page: null }),
                },
              ]}
            />
          </TableToolbar>

          {shown.length === 0 ? (
            <CardBody>
              <EmptyState
                title={risk ? `Nothing in the ${RISK_LABELS[risk]} band` : 'Nothing is overdue'}
                hint={
                  risk
                    ? 'Try another band, or view all overdue accounts.'
                    : 'Every account is within its terms. There is nothing to chase.'
                }
              />
            </CardBody>
          ) : (
            <>
              <PositionsTable rows={shown} today={now} />
              <Pagination
                page={page}
                pageCount={pageCountFor(total, PAGE_SIZE)}
                total={total}
                pageSize={PAGE_SIZE}
                hrefFor={(p) => href({ page: p === 1 ? null : String(p) })}
              />
            </>
          )}
        </Card>
      </PageBody>
    </>
  )
}
