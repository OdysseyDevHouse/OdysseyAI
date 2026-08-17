import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { slaCounts, slaWorklist, tradingHours, untargetedJobCount } from '@/lib/site/jobSla'
import { parseClock } from '@/lib/jobStatusModel'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  StatStrip,
  StatTile,
  LinkTabs,
  Callout,
  TextLink,
  EmptyState,
  Icons,
} from '@/components/ui'
import { travelNeedingVerification } from '@/lib/site/jobTravel'
import SlaWorklist from './SlaWorklist'
import TravelToCheck from './TravelToCheck'

export const dynamic = 'force-dynamic'

/**
 * Who is waiting, and what is about to be late.
 *
 * ── TWO LISTS, NOT ONE ─────────────────────────────────────────────────────
 *
 * Response and resolution are different questions asked by different people. A
 * dispatcher asks who has not been picked up yet and works the list down; a
 * manager asks what will miss its fix date and reassigns. One combined list
 * sorted by "urgency" serves neither, because a job answered promptly and still
 * three days from its fix date is not the same problem as one nobody has read.
 *
 * So: two tabs over one query shape, each with its own ORDER BY, each filtered in
 * SQL. A shop with 4,000 open jobs must not ship all of them to render twenty.
 *
 * ── WHY THERE IS NO "BREACHED" TAB ─────────────────────────────────────────
 *
 * Breach is derived from the deadline, so a breached job is already at the top of
 * the list it belongs to — soonest deadline first puts the most overdue first for
 * free. A third tab would be the same rows filtered, and a row that appears in
 * two tabs is a row somebody works twice.
 */
/*
 * A THIRD tab for travel, which is not an SLA at all.
 *
 * It is here because the question is the same shape: work sitting still until
 * somebody senior looks at it. travelNeedingVerification() and its dedicated index
 * ix_jtravel_verify were built in phase 6 and had NO reader — a claim of 88km
 * against a 42km estimate sat in the database with no screen showing it, so the
 * approval workflow was half-built. A third tab here beats a fourth nav row for a
 * list that is usually empty.
 */
type Tab = 'respond' | 'resolve' | 'travel'

const TABS: readonly Tab[] = ['respond', 'resolve', 'travel']

function toTab(value: string | undefined): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'respond'
}

export default async function SlaPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { siteId, capabilities } = await requireModuleCapability('job_cards', 'jobs.view')
  const { tab: rawTab } = await searchParams
  const tab = toTab(rawTab)

  const [rows, counts, week, untargeted, travel] = await Promise.all([
    // The travel tab has no SLA rows, so the worklist query is skipped entirely
    // rather than run and discarded.
    tab === 'travel' ? Promise.resolve([]) : slaWorklist(siteId, tab, 100),
    slaCounts(siteId),
    tradingHours(siteId),
    untargetedJobCount(siteId),
    travelNeedingVerification(siteId, 100).catch(() => []),
  ])

  const hoursPerDay = (week.closesAt - week.opensAt) / 60

  return (
    <>
      <PageHeader
        title="Service targets"
        subtitle="What was promised, and whether it is being kept."
      />
      <PageBody>
        {/* A tile earns a tone only when there is something to act on — the
            convention the job list already sets. A permanently green "0 overdue"
            trains the eye to skip the row that matters. */}
        <StatStrip>
          <StatTile
            label="Waiting for a first reply"
            value={String(counts.awaitingResponse)}
            href="/jobs/sla"
          />
          <StatTile
            label="Response overdue"
            value={String(counts.responseBreached)}
            tone={counts.responseBreached > 0 ? 'danger' : 'default'}
            href="/jobs/sla"
          />
          <StatTile
            label="Fix date passed"
            value={String(counts.resolveBreached)}
            tone={counts.resolveBreached > 0 ? 'danger' : 'default'}
            href="/jobs/sla?tab=resolve"
          />
          <StatTile
            label="Due to be fixed today"
            value={String(counts.dueToday)}
            tone={counts.dueToday > 0 ? 'warning' : 'default'}
            href="/jobs/sla?tab=resolve"
          />
        </StatStrip>

        {/* Above the tabs: true of the whole screen, and the reason a number here
            might look lower than somebody expects. */}
        {/* Only on the two SLA tabs: the travel list has nothing to do with
            targets, so the caveat would be answering a question nobody asked. */}
        {untargeted > 0 && tab !== 'travel' && (
          <Callout tone="neutral" title="Some open jobs are not measured">
            {untargeted === 1 ? 'One open job carries' : `${untargeted} open jobs carry`} no target,
            because they were logged before the promises were set up — nothing was promised for them,
            so they are absent from the list below.{' '}
            <TextLink href="/setup/job-workflow">Review the targets</TextLink>.
          </Callout>
        )}

        <LinkTabs
          items={[
            {
              value: 'respond',
              label: 'Waiting for a reply',
              icon: <Icons.Clock size={15} />,
              count: counts.awaitingResponse || undefined,
              href: '/jobs/sla',
            },
            {
              value: 'resolve',
              label: 'Fix dates',
              icon: <Icons.CalendarClock size={15} />,
              href: '/jobs/sla?tab=resolve',
            },
            {
              value: 'travel',
              label: 'Travel to check',
              icon: <Icons.Truck size={15} />,
              count: travel.length || undefined,
              href: '/jobs/sla?tab=travel',
            },
          ]}
          value={tab}
          aria-label="Service target lists"
        />

        {tab === 'travel' ? (
          travel.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Icons.Check size={22} />}
                title="No travel claim needs checking"
                hint="A trip only appears here when the distance claimed is further past the estimate than the tolerance allows. Everything else is accepted as recorded."
              />
            </Card>
          ) : (
            <Card>
              <CardHeader
                title="Claimed further than expected"
                description="The estimate is straight-line distance times a road factor, not a measured route — so a claim over it is a question, not an accusation. Verifying records what was accepted; nobody has looked at these yet."
              />
              <TravelToCheck
                rows={travel.map((t) => ({
                  travelId: t.id,
                  jobId: t.jobCardId,
                  userName: t.userName,
                  travelledOn: t.travelledOn,
                  fromLabel: t.fromLabel,
                  toLabel: t.toLabel,
                  expectedKm: t.expectedKm,
                  recordedKm: t.recordedKm,
                  isReturn: t.isReturn,
                  chargeableKm: t.chargeableKm,
                }))}
                canVerify={can(capabilities, 'jobs.bill_decide')}
              />
            </Card>
          )
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Icons.Check size={22} />}
              title={
                tab === 'respond'
                  ? 'Every job has been picked up'
                  : 'No open job carries a fix date'
              }
              hint={
                tab === 'respond'
                  ? 'Nothing is waiting for a first reply. New jobs will appear here the moment they are logged.'
                  : 'Either every open job has been resolved, or the priorities in use promise no fix date. Both are normal.'
              }
            />
          </Card>
        ) : (
          <Card>
            <CardHeader
              title={tab === 'respond' ? 'Nobody has replied yet' : 'Open, with a fix date'}
              description={
                tab === 'respond'
                  ? 'Soonest deadline first, so the most overdue is at the top. Business hours only — a job logged before closing is not late by morning.'
                  : 'Soonest fix date first. Closing the job is what stops this clock.'
              }
            />
            <SlaWorklist
              rows={rows}
              kind={tab}
              hoursPerDay={hoursPerDay}
              canRespond={can(capabilities, 'jobs.edit')}
            />
          </Card>
        )}
      </PageBody>
    </>
  )
}
