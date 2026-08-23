import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
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
import { jobItems, jobHeadlineIds, listHeadlines } from '@/lib/site/jobHeadlines'
import { jobAssetFor, otherJobAssets } from '@/lib/site/jobAssets'
import { requestsForJob } from '@/lib/site/jobPartRequests'
import { serialsForLine } from '@/lib/site/jobSerials'
import { jobSeriesFor } from '@/lib/site/jobSeries'
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
import { getSetting, SETTING_DEFAULTS } from '@/lib/site/settings'
import { peopleFor } from '@/lib/site/jobPeople'
import { depositSummary } from '@/lib/site/jobDeposits'
import { listJobTeams } from '@/lib/site/jobTeams'
import { valuesFor } from '@/lib/site/customFields'
import { listAccounts } from '@/lib/site/bankAccounts'
import { listUsers } from '@/lib/site/users'
import { storedMillis } from '@/lib/jobStatusModel'
import JobDetail from './JobDetail'
import JobVisits from './JobVisits'
import JobPartsPanel from './JobPartsPanel'
import JobPartRequests from './JobPartRequests'
import JobSerialsPanel from './JobSerialsPanel'
import JobSlaCard from './JobSlaCard'
import JobChecks from './JobChecks'
import JobSignoffCard from './JobSignoffCard'
import JobPeoplePanel from './JobPeoplePanel'
import CustomFieldsPanel from '@/components/CustomFieldsPanel'
import { setCustomValuesAction } from '../actions'
import JobFeedbackCard from './JobFeedbackCard'
import { feedbackFor } from '@/lib/site/jobFeedback'
import { jobSignoff, signoffRule } from '@/lib/site/jobSignoff'
import { supplierOptions } from '@/lib/site/suppliers'
import { listCategories } from '@/lib/site/expenseCategories'
import JobDepositsPanel from './JobDepositsPanel'
import JobAssetCard from './JobAssetCard'

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
type Tab = 'overview' | 'checks' | 'visits' | 'costs' | 'quotes' | 'files' | 'history'

const TABS: readonly Tab[] = [
  'overview',
  'checks',
  'visits',
  'costs',
  'quotes',
  'files',
  'history',
]

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
 * customer. A visit is a screen of its own, because a technician on site opens the
 * visit rather than the job. And ASSETS is a card plus a link: a job names ONE
 * piece of equipment, so the job needs a picker and a warranty line, while the
 * unit's own history belongs on the unit at /jobs/equipment/[id] — putting it here
 * would mean every job card carried a list of visits it was not part of.
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
  const { siteId, actor, capabilities } = await requireModuleCapability('job_cards', 'jobs.view')
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
   *
   * Since the §26.6 split these are FOUR questions, not one. Cost, selling price
   * and profit were previously all gated by `jobs.cost`, which meant a shop that
   * wanted a technician to see what the customer is paying had to show them the
   * margin as well. A counter assistant reading a price off a job to answer the
   * phone is the ordinary case, and it should not require handing over the
   * buying price of every part.
   *
   * `showMoney` is the union: whether the costs tab is worth rendering at all.
   */
  const showCost = can(capabilities, 'jobs.cost')
  const showPrice = can(capabilities, 'jobs.price')
  const showMargin = can(capabilities, 'jobs.margin')
  const showProfit = can(capabilities, 'jobs.profit')
  const showMoney = showCost || showPrice || showMargin || showProfit

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
    items,
    headlines,
    jobHeadlines,
    jobAsset,
    fromSeries,
    signatureStatement,
    people,
    siteUsers,
    notifyEnabled,
    deposits,
    bankAccounts,
    teams,
    customValues,
    feedback,
    signoff,
    signoffRequired,
    expenseSuppliers,
    expenseCategories,
    otherAssets,
    partRequests,
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
      // All three tolerant: a site without migration 114 must still open a job.
      jobItems(siteId, jobId).catch(() => []),
      listHeadlines(siteId, false).catch(() => []),
      jobHeadlineIds(siteId, jobId).catch(() => []),
      // Tolerant: a site without migration 115 must still open a job card.
      jobAssetFor(siteId, jobId).catch(() => null),
      // Likewise 118.
      jobSeriesFor(siteId, jobId).catch(() => null),
      // Likewise 119. A site without it shows the pad with the default wording
      // rather than refusing to open the job.
      getSetting(siteId, 'job_signature_statement').catch(() => null),
      // And 120. peopleFor is itself tolerant; the settings read is guarded here.
      peopleFor(siteId, jobId),
      listUsers(siteId).catch(() => []),
      getSetting(siteId, 'job_notify_enabled').catch(() => '1'),
      /*
       * Deposits (§33). Both tolerant: a site without the ledger, or a reader
       * without the cashbook, gets an empty panel rather than a broken job card.
       *
       * The ORDER of this array is the order of the destructuring above — an
       * earlier version of this edit put these two in the middle and read them
       * off the end, which silently swapped the deposits for the people.
       */
      depositSummary(siteId, jobId),
      can(capabilities, 'cashbook.view') || can(capabilities, 'cashbook.edit')
        ? listAccounts(siteId).catch(() => [])
        : Promise.resolve([]),
      // Crews (§16). Tolerant of a site without 126 — an empty list simply
      // hides the picker.
      listJobTeams(siteId, false),
      // Custom fields (§24). Tolerant of a site without 127, and the panel
      // renders nothing at all when the business has defined none.
      valuesFor(siteId, 'job', jobId),
      // Feedback (§ rating). Tolerant of a site without 128; null when the
      // customer was never asked, which is the ordinary case.
      feedbackFor(siteId, jobId),
      // Sign-off (159). Both tolerant of a site without it: jobSignoff returns
      // two nulls and signoffRule returns 'none', so the card renders as
      // unsigned-and-not-required rather than the job refusing to open.
      jobSignoff(siteId, jobId),
      signoffRule(siteId),
      /*
       * Who an expense was paid to, and what bucket it lands in (160).
       *
       * Both are only offered to somebody who may see costs — an expense line IS
       * a cost, and a technician who cannot see the money has no use for a
       * supplier picker. Both tolerant: a site without 042's categories, or
       * without 160, gets an empty picker rather than a job card that will not
       * open.
       */
      /*
       * The CODE is part of the label, not decoration.
       *
       * This site has four active suppliers all called "Adams Cash & Carry" and
       * six called "Adams Trading" — real rows with different codes and
       * different balances. A picker showing bare names offers four identical
       * options and no way to tell which is which, and the wrong one is a
       * subcontractor spend report pointing at the wrong account.
       */
      /*
       * Every ACTIVE supplier — see supplierOptions for why it is not
       * listSuppliers, and why the code is part of the label.
       *
       * Retired suppliers are excluded on their own merits: one must not be
       * offered for money spent today. An expense already pointing at one keeps
       * pointing at it — the id is stored, and the name is joined on read.
       */
      can(capabilities, 'jobs.cost')
        ? supplierOptions(siteId).catch(() => [])
        : Promise.resolve([]),
      can(capabilities, 'jobs.cost')
        ? listCategories(siteId)
            .then((r) => r.map((c) => ({ id: c.id, name: `${c.accountCode} — ${c.name}` })))
            .catch(() => [])
        : Promise.resolve([]),
      // The other units on this visit (161). Appended at the END, like every
      // addition before it — this array's order IS the destructuring order, and
      // an earlier edit that inserted in the middle silently swapped the
      // deposits for the people.
      //
      // Tolerant: a site without the join table shows the primary alone rather
      // than failing to open the job.
      otherJobAssets(siteId, jobId).catch(() => []),
      // Parts this job is waiting on (162). Also appended at the END, and also
      // tolerant — a site without the table shows no card rather than failing.
      requestsForJob(siteId, jobId).catch(() => []),
    ])

  /*
   * Which units are already named on each serial-tracked line (§31).
   *
   * A SECOND round trip, after the block above, because it cannot be part of it:
   * which lines are serial-tracked is not known until `parts` has resolved, and
   * a query for every line on every job would read a table that is empty for the
   * vast majority of them.
   *
   * A shop with no serial-tracked parts does no work here at all — the filter is
   * empty, so nothing is asked.
   */
  const serialLines = parts.filter((p) => p.isSerial && p.productId !== null)
  const serialsByLine = new Map<number, string[]>()
  if (serialLines.length > 0) {
    const allocations = await Promise.all(
      serialLines.map((p) => serialsForLine(siteId, p.lineId)),
    )
    serialLines.forEach((p, i) => {
      serialsByLine.set(
        p.lineId,
        allocations[i]!.map((a) => a.serial),
      )
    })
  }

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
        {/* Where the job came from, above the tabs: it is true of the whole
            record, and it answers "who asked for this" before anybody wonders. */}
        {fromSeries !== null && (
          <Callout tone="neutral" title="Raised by a schedule">
            <TextLink href="/jobs/recurring">{fromSeries.name}</TextLink> —{' '}
            {fromSeries.frequencyLabel.toLowerCase()}
            {fromSeries.forDate ? `, due ${fromSeries.forDate}` : ''}. Nothing from the previous
            occurrence carries over: this job started empty apart from its checks.
          </Callout>
        )}

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
              value: 'checks',
              label: 'Checks',
              icon: <Icons.Check size={15} />,
              // Outstanding REQUIRED items, not the total: the count on a tab is
              // there to pull somebody towards work they have to do, and "12" on a
              // finished checklist pulls them towards nothing.
              count: items.filter((i) => i.isRequired && i.completedAt === null).length || undefined,
              href: `/jobs/${job.id}?tab=checks`,
            },
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

        {/* What the visit is about, above where it happens: a technician wants to
            know which unit before they know which gate. */}
        {tab === 'overview' && (
          <JobAssetCard
            jobId={job.id}
            customerId={job.customerId}
            asset={jobAsset}
            others={otherAssets}
            canEdit={can(capabilities, 'jobs.edit')}
            jobClosed={job.isClosed}
          />
        )}

        {/* Above the roster and below the equipment, and only once somebody has
            been asked. A rating is about work already finished, so it reads as
            the outcome of the job rather than part of running it — but a poor
            one is the most important thing on the screen, which is why it is not
            buried at the bottom. */}
        {tab === 'overview' && feedback !== null && (
          <JobFeedbackCard
            jobId={job.id}
            feedback={feedback}
            canEdit={can(capabilities, 'jobs.view')}
          />
        )}

        {/* Who, after what — a technician reading down the page wants the job and
            the equipment before the roster. */}
        {tab === 'overview' && (
          <JobPeoplePanel
            jobId={job.id}
            jobClosed={job.isClosed}
            ownerName={job.ownerName}
            ownerUserId={job.ownerUserId}
            people={people}
            users={siteUsers
              .filter((u) => u.isActive && u.userType === 'back_office')
              .map((u) => ({ id: u.id, name: u.name }))}
            currentUserId={actor.userId}
            canAssign={can(capabilities, 'jobs.assign')}
            notifyOff={notifyEnabled === '0'}
            teams={teams.map((t) => ({
              id: t.id,
              name: t.name,
              memberCount: t.members.length,
            }))}
          />
        )}

        {/* Whatever this business records that the app does not ask for. After
            the people and before the address: it is detail about the job, and a
            technician wants the roster and the location first. Renders nothing
            when no job fields are defined. */}
        {tab === 'overview' && (
          <CustomFieldsPanel
            entity="job"
            entityId={job.id}
            fields={customValues}
            canEdit={can(capabilities, 'jobs.edit') && !job.isClosed}
            onSave={setCustomValuesAction}
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

        {tab === 'checks' ? (
          <div className="space-y-4">
            <JobSignoffCard
              jobId={job.id}
              jobClosed={job.isClosed}
              canEdit={can(capabilities, 'jobs.edit')}
              signoff={signoff}
              rule={signoffRequired}
              signatureStatement={
                signatureStatement?.trim() || SETTING_DEFAULTS.job_signature_statement
              }
            />
            <JobChecks
              jobId={job.id}
              jobClosed={job.isClosed}
              items={items}
              headlines={headlines.map((h) => ({
                id: h.id,
                name: h.name,
                itemCount: h.items.length,
              }))}
              selectedHeadlineIds={jobHeadlines}
              canEdit={can(capabilities, 'jobs.edit')}
              // getSetting already falls back to the registered default; this covers
              // only the catch above, where the settings row could not be read at all.
              signatureStatement={
                signatureStatement?.trim() || SETTING_DEFAULTS.job_signature_statement
              }
            />
          </div>
        ) : tab === 'visits' ? (
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
            {/* Between the parts panel and the request queue, because that is
                the order the questions arrive in: how many, which ones, and
                what is missing. Renders nothing at all when no line on the job
                is serial-tracked. */}
            {tab === 'costs' && serialLines.length > 0 && (
              <JobSerialsPanel
                jobId={job.id}
                jobClosed={job.isClosed}
                canEdit={can(capabilities, 'jobs.edit')}
                lines={serialLines.map((p) => ({
                  lineId: p.lineId,
                  productId: p.productId as number,
                  description: p.description,
                  qty: p.qty,
                  serials: serialsByLine.get(p.lineId) ?? [],
                }))}
              />
            )}
            {/* Directly under the parts panel (162), because the two are one
                thought: what this job needs, and what is not on the shelf. The
                refusal that sends somebody here comes from the card above. */}
            {tab === 'costs' && (
              <JobPartRequests
                jobId={job.id}
                jobClosed={job.isClosed}
                requests={partRequests}
                canEdit={can(capabilities, 'jobs.edit')}
              />
            )}
            {/* On the Quotes tab, because a deposit is part of the money
                conversation with the customer — it belongs beside what was
                quoted, not beside what the job cost us. */}
            {tab === 'quotes' && (
              <JobDepositsPanel
                jobId={job.id}
                jobClosed={job.isClosed}
                summary={deposits}
                accounts={bankAccounts
                  .filter((a) => a.status !== 'closed')
                  .map((a) => ({ id: a.id, name: a.name }))}
                canTake={can(capabilities, 'jobs.edit') && can(capabilities, 'cashbook.edit')}
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
              suppliers={expenseSuppliers}
              expenseCategories={expenseCategories}
              can={{
                edit: can(capabilities, 'jobs.edit'),
                assign: can(capabilities, 'jobs.assign'),
                close: can(capabilities, 'jobs.close'),
                invoice: can(capabilities, 'jobs.invoice'),
                invoiceSelect: can(capabilities, 'jobs.invoice_select'),
                quoteAmend: can(capabilities, 'jobs.quote_amend'),
                decide: can(capabilities, 'jobs.bill_decide'),
                cost: showCost,
                costEdit: can(capabilities, 'jobs.cost_edit'),
                price: showPrice,
                priceEdit: can(capabilities, 'jobs.price_edit'),
                discount: can(capabilities, 'jobs.discount'),
                margin: showMargin,
                profit: showProfit,
                money: showMoney,
              }}
            />
          </>
        )}
      </PageBody>
    </>
  )
}
