import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { getJobCard } from '@/lib/site/jobCards'
import { listJobStatuses } from '@/lib/site/jobStatuses'
import { billableLines } from '@/lib/site/jobInvoicing'
import { listActivity } from '@/lib/site/activityLog'
import { listAttachments } from '@/lib/site/attachments'
import { jobQuotes, quoteVariance } from '@/lib/site/jobQuotes'
import { jobAppointments } from '@/lib/site/jobAppointments'
import { jobTime } from '@/lib/site/jobTime'
import { jobTravel } from '@/lib/site/jobTravel'
import { jobParts, vanHoldings } from '@/lib/site/jobParts'
import { jobStanding, tradingHours } from '@/lib/site/jobSla'
import { getServiceAddress, formatAddress, mapsHref } from '@/lib/site/serviceAddresses'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Callout,
  Badge,
  Card,
  CardHeader,
  CardBody,
  LinkTabs,
  TextLink,
  Icons,
} from '@/components/ui'
import { AttachmentsPanel } from '@/components/attachments/AttachmentsPanel'
import { getSetting } from '@/lib/site/settings'
import { storedMillis } from '@/lib/jobStatusModel'
import JobDetail from './JobDetail'
import JobVisits from './JobVisits'
import JobPartsPanel from './JobPartsPanel'
import JobSlaCard from './JobSlaCard'

export const dynamic = 'force-dynamic'

/**
 * The tabs, as a closed union.
 *
 * Four, not the PRD's eight. Three of its proposals are not tabs at all —
 * Customer is a link to the customer, Assets belong to the customer rather than
 * the job, and a Visit is a screen of its own because a technician on site opens
 * the visit. Time folded into Costs, because labour time IS a cost line and two
 * tabs showing two halves of one figure is how they come to disagree.
 */
type Tab = 'overview' | 'visits' | 'costs' | 'quotes' | 'files' | 'history'

const TABS: readonly Tab[] = ['overview', 'visits', 'costs', 'quotes', 'files', 'history']

function toTab(value: string | undefined): Tab {
  return TABS.includes(value as Tab) ? (value as Tab) : 'overview'
}

/**
 * One job card.
 *
 * ── ONE PAGE, NOT EIGHT TABS ───────────────────────────────────────────────
 *
 * The PRD proposes eight tabs. This ships one scrolling page, deliberately: tabs
 * are the answer to a page that is too long, and nobody has yet seen this page
 * with real data on it. Splitting first would be guessing at where the seams are,
 * and a tab per feature is how a screen ends up with six tabs holding one field
 * each.
 *
 * Three of the proposed tabs are also not tabs at all. Customer is a link to the
 * customer. Assets belong to the customer, not the job. A visit is a screen of
 * its own, because a technician on site opens the visit rather than the job.
 *
 * ── WHAT THE SERVER DECIDES, AND WHAT THE CLIENT DOES ──────────────────────
 *
 * Everything read happens here; every mutation is a server action. The client
 * component holds only what has to be interactive — the line editor and the
 * dialogs — and receives what it may do as props, because a hidden button is not
 * a boundary and the actions guard themselves again on the way in.
 */
export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const { siteId, capabilities } = await requireCapability('jobs.view')
  const { id } = await params
  const { tab: rawTab } = await searchParams

  const jobId = Number(id)
  if (!Number.isFinite(jobId) || jobId <= 0) notFound()

  const job = await getJobCard(siteId, jobId)
  if (!job) notFound()

  const tab = toTab(rawTab)

  /*
   * Cost and profit are behind their own capability, mirroring products.cost: a
   * technician who must see what was fitted should not thereby learn the margin.
   * The figures are not fetched-and-hidden, they are not fetched — a client
   * component receives what it is allowed to render and nothing more.
   */
  const showCost = can(capabilities, 'jobs.cost')

  const [
    statuses,
    billable,
    activity,
    address,
    attachments,
    quotes,
    variance,
    visits,
    defaultVisitMinutes,
    time,
    travel,
    travelRate,
    parts,
    holdings,
    standing,
    week,
  ] = await Promise.all([
      listJobStatuses(siteId, false),
      can(capabilities, 'jobs.invoice') ? billableLines(siteId, jobId) : Promise.resolve([]),
      listActivity(siteId, 'job_card', jobId, 60),
      job.serviceAddressId
        ? getServiceAddress(siteId, job.serviceAddressId)
        : Promise.resolve(null),
      listAttachments(siteId, 'job_card', jobId),
      jobQuotes(siteId, jobId),
      quoteVariance(siteId, jobId),
      jobAppointments(siteId, jobId),
      getSetting(siteId, 'job_default_visit_minutes'),
      jobTime(siteId, jobId),
      jobTravel(siteId, jobId),
      getSetting(siteId, 'job_travel_rate_per_km'),
      jobParts(siteId, jobId),
      vanHoldings(siteId),
      // Tolerant: a site without 113 must still be able to open a job card.
      jobStanding(siteId, jobId).catch(() => null),
      tradingHours(siteId).catch(() => null),
    ])

  const overdue = !job.isClosed && job.dueAt !== null && storedMillis(job.dueAt) < Date.now()

  return (
    <>
      <PageHeader
        title={job.documentNumber ?? `Job #${job.id}`}
        subtitle={job.title}
        action={
          <div className="flex items-center gap-2">
            <Badge tone={job.isClosed ? 'neutral' : 'brand'}>{job.isClosed ? 'Closed' : 'Open'}</Badge>
            <Badge
              tone={
                job.statusTone === 'brand'
                  ? 'brand'
                  : job.statusTone === 'success'
                    ? 'success'
                    : job.statusTone === 'warning'
                      ? 'warning'
                      : job.statusTone === 'danger'
                        ? 'danger'
                        : 'neutral'
              }
            >
              {job.statusName}
            </Badge>
          </div>
        }
      />
      <PageBody>
        {/* The warnings sit ABOVE the tab bar, not inside a tab: a cancelled job
            or an undecided cost is true of the whole record, and hiding it behind
            a tab means somebody works a job for ten minutes before finding out. */}
        {job.status === 'cancelled' && (
          <Callout tone="danger" title="This job was cancelled">
            {job.cancelReason ?? 'No reason was recorded.'}
          </Callout>
        )}
        {overdue && (
          <Callout tone="warning" title="Past its due date">
            This job was due {job.dueAt?.slice(0, 16).replace('T', ' ')} and is still open.
          </Callout>
        )}
        {job.totals.pendingCount > 0 && showCost && (
          <Callout tone="warning" title="Costs with nobody assigned to pay for them">
            {job.totals.pendingCount === 1 ? 'One line is' : `${job.totals.pendingCount} lines are`}{' '}
            awaiting a billing decision, worth {formatMoney(job.totals.pending)} in cost. The job
            cannot be closed until each one is decided.{' '}
            <TextLink href={`/jobs/${job.id}?tab=costs`}>Decide now</TextLink>.
          </Callout>
        )}

        <LinkTabs
          items={[
            { value: 'overview', label: 'Overview', icon: <Icons.Wrench size={15} />, href: `/jobs/${job.id}` },
            {
              value: 'visits',
              label: 'Visits',
              icon: <Icons.CalendarClock size={15} />,
              count: visits.length || undefined,
              href: `/jobs/${job.id}?tab=visits`,
            },
            {
              value: 'costs',
              label: 'Costs',
              icon: <Icons.Coins size={15} />,
              count: job.lines.length || undefined,
              href: `/jobs/${job.id}?tab=costs`,
            },
            {
              value: 'quotes',
              label: 'Quotes',
              icon: <Icons.FileText size={15} />,
              count: quotes.length || undefined,
              href: `/jobs/${job.id}?tab=quotes`,
            },
            {
              value: 'files',
              label: 'Files',
              icon: <Icons.Paperclip size={15} />,
              count: attachments.length || undefined,
              href: `/jobs/${job.id}?tab=files`,
            },
            {
              value: 'history',
              label: 'History',
              icon: <Icons.Clock size={15} />,
              href: `/jobs/${job.id}?tab=history`,
            },
          ]}
          value={tab}
          aria-label="Job card sections"
        />

        {/* Above the address: what was promised outranks where to drive, and a
            technician opening a breached job should see that first. */}
        {tab === 'overview' && standing !== null && week !== null && (
          <JobSlaCard
            jobId={job.id}
            standing={standing}
            hoursPerDay={(week.closesAt - week.opensAt) / 60}
            canRespond={can(capabilities, 'jobs.edit') && !job.isClosed}
          />
        )}

        {tab === 'overview' && address && (
          <Card>
            <CardHeader
              title="Where the work happens"
              description={address.name}
              action={
                mapsHref(address) ? (
                  <TextLink href={mapsHref(address)!} target="_blank" rel="noreferrer">
                    Open in maps
                  </TextLink>
                ) : undefined
              }
            />
            <CardBody>
              <div className="flex flex-col gap-1 text-sm">
                {formatAddress(address) && <span className="text-ink-2">{formatAddress(address)}</span>}
                {address.contactName && (
                  <span className="text-muted">
                    Ask for {address.contactName}
                    {address.contactPhone ? ` · ${address.contactPhone}` : ''}
                  </span>
                )}
                {address.accessNotes && (
                  /* The most useful sentence on the screen to somebody standing
                     outside a locked gate at 7am, so it is not buried in a note. */
                  <span className="mt-1 text-warning-ink">{address.accessNotes}</span>
                )}
              </div>
            </CardBody>
          </Card>
        )}

        {tab === 'visits' ? (
          <JobVisits
            jobId={job.id}
            jobClosed={job.isClosed}
            defaultAddressId={job.serviceAddressId}
            defaultAddressName={job.serviceAddressName}
            defaultMinutes={Number(defaultVisitMinutes) || 60}
            visits={visits}
            time={time}
            travel={travel}
            travelRate={Number(travelRate) || 0}
            canAssign={can(capabilities, 'jobs.assign')}
            canEdit={can(capabilities, 'jobs.edit')}
            canCost={showCost}
            canDecide={can(capabilities, 'jobs.bill_decide')}
          />
        ) : tab === 'files' ? (
          /* The whole Files tab. `job_card` is one object in ATTACHMENT_TARGETS,
             and the upload path, the download route and the permission derivation
             all came with it — which is exactly what the loose (entity, entity_id)
             design in party_documents was built for. */
          <AttachmentsPanel
            entity="job_card"
            entityId={job.id}
            canEdit={can(capabilities, 'jobs.edit') && !job.isClosed}
            hint="Photographs of the fault, the signed-off worksheet, a supplier receipt for a part bought on the way."
            attachments={attachments.map((file) => ({
              id: file.id,
              filename: file.filename,
              description: file.description,
              sizeBytes: file.sizeBytes,
              uploadedName: file.uploadedName,
              // A Date does not survive the boundary.
              createdAt: String(file.createdAt),
            }))}
          />
        ) : (
          <>
            {/* Moving goods is a different act from pricing them, with a different
                permission, so it is its own card rather than buttons inside the
                line editor — one mis-click apart is too close. */}
            {tab === 'costs' && (
              <JobPartsPanel
                jobId={job.id}
                jobClosed={job.isClosed}
                parts={parts}
                vanHoldings={holdings}
                canIssue={can(capabilities, 'stock.transfer')}
              />
            )}
            <JobDetail
              job={job}
              tab={tab}
              statuses={statuses}
              billable={billable}
              activity={activity}
              quotes={quotes}
              variance={variance}
              can={{
                edit: can(capabilities, 'jobs.edit'),
                assign: can(capabilities, 'jobs.assign'),
                close: can(capabilities, 'jobs.close'),
                invoice: can(capabilities, 'jobs.invoice'),
                decide: can(capabilities, 'jobs.bill_decide'),
                cost: showCost,
              }}
            />
          </>
        )}
      </PageBody>
    </>
  )
}
