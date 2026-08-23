import { requireModuleCapability } from '@/lib/auth'
import { listJobStatuses, missingRoles } from '@/lib/site/jobStatuses'
import { listJobBoards, statusesOffEveryBoard, boardStatusIds } from '@/lib/site/jobBoards'
import { listSlaPolicies, untargetedJobCount } from '@/lib/site/jobSla'
import { listHeadlines } from '@/lib/site/jobHeadlines'
import { listAssetTypes } from '@/lib/site/jobAssets'
import { listJobTeams } from '@/lib/site/jobTeams'
import { listUsers } from '@/lib/site/users'
import { customerOptions } from '@/lib/site/customers'
import { createPortalToken } from '@/lib/publicPortalToken'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody, Callout, TextLink } from '@/components/ui'
import { ROLE_LABEL } from '@/lib/jobStatusModel'
import WorkflowClient from './WorkflowClient'
import SlaPanel from './SlaPanel'
import HeadlinesPanel from './HeadlinesPanel'
import AssetTypesPanel from './AssetTypesPanel'
import TeamsPanel from './TeamsPanel'
import NotificationsPanel from './NotificationsPanel'
import { isConfigured } from '@/lib/mail'

export const dynamic = 'force-dynamic'

/**
 * How this business runs a job.
 *
 * ── WHY THIS LIVES UNDER /setup AND NOT UNDER /jobs ────────────────────────
 *
 * The Jobs section is what somebody works in all day; this is set once and
 * revisited rarely. nav.ts has the argument in full: naming every setting in the
 * sidebar is what made Online Store a flat list of fourteen rows that answered
 * nothing. So the route stays in the setup hub, is named in SUBPAGE_LABELS, and
 * the breadcrumb reads Setup > Job workflow.
 *
 * ── THE TWO WARNINGS THIS SCREEN OWES THE USER ─────────────────────────────
 *
 * A required role with no holder breaks part of the lifecycle silently — a job
 * cannot be closed if nothing means completed. And a status on no board hides its
 * jobs from every board. Neither is repairable automatically without guessing,
 * so both are reported here with the counts that make them actionable.
 */
export default async function JobWorkflowPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [
    statuses,
    boards,
    missing,
    offBoard,
    policies,
    settings,
    untargeted,
    headlines,
    assetTypes,
    teams,
    siteUsers,
    portalToken,
    slaCustomers,
  ] = await Promise.all([
    listJobStatuses(siteId, true),
    listJobBoards(siteId, true),
    missingRoles(siteId),
    statusesOffEveryBoard(siteId),
    listSlaPolicies(siteId, true),
    getSettings(siteId, [
      'job_sla_trading_days',
      'job_sla_opens_at',
      'job_sla_closes_at',
      'job_sla_skip_holidays',
      // The eleven that had no screen until now.
      'job_items_block_close',
      'job_headline_required',
      'job_signature_statement',
      'job_notify_enabled',
      'job_notify_assignee',
      'job_notify_events',
      'job_auto_escalate',
      'job_auto_visit_reminder',
      'job_auto_visit_hours',
      'job_auto_invoice',
      // Feedback (§ rating). Both read here so the panel can show the wording.
      'job_feedback_enabled',
      'job_feedback_intro',
      // Public intake (§4.2).
      'job_intake_enabled',
      'job_intake_blurb',
      'job_intake_max_per_phone',
      'job_intake_show_headlines',
      // The portal (§4.3).
      'portal_enabled',
      'portal_allow_comments',
      'portal_allow_uploads',
      'portal_allow_quote_accept',
      'job_stock_warn_mode',
      'job_auto_awaiting_parts',
    ]),
    /*
     * Tolerant: a nicety on a setup screen. A site mid-migration must still be
     * able to configure its statuses.
     */
    untargetedJobCount(siteId).catch(() => 0),
    // Tolerant: a site without migration 114 still gets its statuses and boards.
    listHeadlines(siteId, true).catch(() => []),
    // Likewise 115.
    listAssetTypes(siteId, true).catch(() => []),
    // Likewise 126.
    listJobTeams(siteId, true).catch(() => []),
    listUsers(siteId).catch(() => []),
    // The portal sign-in link (§4.3). Deterministic, so what somebody put on
    // their website keeps working; null if SESSION_SECRET is missing.
    createPortalToken(siteId).catch(() => null),
    // Customers who can be given a promise of their own (164). See
    // customerOptions for why it is not the paged list helper.
    customerOptions(siteId).catch(() => []),
  ])

  const portalUrl = portalToken ? `${process.env.APP_URL ?? ''}/portal/${portalToken}` : null

  // Which statuses each board draws, so the editor opens with them ticked.
  const columnsByBoard: Record<number, number[]> = {}
  await Promise.all(
    boards.map(async (board) => {
      columnsByBoard[board.id] = await boardStatusIds(siteId, board.id)
    }),
  )

  const stranded = offBoard.filter((s) => s.jobCount > 0)

  /*
   * Who a crew or an escalation can name (164).
   *
   * Back-office and active only: an escalation goes to somebody who can act on
   * it, and a POS-only account has no bell to read it in. Derived once here
   * because both panels want the same list, and two copies of the filter is how
   * they come to disagree.
   */
  const backOfficeUsers = siteUsers
    .filter((u) => u.isActive && u.userType === 'back_office')
    .map((u) => ({ id: u.id, name: u.name }))

  return (
    <>
      <PageHeader
        title="Job workflow"
        subtitle="The stages a job moves through, and the boards that show them."
      />
      <PageBody>
        {missing.length > 0 && (
          <Callout tone="danger" title="Part of the lifecycle has nowhere to go">
            Nothing means: {missing.map((role) => ROLE_LABEL[role].toLowerCase()).join(', ')}. Until
            a status carries each of those, the actions that look for them will refuse.
          </Callout>
        )}

        {stranded.length > 0 && (
          <Callout tone="warning" title="Some jobs are on no board">
            {stranded.map((s) => `${s.jobCount} in ${s.name}`).join(', ')}. Add those statuses to a
            board below, or find the jobs in the{' '}
            <TextLink href="/jobs?state=all">job list</TextLink>.
          </Callout>
        )}

        <WorkflowClient
          statuses={statuses}
          boards={boards}
          columnsByBoard={columnsByBoard}
          offBoardIds={offBoard.map((s) => s.statusId)}
        />

        {/* What KIND of work this business does, above the promises: a headline
            decides a job's priority and board, so it reads before the things that
            measure it. */}
        <HeadlinesPanel
          headlines={headlines}
          boards={boards.filter((b) => b.isActive).map((b) => ({ id: b.id, name: b.name }))}
        />

        {/* Kinds of EQUIPMENT, after kinds of WORK: both are what a business does,
            and a service interval is the thing that turns equipment into work. */}
        <AssetTypesPanel types={assetTypes} />

        {/* WHO does it, after WHAT gets done. A crew is a shortcut into the
            people picker on a job, so it reads after the work it will be put on. */}
        <TeamsPanel
          teams={teams}
          users={backOfficeUsers}
        />

        {/* The promises, on the same screen as the stages rather than a route of
            their own: both answer "how does this business run a job", and four
            settings plus four rows do not earn a sidebar entry. */}
        <SlaPanel
          policies={policies}
          customers={slaCustomers}
          users={backOfficeUsers}
          tradingDays={settings.job_sla_trading_days}
          opensAt={settings.job_sla_opens_at}
          closesAt={settings.job_sla_closes_at}
          skipHolidays={settings.job_sla_skip_holidays === '1'}
          untargetedCount={untargeted}
        />

        {/* Last, because it is the only panel that is purely behaviour: the four
            above define what a job IS, this one what it DOES on its own. */}
        <NotificationsPanel
          itemsBlockClose={settings.job_items_block_close !== '0'}
          headlineRequired={settings.job_headline_required === '1'}
          signatureStatement={settings.job_signature_statement}
          notifyEnabled={settings.job_notify_enabled !== '0'}
          notifyAssignee={settings.job_notify_assignee !== '0'}
          notifyEvents={settings.job_notify_events.split(',').map((e) => e.trim()).filter(Boolean)}
          autoEscalate={settings.job_auto_escalate === '1'}
          autoVisitReminder={settings.job_auto_visit_reminder === '1'}
          autoVisitHours={Number(settings.job_auto_visit_hours) || 16}
          autoInvoice={settings.job_auto_invoice === '1'}
          feedbackEnabled={settings.job_feedback_enabled === '1'}
          feedbackIntro={settings.job_feedback_intro}
          intakeEnabled={settings.job_intake_enabled === '1'}
          intakeBlurb={settings.job_intake_blurb}
          intakeMaxPerPhone={Number(settings.job_intake_max_per_phone) || 0}
          intakeShowHeadlines={settings.job_intake_show_headlines === '1'}
          portalEnabled={settings.portal_enabled === '1'}
          portalAllowComments={settings.portal_allow_comments === '1'}
          portalAllowUploads={settings.portal_allow_uploads === '1'}
          portalAllowQuoteAccept={settings.portal_allow_quote_accept === '1'}
          stockWarnMode={settings.job_stock_warn_mode ?? 'inform'}
          autoAwaitingParts={settings.job_auto_awaiting_parts !== '0'}
          portalUrl={portalUrl}
          /*
           * Both read on the SERVER. isConfigured() reads process.env, which a
           * client component cannot see — and a panel that cannot tell whether
           * mail works would let somebody switch on notifications and believe
           * they were covered.
           */
          mailConfigured={isConfigured()}
          cronConfigured={Boolean(process.env.JOB_AUTOMATION_CRON_SECRET)}
        />
      </PageBody>
    </>
  )
}
