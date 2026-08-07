import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listPositions, creditSummary, listPromises, listRuns } from '@/lib/site/creditControl'
import { RISK_LABELS } from '@/lib/creditModel'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Badge,
  Callout,
  LinkTabs,
  DataTable,
  ButtonLink,
  type Column,
} from '@/components/ui'
import { BuildRunButton } from './BuildRunButton'

export const dynamic = 'force-dynamic'

type Position = Awaited<ReturnType<typeof listPositions>>[number]

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
export default async function CreditPage({
  searchParams,
}: {
  searchParams: Promise<{ risk?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.view')
  const params = await searchParams

  const risk =
    params.risk === 'bad' || params.risk === 'poor' || params.risk === 'watch'
      ? params.risk
      : undefined

  const [summary, positions, promises, runs] = await Promise.all([
    creditSummary(siteId),
    listPositions(siteId, { onlyOverdue: true }),
    listPromises(siteId, { status: 'open' }),
    listRuns(siteId, 5),
  ])

  const now = today()
  const shown = risk ? positions.filter((p) => p.risk === risk) : positions
  const draft = runs.find((r) => r.status === 'draft')
  const brokenPromises = promises.filter((p) => p.state === 'broken')
  const dueToday = promises.filter((p) => p.state === 'due-today')

  const columns: Column<Position>[] = [
    {
      key: 'account',
      header: 'Account',
      cell: (p) => (
        <Link href={`/customers/${p.customerId}`} className="block hover:text-brand">
          <span className="text-ink">{p.name}</span>
          <span className="mt-0.5 block text-xs text-muted">{p.code}</span>
        </Link>
      ),
      sortValue: (p) => p.name,
    },
    {
      key: 'risk',
      header: 'Risk',
      cell: (p) => (
        <>
          <Badge
            tone={
              p.risk === 'bad'
                ? 'danger'
                : p.risk === 'poor'
                  ? 'warning'
                  : p.risk === 'watch'
                    ? 'brand'
                    : 'default'
            }
          >
            {RISK_LABELS[p.risk]}
          </Badge>
          {/* The band always carries the fact that caused it — a collector
              reads "3 promises broken", never an opaque score. */}
          <span className="mt-0.5 block text-xs text-muted">{p.riskReason}</span>
        </>
      ),
      sortValue: (p) => ['good', 'watch', 'poor', 'bad'].indexOf(p.risk),
    },
    {
      key: 'overdue',
      header: 'Overdue',
      numeric: true,
      cell: (p) => <span className="text-ink">{formatMoney(p.overdueAmount)}</span>,
      sortValue: (p) => p.overdueAmount,
    },
    {
      key: 'age',
      header: 'Oldest',
      numeric: true,
      cell: (p) => (
        <span className={p.oldestDays >= 60 ? 'text-danger' : 'text-ink-2'}>
          {p.oldestDays} days
        </span>
      ),
      sortValue: (p) => p.oldestDays,
    },
    {
      key: 'level',
      header: 'Chased',
      cell: (p) =>
        p.dunningLevel === 0 ? (
          <span className="text-faint">Never</span>
        ) : (
          <>
            <span className="text-ink-2">Level {p.dunningLevel}</span>
            {p.lastDunnedAt && (
              <span className="mt-0.5 block text-xs text-muted">{p.lastDunnedAt}</span>
            )}
          </>
        ),
      sortValue: (p) => p.dunningLevel,
    },
    {
      key: 'state',
      header: 'Status',
      // Why an account will NOT be chased, stated on the row. Without it the
      // list looks like 60 accounts nobody is bothering to phone.
      cell: (p) =>
        p.heldAt ? (
          <Badge tone="danger">On hold</Badge>
        ) : p.hasOpenPromise ? (
          <Badge tone="success">Promised {p.openPromiseDate}</Badge>
        ) : p.pausedUntil && p.pausedUntil >= now ? (
          <Badge tone="default">Paused</Badge>
        ) : (
          <span className="text-faint">—</span>
        ),
      sortValue: (p) => (p.heldAt ? 3 : p.hasOpenPromise ? 2 : p.pausedUntil ? 1 : 0),
    },
  ]

  return (
    <>
      <PageHeader
        title="Collections"
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

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Overdue"
            value={formatMoney(summary.overdueTotal)}
            tone={summary.overdueTotal > 0 ? 'warning' : 'default'}
            hint={`across ${summary.overdueAccounts} account${summary.overdueAccounts === 1 ? '' : 's'}`}
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
          />
          <StatTile
            label="Oldest debt"
            value={summary.worstDays === 0 ? '—' : `${summary.worstDays} days`}
            tone={summary.worstDays >= 90 ? 'danger' : summary.worstDays >= 60 ? 'warning' : 'default'}
            hint={summary.onHold > 0 ? `${summary.onHold} account on hold` : 'nothing on hold'}
          />
        </div>

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

          <LinkTabs
            items={[
              { value: 'all', label: `All (${positions.length})`, href: '/credit' },
              {
                value: 'bad',
                label: `Bad (${summary.byRisk.bad.count})`,
                href: '/credit?risk=bad',
              },
              {
                value: 'poor',
                label: `Poor (${summary.byRisk.poor.count})`,
                href: '/credit?risk=poor',
              },
              {
                value: 'watch',
                label: `Watch (${summary.byRisk.watch.count})`,
                href: '/credit?risk=watch',
              },
            ]}
            value={risk ?? 'all'}
            aria-label="Risk band"
          />

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
            <DataTable
              columns={columns}
              rows={shown}
              getRowKey={(p) => p.customerId}
              empty={{ title: 'No accounts', hint: 'Nothing in this filter.' }}
            />
          )}
        </Card>
      </PageBody>
    </>
  )
}
